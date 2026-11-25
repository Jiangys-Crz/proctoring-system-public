import { retireProblemIdentity } from './platform-sync-problem-history';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { prisma } from './db';
import { requestHydroBridge, requestHydroProblem, type HydroProblemPayload } from './hydro-contest';
import { getHydroSettings, HydroSettingsSchema, defaultHydroSettings } from './settings';
import { fetchHydroFile } from './hydro-file-url';
import { FederationError } from './exam-federation-protocol';
import { captureItem, captureDeletions, itemHash, wireItem, appendItem, retainPlatformConflict } from './platform-sync-store';
import { comparePlatformVersion, PlatformItemSchema, type PlatformItem } from './platform-sync-protocol';
import { peerConnection, platformOrigin, type PlatformSyncSettings } from './platform-sync-settings';
import { problemLimits } from './problem-limits';
import { problemFullScore } from './problem-score';
import { platformTransaction, assertPlatformLease } from './platform-sync-lock';
import { Prisma } from '@prisma/client';
import { recordBankFileProgress } from './platform-sync-bank-progress';

type BankFile = { name: string; size: number; sha256: string };
export type BankPayload = { title: string; content: string; html: boolean; config: unknown; tags: string[]; difficulty: number; hidden: boolean; data: BankFile[]; files: BankFile[] };
type BankDoc = BankPayload & { id: string; sourceId?: string; syncId?: string | null };
export function bankPayload(doc: BankDoc): BankPayload {
  const files = (list: BankFile[]) => (list || []).map(f => ({ name: f.name, size: f.size, sha256: f.sha256 })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { title: doc.title, content: doc.content, html: doc.html, config: doc.config, tags: doc.tags, difficulty: doc.difficulty, hidden: doc.hidden, data: files(doc.data), files: files(doc.files) };
}
export async function assertBankBinding(hydro: Awaited<ReturnType<typeof getHydroSettings>>) {
  await platformTransaction(async tx => {
    const connection = await tx.systemSetting.findUnique({ where: { key: 'hydro' } });
    const current = HydroSettingsSchema.parse(connection?.value || defaultHydroSettings);
    if (current.baseUrl !== hydro.baseUrl || current.problemDomainId !== hydro.problemDomainId) throw new FederationError('评测服务配置已更新，等待重新读取后重试', 503);
    const key = 'platform-bank-binding', value = { baseUrl: hydro.baseUrl, domain: hydro.problemDomainId };
    const old = await tx.systemSetting.findUnique({ where: { key } });
    if (old && ((old.value as { baseUrl: string }).baseUrl !== value.baseUrl || (old.value as { domain: string }).domain !== value.domain)) throw new FederationError('题库连接或域已更换，不能沿用原同步映射；请恢复原配置', 409);
    await tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: {} });
  });
}
export type PreparedBank = { id: string; sourceId: string; missing: Array<{ area: 'data' | 'files'; name: string }>; applied?: boolean };
async function releaseRetiredBankSlot(tx: Prisma.TransactionClient, domain: string, localId: string, bankId: string) {
  const occupied = await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope: 'bank', kind: 'BANK', localId } } });
  if (!occupied || occupied.id === bankId) return;
  if (!occupied.deleted) throw new FederationError('原题编号仍绑定另一有效题目，已停止覆盖');
  await retireProblemIdentity(tx, domain, localId.slice(domain.length + 1), occupied.id);
  await tx.platformSyncItem.update({ where: { id: occupied.id }, data: { localId: null } });
}
export async function prepareLocalBank(value: PlatformItem, old: { localId: string | null; appliedHash: string | null; deleted: boolean } | null) {
  const hydro = await getHydroSettings(); await assertBankBinding(hydro);
  if (old?.localId && !old.localId.startsWith(`${hydro.problemDomainId}:`)) throw new FederationError('题库域已更换，不能覆盖题目');
  const source = old?.localId ? await prisma.systemSetting.findUnique({ where: { key: `bank-source:${old.localId}` } }) : null;
  const prepared = await requestHydroBridge<PreparedBank>({ platformBaseUrl: hydro.baseUrl }, '/api/proctor/problem-bank', { action: 'prepare', syncId: value.id,
    id: old?.deleted ? undefined : old?.localId?.slice(hydro.problemDomainId.length + 1), sourceId: (source?.value as { sourceId?: string } | undefined)?.sourceId,
    hash: value.hash, revision: value.revision, writer: value.writer, value: value.payload, expectedHash: old && !old.deleted ? old.appliedHash : undefined });
  await recordBankFileProgress(value, prepared.missing.length);
  return prepared;
}
const catalogCheckpoint = 'platform-bank-catalog-capture:v1';
const catalogIntervalMs = 30_000;

export async function captureBank(settings: PlatformSyncSettings, scheduled = false) {
  const hydro = await getHydroSettings();
  const source = createHash('sha256').update(JSON.stringify([
    settings.nodeId, settings.revision, settings.role, hydro.baseUrl, hydro.problemDomainId, hydro.apiKey,
  ])).digest('hex');
  if (scheduled) {
    const row = await prisma.systemSetting.findUnique({ where: { key: catalogCheckpoint }, select: { value: true } });
    const checkpoint = row?.value as { source?: string; nextAttemptAt?: number } | undefined;
    if (checkpoint?.source === source && typeof checkpoint.nextAttemptAt === 'number' && checkpoint.nextAttemptAt > Date.now()) return false;
  }
  const saveCheckpoint = (tx: Prisma.TransactionClient) => {
    const value = { source, nextAttemptAt: Date.now() + catalogIntervalMs };
    return tx.systemSetting.upsert({ where: { key: catalogCheckpoint }, create: { key: catalogCheckpoint, value }, update: { value } });
  };
  // Reserve before contacting Hydro and retain the interval on failures. All
  // callers hold the platform lease, so other workers honor the same checkpoint.
  await platformTransaction(saveCheckpoint);
  await assertBankBinding(hydro);
  const known = new Set<string>();
  let after: number | null = 0;
  do {
    const page: { domain: string; items: BankDoc[]; after: number | null; errors?: Array<{id:string;sourceId?:string;message:string}>; pending?: Array<{id:string;sourceId:string;syncId:string;hash:string;applied:boolean;item?:PlatformItem}> } = await requestHydroBridge({ platformBaseUrl: hydro.baseUrl }, '/api/proctor/problem-bank', { action: 'catalog', after, limit: 20, tolerateErrors: true });
    if (page.domain !== hydro.problemDomainId) throw new FederationError('评测服务题库域与插件配置不一致，已停止题库同步', 409);
    let acknowledged = false;
    for (const pending of page.pending || []) if (pending.applied) {
      let item = await prisma.platformSyncItem.findUnique({ where: { id: pending.syncId } });
      if (item && pending.item && comparePlatformVersion(item, pending.item) > 0 && item.hash !== pending.hash) throw new FederationError('题库待确认版本与同步历史冲突，已保留恢复副本');
      // Hydro may have committed just before this process crashed, while the
      // durable inbox was already replaced by a newer snapshot. Recover that
      // exact remote version first; never invent a local revision for it.
      if (item?.hash !== pending.hash && pending.item) {
        const recovered = PlatformItemSchema.parse(pending.item);
        if (recovered.kind !== 'BANK' || recovered.scope !== 'bank' || recovered.id !== pending.syncId || recovered.deleted || recovered.hash !== itemHash(recovered.payload)) throw new FederationError('题库待确认版本无效');
        const localId = `${hydro.problemDomainId}:${pending.id}`;
        const problem = await requestHydroProblem({ platformBaseUrl: hydro.baseUrl }, pending.id);
        await platformTransaction(async tx => {
          const prior = await tx.platformSyncItem.findUnique({ where: { id: recovered.id } });
          if (prior && comparePlatformVersion(prior, recovered) > 0) throw new FederationError('题库待确认版本已落后，等待人工核对');
          if (prior && prior.hash !== recovered.hash && prior.writer !== recovered.writer) await retainPlatformConflict(tx, wireItem(prior));
          await releaseRetiredBankSlot(tx, hydro.problemDomainId, localId, recovered.id);
          await appendItem(tx, recovered, localId);
          await tx.examProblem.updateMany({ where: { hydroDomain: hydro.problemDomainId, hydroProblemId: pending.id, sourceDeleted: false, exam: { endAt: { gt: new Date() } } }, data: { title: problem.title, content: problem.content, html: problem.html, config: problem.config as Prisma.InputJsonValue, problemType: String(problem.config.type || 'default'), hydroScore: problemFullScore(problem) ?? 100, ...problemLimits(problem.config), files: recovered.payload.files as Prisma.InputJsonValue } });
          const key = `bank-source:${localId}`;
          await tx.systemSetting.upsert({ where: { key }, create: { key, value: { sourceId: pending.sourceId } }, update: { value: { sourceId: pending.sourceId } } });
        });
        item = await prisma.platformSyncItem.findUnique({ where: { id: pending.syncId } });
      }
      if (item?.hash === pending.hash && item.localId?.startsWith(`${hydro.problemDomainId}:`)) {
        const ack = await requestHydroBridge<{ acknowledged: boolean }>({ platformBaseUrl: hydro.baseUrl }, '/api/proctor/problem-bank', { action: 'ack', id: item.localId.slice(hydro.problemDomainId.length + 1), syncId: item.id, hash: pending.hash, revision: pending.item?.revision ?? item.revision, writer: pending.item?.writer ?? item.writer });
        if (!ack.acknowledged) throw new FederationError('题库传输身份发生变化，已保留待同步资料');
        acknowledged = true;
      }
    }
    // Refresh only this page after acknowledging its transfers. Restarting the
    // entire catalog recursively for each item retains payloads and rescans the bank.
    if (acknowledged) continue;
    const docs = page.items; for (const doc of docs) known.add(`${hydro.problemDomainId}:${doc.id}`);
    const failures = new Map((page.errors || []).map(error => [error.id, error.message]));
    const retiredTags = new Set((await prisma.platformSyncItem.findMany({ where: { id: { in: docs.flatMap(doc => doc.syncId ? [doc.syncId] : []) }, deleted: true }, select: { id: true } })).map(row => row.id));
    for (const doc of docs) if (doc.syncId && retiredTags.has(doc.syncId)) failures.set(doc.id, '原题仍携带已删除的同步标识，请核对 Hydro 题目恢复记录');
    for (const id of failures.keys()) {
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new FederationError('题库异常记录身份无效');
      known.add(`${hydro.problemDomainId}:${id}`);
    }
    if (page.after !== null && page.after <= after!) throw new FederationError('题库分页进度无效'); after = page.after;
    const parsedConfigs = new Map<string, { config: Record<string, unknown>; score: number }>();
    const mappings = await prisma.platformSyncItem.findMany({ where: { scope: 'bank', kind: 'BANK', localId: { in: docs.map(doc => `${hydro.problemDomainId}:${doc.id}`) } }, select: { localId: true, appliedHash: true } });
    const previousHashes = new Map(mappings.map(item => [item.localId, item.appliedHash]));
    const changed = docs.filter(doc => previousHashes.get(`${hydro.problemDomainId}:${doc.id}`) !== itemHash(bankPayload(doc)));
    const tracked = await prisma.examProblem.findMany({ where: { hydroDomain: hydro.problemDomainId, hydroProblemId: { in: changed.map(doc => doc.id) }, exam: { endAt: { gt: new Date() } } }, select: { hydroProblemId: true } });
    for (const id of new Set(tracked.map(p => p.hydroProblemId))) {
      try { const problem = await requestHydroProblem({ platformBaseUrl: hydro.baseUrl }, id); parsedConfigs.set(id, { config: problem.config, score: problemFullScore(problem) ?? 100 }); }
      catch { failures.set(id, '题目完整配置暂不可读取，已保留原题等待重试'); }
    }
    await prisma.$transaction(async tx => {
      await assertPlatformLease(tx);
      await tx.platformSyncState.upsert({ where: { id: 'peer' }, create: { id: 'peer' }, update: {} });
      await tx.$queryRaw`SELECT id FROM PlatformSyncState WHERE id = 'peer' FOR UPDATE`;
      for (const [id, error] of failures) {
        const key = `platform-bank-error:${hydro.problemDomainId}:${id}`, value = { domain: hydro.problemDomainId, id, error };
        await tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
        const sourceId = docs.find(doc => doc.id === id)?.sourceId || page.errors?.find(row => row.id === id)?.sourceId;
        if (sourceId) {
          const localId = `${hydro.problemDomainId}:${id}`;
          const before = await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope: 'bank', kind: 'BANK', localId } } });
          const source = await tx.systemSetting.findUnique({ where: { key: `bank-source:${localId}` } });
          const previousSource = (source?.value as { sourceId?: string } | undefined)?.sourceId;
          // Even an unreadable replacement must not leave historical exams
          // pointing at a different native document that reused the numeric ID.
          if (before && previousSource && previousSource !== sourceId) {
            await appendItem(tx, { ...wireItem(before), deleted: true, revision: before.revision + 1, writer: settings.nodeId }, null);
            await retireProblemIdentity(tx, hydro.problemDomainId, id, before.id);
          }
        }
      }
      for (const doc of docs) {
        if (failures.has(doc.id)) continue;
        await tx.systemSetting.deleteMany({ where: { key: `platform-bank-error:${hydro.problemDomainId}:${doc.id}` } });
        const localId = `${hydro.problemDomainId}:${doc.id}`, payload = bankPayload(doc) as unknown as Record<string, unknown>;
        let before = await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope: 'bank', kind: 'BANK', localId } } });
        const sourceKey = `bank-source:${localId}`;
        const source = await tx.systemSetting.findUnique({ where: { key: sourceKey } });
        const previousSource = (source?.value as Record<string, unknown> | undefined)?.sourceId;
        if (before && previousSource && doc.sourceId && previousSource !== doc.sourceId && doc.syncId === before.id) throw new FederationError('原题原生身份已改变但仍沿用旧同步标识，已停止覆盖；请核对 Hydro 题目恢复或复制记录');
        if (before && previousSource && doc.sourceId && previousSource !== doc.sourceId && doc.syncId !== before.id) {
          await appendItem(tx, { ...wireItem(before), deleted: true, revision: before.revision + 1, writer: settings.nodeId }, null);
          await retireProblemIdentity(tx, hydro.problemDomainId, doc.id, before.id);
          before = null;
        }
        await captureItem(tx, settings.nodeId, 'bank', 'BANK', localId, payload, doc.syncId || undefined);
        if (doc.sourceId) await tx.systemSetting.upsert({ where: { key: sourceKey }, create: { key: sourceKey, value: { sourceId: doc.sourceId } }, update: { value: { sourceId: doc.sourceId } } });
        if (!before || before.appliedHash !== itemHash(payload)) {
          let config: Record<string, unknown>;
          try { config = typeof doc.config === 'string' ? JSON.parse(doc.config) || {} : doc.config as Record<string, unknown>; }
          catch { config = {}; }
          config = parsedConfigs.get(doc.id)?.config || config;
          const limits = problemLimits(config);
          const publicConfig = { ...config }; delete publicConfig.answers;
          await tx.examProblem.updateMany({ where: { hydroDomain: hydro.problemDomainId, hydroProblemId: doc.id, sourceDeleted: false, exam: { endAt: { gt: new Date() } } },
            data: { title: doc.title, content: doc.content, html: doc.html, config: publicConfig as Prisma.InputJsonValue, problemType: String(config.type || 'default'), hydroScore: parsedConfigs.get(doc.id)?.score ?? problemFullScore({ config }) ?? 100, ...limits, files: doc.files as Prisma.InputJsonValue, sourceDeleted: false } });
        }
      }
      await assertPlatformLease(tx);
    }, { timeout: 60_000 });
  } while (after !== null);
  // Only a complete successful catalog authorizes deletion detection.
  await platformTransaction(async tx => {
    const failures = await tx.systemSetting.findMany({ where: { key: { startsWith: `platform-bank-error:${hydro.problemDomainId}:` } }, select: { key: true, value: true } });
    for (const failure of failures) if (!known.has(`${hydro.problemDomainId}:${(failure.value as {id:string}).id}`)) await tx.systemSetting.deleteMany({ where: { key: failure.key } });
    const missing = await tx.platformSyncItem.findMany({ where: { scope: 'bank', kind: 'BANK', localId: { startsWith: `${hydro.problemDomainId}:` } }, select: { localId: true } });
    for (const row of missing) if (row.localId && !known.has(row.localId)) await tx.examProblem.updateMany({ where: { hydroDomain: hydro.problemDomainId, hydroProblemId: row.localId.slice(hydro.problemDomainId.length + 1) }, data: { sourceDeleted: true } });
    await captureDeletions(tx, settings.nodeId, 'bank', 'BANK', known, `${hydro.problemDomainId}:`);
    await saveCheckpoint(tx);
  });
  return true;
}
export async function bankFileResponse(itemId: string, area: 'data' | 'files', name: string, hash: string) {
  const item = await prisma.platformSyncItem.findUnique({ where: { id: itemId } });
  const hydro = await getHydroSettings();
  if (!item || item.kind !== 'BANK' || item.deleted || item.hash !== hash || !item.localId?.startsWith(`${hydro.problemDomainId}:`)) throw new FederationError('题目文件版本已改变，请稍后重试', 409);
  const p = item.payload as unknown as BankPayload, file = p[area].find(f => f.name === name);
  if (!file) throw new FederationError('题目文件不存在', 404);
  const id = item.localId.slice(hydro.problemDomainId.length + 1);
  const signed = await requestHydroBridge<{ url: string }>({ platformBaseUrl: hydro.baseUrl }, '/api/proctor/problem-bank', { action: 'file', id, area, name, sha256: file.sha256 });
  return fetchHydroFile(signed.url, hydro.baseUrl, undefined, 300_000);
}
export async function mergeBank(value: PlatformItem, settings: PlatformSyncSettings, filesPerBatch = 1) {
  const old = await prisma.platformSyncItem.findUnique({ where: { id: value.id } });
  if (value.hash !== itemHash(value.payload, value.deleted)) throw new FederationError('题库同步校验失败');
  if (old && (old.kind !== 'BANK' || old.scope !== 'bank')) throw new FederationError('题库同步来源冲突');
  if (value.scope !== 'bank' || value.kind !== 'BANK') throw new FederationError('题库同步范围无效');
  if (old && comparePlatformVersion(old, value) >= 0) {
    if (comparePlatformVersion(old, value) === 0 && old.hash !== value.hash) throw new FederationError('题库版本内容冲突');
    if (old.writer !== value.writer && old.hash !== value.hash) await platformTransaction(tx => retainPlatformConflict(tx, value));
    if (!old.deleted && old.hash === value.hash && old.localId) {
      const h = await getHydroSettings();
      await requestHydroBridge({ platformBaseUrl: h.baseUrl }, '/api/proctor/problem-bank', { action: 'ack', id: old.localId.slice(h.problemDomainId.length + 1), syncId: value.id, hash: value.hash, revision: value.revision, writer: value.writer });
    }
    return;
  }
  const hydro = await getHydroSettings(); await assertBankBinding(hydro);
  const previousId = old?.localId;
  if (previousId && !previousId.startsWith(`${hydro.problemDomainId}:`)) throw new FederationError('题库域已更换，请先恢复原题库域');
  let localId = previousId ?? null;
  let refreshed: { sourceId: string; problem: HydroProblemPayload } | undefined;
  if (value.deleted) {
    const source = localId ? await prisma.systemSetting.findUnique({ where: { key: `bank-source:${localId}` } }) : null;
    await requestHydroBridge({ platformBaseUrl: hydro.baseUrl }, '/api/proctor/problem-bank', { action: 'delete', id: localId?.slice(hydro.problemDomainId.length + 1), syncId: value.id,
      revision: value.revision, writer: value.writer, sourceId: (source?.value as { sourceId?: string } | undefined)?.sourceId, expectedHash: old?.deleted ? undefined : old?.appliedHash });
  } else {
    const p = value.payload as unknown as BankPayload;
    const prepared = await prepareLocalBank(value, old);
    localId = `${hydro.problemDomainId}:${prepared.id}`;
    // Hydro persists the identity in its initial insert; retries reuse the same document.
    const dir = await mkdtemp(join(tmpdir(), 'proctor-bank-'));
    try {
      const uploaded = await prisma.systemSetting.findUnique({ where: { key: `bank-upload:${value.id}` } });
      const pushed = settings.role === 'PUBLIC' && (uploaded?.value as Record<string, unknown> | undefined)?.hash === value.hash;
      // A prepare/upload marker only identifies a transfer; it is not proof
      // that every file has arrived. Never apply a partially uploaded bank.
      if (settings.role === 'PUBLIC' && prepared.missing.length) throw new FederationError('等待内网上传题目测试数据或附件（自动补传）');
      if (!pushed) for (const missing of prepared.missing.slice(0, filesPerBatch)) {
        const peer = peerConnection(settings);
        const area = missing.area, file = p[area].find(f => f.name === missing.name)!;
        const response = await fetch(`${platformOrigin(peer.baseUrl)}/api/platform-sync/file`, { method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${peer.apiKey}` }, body: JSON.stringify({ itemId: value.id, area, name: file.name, hash: value.hash }), signal: AbortSignal.timeout(300_000) });
        if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new FederationError('题目文件同步失败，将自动重试', 502); }
        const path = join(dir, 'file');
        const checksum = createHash('sha256'); let bytes = 0;
        await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; checksum.update(chunk); if (bytes > file.size) done(new Error('题目文件大小不符')); else done(null, chunk); } }), createWriteStream(path));
        if (bytes !== file.size || checksum.digest('hex') !== file.sha256) throw new FederationError('题目文件校验失败', 502);
        const form = new FormData();
        form.set('id', prepared.id); form.set('syncId', value.id); form.set('hash', value.hash); form.set('area', area); form.set('name', file.name); form.set('file', await openAsBlob(path), 'data.bin');
        const upload = await fetch(`${hydro.baseUrl}/api/proctor/problem-bank/upload`, { method: 'POST', redirect: 'error', headers: { 'x-proctor-api-key': hydro.apiKey }, body: form, signal: AbortSignal.timeout(300_000) });
        const result = await upload.json(); if (!upload.ok || !result.ok) throw new FederationError('本地题目文件写入失败', 502);
      }
      if (!pushed && prepared.missing.length > filesPerBatch) throw new FederationError('本批题目文件已保存，剩余文件将在后续批次补齐');
      await requestHydroBridge({ platformBaseUrl: hydro.baseUrl }, '/api/proctor/problem-bank', { action: 'apply', id: prepared.id, syncId: value.id, hash: value.hash, revision: value.revision, writer: value.writer });
    } finally { await rm(dir, { recursive: true, force: true }); }
    refreshed = { sourceId: prepared.sourceId, problem: await requestHydroProblem({ platformBaseUrl: hydro.baseUrl }, prepared.id) };
  }
  await platformTransaction(async tx => {
    if (old && old.writer !== value.writer && old.hash !== value.hash) await retainPlatformConflict(tx, wireItem(old));
    if (localId) await releaseRetiredBankSlot(tx, hydro.problemDomainId, localId, value.id);
    // Fence and commit the definition, mapping and journal together. A task
    // that lost its lease while reading Hydro must not publish old points or
    // leave an exam definition ahead of its acknowledged bank version.
    if (localId && value.deleted) await tx.examProblem.updateMany({
      where: { hydroDomain: hydro.problemDomainId, hydroProblemId: localId.slice(hydro.problemDomainId.length + 1) }, data: { sourceDeleted: true },
    });
    if (localId && refreshed) {
      const { sourceId, problem } = refreshed;
      const key = `bank-source:${localId}`;
      await tx.systemSetting.upsert({ where: { key }, create: { key, value: { sourceId } }, update: { value: { sourceId } } });
      // Finished exams retain their original statement and marks.
      await tx.examProblem.updateMany({ where: { hydroDomain: hydro.problemDomainId,
        hydroProblemId: localId.slice(hydro.problemDomainId.length + 1), sourceDeleted: false, exam: { endAt: { gt: new Date() } } },
      data: { title: problem.title, content: problem.content, html: problem.html, config: problem.config as Prisma.InputJsonValue,
        problemType: String(problem.config.type || 'default'), hydroScore: problemFullScore(problem) ?? 100,
        ...problemLimits(problem.config), files: value.payload.files as Prisma.InputJsonValue, sourceDeleted: false } });
    }
    await appendItem(tx, value, localId);
    await tx.systemSetting.deleteMany({ where: { key: `bank-upload:${value.id}` } });
    await tx.systemSetting.deleteMany({ where: { key: `bank-upload-error:${value.id}` } });
    await tx.systemSetting.deleteMany({ where: { key: `bank-progress:${value.id}` } });
  });
  if (!value.deleted && localId) await requestHydroBridge({ platformBaseUrl: hydro.baseUrl }, '/api/proctor/problem-bank', { action: 'ack', id: localId.slice(hydro.problemDomainId.length + 1), syncId: value.id, hash: value.hash, revision: value.revision, writer: value.writer });
}
