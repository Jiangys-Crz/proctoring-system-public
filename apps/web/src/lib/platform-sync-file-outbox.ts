import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';
import { digest, FederationError } from './exam-federation-protocol';
import { bankFileResponse, type BankPayload } from './platform-sync-bank';
import { platformTransaction } from './platform-sync-lock';
import { getPlatformSyncSettings, peerConnection, platformOrigin, type PlatformSyncSettings } from './platform-sync-settings';
import { platformRequest, type PlatformItem } from './platform-sync-protocol';
import { wireItem } from './platform-sync-store';

const prefix = 'bank-push:';
type FileTask = { itemId: string; hash: string; revision: number; writer: string; nextAttemptAt: number; leaseUntil: number; token: string | null; failures: number; lastError?: string };
const taskValue = (item: PlatformItem): FileTask => ({ itemId: item.id, hash: item.hash, revision: item.revision, writer: item.writer, nextAttemptAt: 0, leaseUntil: 0, token: null, failures: 0 });
const hasFiles = (item: PlatformItem) => { const payload = item.payload as unknown as BankPayload; return Boolean(payload.data?.length || payload.files?.length); };

/** Persist before advancing the metadata cursor. File failures cannot hold up unrelated records. */
export async function queueBankFilePushes(entries: PlatformItem[], settings: PlatformSyncSettings) {
  if (settings.role !== 'LOCAL') return;
  const pending = entries.filter(item => item.kind === 'BANK' && !item.deleted && item.writer === settings.nodeId && hasFiles(item));
  if (!pending.length) return;
  await platformTransaction(async tx => {
    for (const item of pending) {
      const key = `${prefix}${digest(item.id)}`;
      const row = await tx.systemSetting.findUnique({ where: { key } });
      const prior = row?.value as FileTask | undefined;
      if (prior?.hash === item.hash && prior.revision === item.revision && prior.writer === item.writer) continue;
      const value = taskValue(item);
      await tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
  });
}

const preparedSchema = z.object({ skip: z.boolean(), missing: z.array(z.object({ area: z.enum(['data', 'files']), name: z.string().min(1).max(1024) })).max(100000) });
async function pushBankFiles(item: PlatformItem, settings: PlatformSyncSettings, peerId: string) {
  const peer = peerConnection(settings);
  const prepared = await platformRequest(peer.baseUrl, peer.apiKey, '/api/platform-sync/file', { action: 'prepare', item, peerId }, preparedSchema);
  if (prepared.skip) return true; // The public journal has committed this version (or a newer one).
  const payload = item.payload as unknown as BankPayload;
  const deadline = Date.now() + 20_000;
  let count = 0, bytes = 0;
  // Amortize a metadata round trip/timer tick across small test files. Keep
  // transfers sequential, bounded in time/bytes, and shorter than the task lease.
  for (const missing of prepared.missing.slice(0, 16)) {
    const file = payload[missing.area].find(row => row.name === missing.name);
    if (!file) throw new FederationError('远端请求的文件不属于当前题目版本');
    if (count && (Date.now() >= deadline || bytes + file.size > 32 * 1024 * 1024)) break;
    const fresh = await getPlatformSyncSettings();
    if (!fresh.enabled || fresh.role !== 'LOCAL' || fresh.revision !== settings.revision) throw new FederationError('同步配置已改变，等待重新读取后补传');
    const source = await bankFileResponse(item.id, missing.area, file.name, item.hash);
    if (!source.ok || !source.body) { await source.body?.cancel(); throw new FederationError('本机题目文件暂不可用'); }
    try {
      const query = new URLSearchParams({ itemId: item.id, hash: item.hash, area: missing.area, name: file.name });
      const sent = await fetch(`${platformOrigin(peer.baseUrl)}/api/platform-sync/file?${query}`, { method: 'PUT',
        headers: { authorization: `Bearer ${peer.apiKey}`, 'content-type': 'application/octet-stream' }, body: source.body,
        duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(300_000) } as RequestInit);
      await sent.body?.cancel();
      if (!sent.ok) throw new FederationError('题目文件补传失败，将自动重试');
      count++; bytes += file.size;
    } finally { await source.body.cancel().catch(() => {}); }
  }
  return false; // Retain the task until the public journal confirms the version.
}

/** Independent transport worker: no exam/global metadata lease is held during large uploads. */
export async function runBankFilePushes() {
  const settings = await getPlatformSyncSettings();
  if (!settings.enabled || settings.role !== 'LOCAL') return;
  const bound = await prisma.systemSetting.findUnique({ where: { key: 'platform-peer' } });
  const peerId = (bound?.value as { nodeId?: string } | undefined)?.nodeId;
  if (!peerId) return;
  const now = Date.now();
  const due = await prisma.$queryRaw<Array<{ key: string }>>`SELECT \`key\` FROM SystemSetting
    WHERE \`key\` LIKE 'bank-push:%' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(value, '$.nextAttemptAt')) AS UNSIGNED) <= ${now}
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(value, '$.leaseUntil')) AS UNSIGNED) <= ${now} ORDER BY updatedAt ASC LIMIT 1`;
  if (!due.length) return;
  const key = due[0].key;
  const claimed = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${key} FOR UPDATE`;
    const row = await tx.systemSetting.findUnique({ where: { key } });
    const value = row?.value as FileTask | undefined;
    if (!value || value.nextAttemptAt > Date.now() || value.leaseUntil > Date.now()) return null;
    const claim = { ...value, token: randomUUID(), leaseUntil: Date.now() + 15 * 60_000 };
    await tx.systemSetting.update({ where: { key }, data: { value: claim } }); return claim;
  }, { isolationLevel: 'ReadCommitted', maxWait: 3000, timeout: 10000 });
  if (!claimed) return;
  let remove = false, next: FileTask = claimed;
  try {
    const row = await prisma.platformSyncItem.findUnique({ where: { id: claimed.itemId } });
    if (!row || row.kind !== 'BANK' || row.scope !== 'bank' || row.deleted || row.writer !== settings.nodeId) remove = true;
    else {
      const item = wireItem(row);
      if (!hasFiles(item)) remove = true;
      else if (item.hash !== claimed.hash || item.revision !== claimed.revision || item.writer !== claimed.writer) next = taskValue(item);
      else {
        remove = await pushBankFiles(item, settings, peerId);
        next = { ...claimed, failures: 0, lastError: '', nextAttemptAt: Date.now() + 2000 };
      }
    }
  } catch (error) {
    next = { ...claimed, failures: Math.min(claimed.failures + 1, 30), nextAttemptAt: Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(claimed.failures, 5)),
      lastError: error instanceof FederationError ? error.message : '题目文件补传暂时失败，进度已保留' };
  }
  // A newer metadata capture may have replaced this task during the upload.
  const where = { key, value: { equals: claimed as Prisma.InputJsonValue } };
  if (remove) await prisma.systemSetting.deleteMany({ where });
  else await prisma.systemSetting.updateMany({ where, data: { value: { ...next, token: null, leaseUntil: 0 } } });
}
