import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream, openAsBlob } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from './db';
import { getHydroSettings } from './settings';
import { digest, FederationError } from './exam-federation-protocol';
import { comparePlatformVersion, type PlatformItem } from './platform-sync-protocol';
import { itemHash } from './platform-sync-store';
import { assertBankBinding, prepareLocalBank, type BankPayload } from './platform-sync-bank';
import { platformTransaction } from './platform-sync-lock';
import { getPlatformSyncSettings, type PlatformSyncSettings } from './platform-sync-settings';
export async function recordBankUploadFailure(request: Request, error: unknown) {
  const url = new URL(request.url), itemId = url.searchParams.get('itemId') || '', hash = url.searchParams.get('hash') || '';
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(itemId) || !/^[a-f0-9]{64}$/.test(hash)) return;
  const message = error instanceof FederationError ? error.message : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
    ? '文件上传超时或连接中断，将自动重试' : '文件接收或写入失败，将自动重试';
  await prisma.$transaction(async tx => {
    const markerKey = `bank-upload:${itemId}`;
    await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${markerKey} FOR UPDATE`;
    const marker = await tx.systemSetting.findUnique({ where: { key: markerKey } });
    if ((marker?.value as { hash?: string } | undefined)?.hash !== hash) return;
    const key = `bank-upload-error:${itemId}`, value = { hash, error: message.slice(0, 500), at: new Date().toISOString() };
    await tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }, { isolationLevel: 'ReadCommitted', timeout: 10_000 });
}
export async function prepareBankUpload(value: PlatformItem, settings: PlatformSyncSettings) {
  if (settings.role !== 'PUBLIC' || value.scope !== 'bank' || value.kind !== 'BANK' || value.deleted || value.hash !== itemHash(value.payload)) throw new FederationError('题目文件同步资料无效', 400);
  const peer = await prisma.systemSetting.findUnique({ where: { key: 'platform-peer' } });
  if ((peer?.value as { nodeId?: string } | undefined)?.nodeId !== value.writer) throw new FederationError('题目文件来源与已绑定的内网节点不一致', 409);
  // Native version/hash checks reject uncaptured local edits without rescanning
  // the entire bank for each individual file retry.
  const old = await prisma.platformSyncItem.findUnique({ where: { id: value.id } });
  if (old && (old.scope !== 'bank' || old.kind !== 'BANK')) throw new FederationError('题库同步来源冲突');
  if (old && comparePlatformVersion(old, value) >= 0) {
    if (comparePlatformVersion(old, value) === 0 && old.hash !== value.hash) throw new FederationError('题库版本内容冲突');
    return { skip: true, missing: [] };
  }
  const hydro = await getHydroSettings();
  const target = await prepareLocalBank(value, old);
  await assertBankBinding(hydro);
  const marker = { hash: value.hash, id: target.id, revision: value.revision, writer: value.writer,
    hydroBaseUrl: hydro.baseUrl, hydroDomain: hydro.problemDomainId, payload: value.payload as never };
  await platformTransaction(tx => tx.systemSetting.upsert({ where: { key: `bank-upload:${value.id}` }, create: { key: `bank-upload:${value.id}`, value: marker }, update: { value: marker } }));
  return { skip: false, missing: target.missing };
}
export async function receiveBankUpload(request: Request, settings: PlatformSyncSettings) {
  const url = new URL(request.url), itemId = url.searchParams.get('itemId') || '', hash = url.searchParams.get('hash') || '', area = url.searchParams.get('area'), name = url.searchParams.get('name') || '';
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(itemId) || !/^[a-f0-9]{64}$/.test(hash) || !['data','files'].includes(area || '')) throw new FederationError('题目文件参数无效', 400);
  const pending = await prisma.systemSetting.findUnique({ where: { key: `bank-upload:${itemId}` } });
  const value = pending?.value as unknown as { hash: string; id: string; payload: BankPayload; hydroBaseUrl?: string; hydroDomain?: string } | undefined;
  if (!value || value.hash !== hash) throw new FederationError('文件同步版本已改变', 409);
  const hydro = await getHydroSettings();
  if (value.hydroBaseUrl !== hydro.baseUrl || value.hydroDomain !== hydro.problemDomainId) throw new FederationError('题库连接已改变，请重新准备补传', 409);
  const file = value.payload[area as 'data' | 'files'].find(f => f.name === name);
  if (!file || !request.body) throw new FederationError('题目文件不存在', 404);
  const dir = await mkdtemp(join(tmpdir(),'proctor-bank-upload-'));
  try {
    const path = join(dir,'file'); let size = 0; const hashFile = createHash('sha256');
    await pipeline(Readable.fromWeb(request.body as never), new Transform({ transform(chunk, _encoding, done) { size += chunk.length; hashFile.update(chunk); if (size > file.size) done(new Error('文件大小不符')); else done(null,chunk); } }), createWriteStream(path), { signal: AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]) });
    if (size !== file.size || hashFile.digest('hex') !== file.sha256) throw new FederationError('题目文件大小不符', 400);
    const [fresh, marker, currentHydro] = await Promise.all([getPlatformSyncSettings(), prisma.systemSetting.findUnique({ where: { key: `bank-upload:${itemId}` } }), getHydroSettings()]);
    if (!fresh.enabled || fresh.role !== 'PUBLIC' || fresh.revision !== settings.revision || !marker || digest(marker.value) !== digest(pending!.value)
      || currentHydro.baseUrl !== hydro.baseUrl || currentHydro.problemDomainId !== hydro.problemDomainId || currentHydro.apiKey !== hydro.apiKey) throw new FederationError('同步配置或文件版本已改变，文件将重新补传', 409);
    // Only stage bytes at the original Hydro/domain. The native upload endpoint
    // also fences syncId/hash; applying and acknowledging still require the lease.
    const form = new FormData();
    form.set('id', value.id); form.set('syncId',itemId); form.set('hash',hash); form.set('area',area!); form.set('name',name); form.set('file',await openAsBlob(path),'data.bin');
    const response = await fetch(`${hydro.baseUrl}/api/proctor/problem-bank/upload`, { method:'POST', headers:{ 'x-proctor-api-key':hydro.apiKey }, body:form, redirect:'error',signal:AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]) });
    const result = await response.json(); if (!response.ok || !result.ok) throw new FederationError('题目文件写入失败',502);
    await prisma.systemSetting.deleteMany({ where: { key: `bank-upload-error:${itemId}`, value: { path: '$.hash', equals: hash } } });
    return { uploaded:true };
  } finally { await rm(dir,{ recursive:true,force:true }); }
}
