import { migrateLegacyFederation } from './platform-sync-legacy';
import { EXTRA_KINDS, captureExtras, mergeExtraItem } from './platform-sync-extras';
import { queueBankFilePushes, runBankFilePushes } from './platform-sync-file-outbox';
import { withPlatformLease, platformTransaction } from './platform-sync-lock';
export { withPlatformLease } from './platform-sync-lock';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './db';
import { FederationError, equalHash, keyHash } from './exam-federation-protocol';
import { captureBank, mergeBank } from './platform-sync-bank';
import { captureExam, mergeExamItem } from './platform-sync-exams';
import { getPlatformSyncSettings, peerConnection, type PlatformSyncSettings } from './platform-sync-settings';
import { PLATFORM_SYNC_PROTOCOL, PlatformItemSchema, comparePlatformVersion, PlatformReplySchema, platformRequest, type PlatformItem } from './platform-sync-protocol';
import { itemHash, readPlatformPage, retainPlatformConflict, wireItem } from './platform-sync-store';
import { countPlatformPending } from './platform-sync-status';

export async function authenticatePlatformSync(request: Request) {
  const settings = await getPlatformSyncSettings();
  const received = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (settings.role !== 'PUBLIC') throw new FederationError('内网节点仅主动连接公网，不提供回连同步接口', 403);
  const expected = settings.publicApiKey;
  if (!settings.enabled || !expected || !equalHash(keyHash(received), keyHash(expected))) throw new FederationError('同步认证失败或同步已关闭', 401);
  return settings;
}
export async function capturePlatform(settings: PlatformSyncSettings) {
  const capture = async (scope: string, work: () => Promise<void>) => {
    const key = `platform-capture-error:${scope}`;
    try { await work(); await platformTransaction(tx => tx.systemSetting.deleteMany({ where: { key } })); }
    catch (error) {
      // The transaction still fences the lease/configuration. A failed bank or
      // one poisoned exam must not prevent unrelated scopes being journaled.
      const value = { scope, error: error instanceof FederationError ? error.message.slice(0, 500) : '资料捕获暂时失败，已保留原记录等待重试' };
      await platformTransaction(tx => tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } }));
    }
  };
  await capture('bank', () => captureBank(settings));
  const exams = await prisma.examFederation.findMany({ where: { managedGlobally: true, enabled: true }, select: { examId: true } });
  for (const exam of exams) await capture(exam.examId, async () => { await captureExam(exam.examId, settings); await captureExtras(exam.examId, settings); });
  const active = new Set(['bank', ...exams.map(exam => exam.examId)]);
  await platformTransaction(async tx => {
    const failures = await tx.systemSetting.findMany({ where: { key: { startsWith: 'platform-capture-error:' } }, select: { key: true } });
    for (const failure of failures) if (!active.has(failure.key.slice('platform-capture-error:'.length))) await tx.systemSetting.deleteMany({ where: { key: failure.key } });
  });
}
const order: Record<string, number> = { BANK: 0, EXAM: 1, CANDIDATE: 2, PROBLEM: 3, ADMINISTRATORS: 4, ROOM: 5, ROOM_ASSIGNMENT: 5.25, PHOTO: 5.5, LOGIN: 6, SESSION: 7, SCREEN_GROUP: 8, SCREEN_IMAGE: 9, SCREEN_DISPLAY: 10, CODE_JOB: 11, CODE_SOURCE: 12, CODE_PAIR: 13 };
async function applyPlatformItem(value: PlatformItem, settings: PlatformSyncSettings, creatorId?: string, alreadyCaptured = false) {
  if (value.kind === 'BANK') await mergeBank(value, settings, creatorId ? Infinity : 1);
  else if (EXTRA_KINDS.has(value.kind)) await mergeExtraItem(value, settings, alreadyCaptured);
  else await mergeExamItem(value, settings, creatorId, alreadyCaptured);
}
export async function bindPlatformPeer(nodeId: string, settings: PlatformSyncSettings) {
  if (nodeId === settings.nodeId) throw new FederationError('不能与本机同步', 400);
  await platformTransaction(async tx => {
    const old = await tx.systemSetting.findUnique({ where: { key: 'platform-peer' } });
    if (old && (old.value as { nodeId: string }).nodeId !== nodeId) throw new FederationError('服务器节点已改变，不能混用已有同步进度；请核对数据库及连接配置', 409);
    await tx.systemSetting.upsert({ where: { key: 'platform-peer' }, create: { key: 'platform-peer', value: { nodeId } }, update: {} });
  });
}
async function queueIncoming(value: PlatformItem) {
  if (value.hash !== itemHash(value.payload, value.deleted)) throw new FederationError('同步资料校验失败', 400);
  await platformTransaction(async tx => {
    const applied = await tx.platformSyncItem.findUnique({ where: { id: value.id } });
    if (applied) {
      if (applied.scope !== value.scope || applied.kind !== value.kind) throw new FederationError('同步资料来源冲突');
      const version = comparePlatformVersion(applied, value);
      if (!version && applied.hash !== value.hash) throw new FederationError('同一同步版本包含不同内容');
      if (version >= 0) {
        if (applied.writer !== value.writer && applied.hash !== value.hash) await retainPlatformConflict(tx, value);
        return; // Already durable: duplicate delivery need not re-enter the inbox.
      }
    }
    const row = await tx.platformSyncInbox.findUnique({ where: { id: value.id } });
    if (row) {
      const old = PlatformItemSchema.parse(row.snapshot);
      if (old.scope !== value.scope || old.kind !== value.kind) throw new FederationError('待同步资料来源冲突');
      const version = comparePlatformVersion(old, value);
      if (!version && old.hash !== value.hash) throw new FederationError('同一版本待同步资料内容不同');
      if (version >= 0) { if (old.writer !== value.writer && old.hash !== value.hash) await retainPlatformConflict(tx, value); return; }
      if (old.writer !== value.writer && old.hash !== value.hash) await retainPlatformConflict(tx, old);
    }
    await tx.platformSyncInbox.upsert({ where: { id: value.id }, create: { id: value.id, snapshot: value as Prisma.InputJsonValue }, update: { snapshot: value as Prisma.InputJsonValue } });
  });
}
export async function drainPlatformInbox(settings: PlatformSyncSettings) {
  // Reserve ordinary-record capacity separately from one file-heavy bank item.
  const rows = await prisma.$queryRaw<Array<{id:string;kind:string}>>`(SELECT id, JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.kind')) AS kind FROM PlatformSyncInbox
    WHERE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.kind')), '') <> 'BANK' ORDER BY lastAttemptAt ASC, id ASC LIMIT 32)
    UNION ALL (SELECT id, 'BANK' AS kind FROM PlatformSyncInbox WHERE JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.kind')) = 'BANK' ORDER BY lastAttemptAt ASC, id ASC LIMIT 1)`;
  rows.sort((a,b) => (a.kind === 'BANK' ? 100 : order[a.kind] ?? 10) - (b.kind === 'BANK' ? 100 : order[b.kind] ?? 10));
  const deadline = Date.now() + 10_000;
  for (const ref of rows) {
    if (ref.kind !== 'BANK' && Date.now() >= deadline) continue;
    const row = await prisma.platformSyncInbox.findUnique({ where: { id: ref.id } });
    if (!row) continue;
    const where = { id: row.id, snapshot: { equals: row.snapshot as Prisma.InputJsonValue } };
    try {
      const value = PlatformItemSchema.parse(row.snapshot);
      await applyPlatformItem(value, settings);
      // An older attempt must not acknowledge a newer replacement of this inbox row.
      await platformTransaction(tx => tx.platformSyncInbox.deleteMany({ where }));
    } catch (error) {
      await platformTransaction(tx => tx.platformSyncInbox.updateMany({ where, data: { lastAttemptAt: new Date(), lastError: error instanceof FederationError ? error.message : '资料暂未能写入，等待自动重试' } }));
    }
  }
}
export async function mergePlatformItems(entries: PlatformItem[], settings: PlatformSyncSettings, creatorId?: string) {
  const sorted = [...entries].sort((a,b) => (order[a.kind] ?? 10) - (order[b.kind] ?? 10));
  for (const value of sorted) {
    if (value.kind !== 'BANK') {
      const exam = await prisma.exam.findUnique({ where: { examCode: value.scope }, select: { federation: { select: { managedGlobally: true } } } });
      if (!creatorId && !exam?.federation?.managedGlobally) continue;
    }
    if (creatorId && (order[value.kind] ?? 10) <= 5) await applyPlatformItem(value, settings, creatorId);
    else await queueIncoming(value);
  }
  await drainPlatformInbox(settings);
}

export async function runPlatformSync() {
  const settings = await getPlatformSyncSettings(); if (!settings.enabled) return;
  if (settings.role === 'PUBLIC') {
    const state = await prisma.platformSyncState.findUnique({ where: { id: 'peer' }, select: { lastSuccessAt: true } });
    // Active LAN exchanges already capture and drain under this same lease.
    // Do not compete with their file preparation every three seconds.
    if (state?.lastSuccessAt && Date.now() - state.lastSuccessAt.getTime() < 30_000) return;
  }
  return withPlatformLease(async () => {
    try {
      await capturePlatform(settings);
      await drainPlatformInbox(settings);
      if (settings.role === 'LOCAL') {
        const peer = peerConnection(settings);
        const binding = await prisma.systemSetting.findUnique({ where: { key: 'platform-peer' } });
        const hello = await platformRequest(peer.baseUrl, peer.apiKey, '/api/platform-sync', { action: 'hello', nodeId: settings.nodeId, peerId: (binding?.value as {nodeId?:string}|undefined)?.nodeId }, PlatformReplySchema);
        await bindPlatformPeer(hello.nodeId, settings);
        for (let round = 0; round < 8; round++) {
          const state = await prisma.platformSyncState.findUniqueOrThrow({ where: { id: 'peer' } });
          const bound = await prisma.systemSetting.findUnique({ where: { key: 'platform-peer' } });
          const page = await readPlatformPage(state.pushCursor, (bound?.value as { nodeId?: string } | undefined)?.nodeId);
          await queueBankFilePushes(page.entries, settings);
          const response = await platformRequest(peer.baseUrl, peer.apiKey, '/api/platform-sync', { action: 'exchange', nodeId: settings.nodeId, peerId: hello.nodeId, after: state.pullCursor.toString(), entries: page.entries }, PlatformReplySchema);
          if (response.nodeId === settings.nodeId || BigInt(response.after) < state.pullCursor) throw new FederationError('同步节点或进度异常');
          await bindPlatformPeer(response.nodeId, settings);
          await mergePlatformItems(response.entries, settings);
          await platformTransaction(async tx => {
            const changed = await tx.platformSyncState.updateMany({ where: { id: 'peer', pushCursor: state.pushCursor, pullCursor: state.pullCursor }, data: { pushCursor: BigInt(page.after), pullCursor: BigInt(response.after), lastSuccessAt: new Date() } });
            if (!changed.count) throw new FederationError('同步进度已被其他任务修改，等待重试', 503);
          });
          if (!page.entries.length && !response.entries.length) break;
        }
      }
      await platformTransaction(async tx => {
        const pending = await countPlatformPending(tx);
        // Scanning the public bank is not communication with the LAN peer.
        await tx.platformSyncState.update({ where: { id: 'peer' }, data: { lastError: pending ? `有 ${pending} 条资料正在补传或等待依赖，数据已保留；具体原因见下方` : null } });
      });
    } catch (error) {
      await platformTransaction(tx => tx.platformSyncState.update({ where: { id: 'peer' }, data: { lastError: error instanceof FederationError ? error.message : '同步失败，将自动重试；请检查两端服务和 Hydro 插件' } })).catch(() => {}); throw error;
    }
  }, settings.revision);
}
export async function publicExamBundle(ref: string, settings: PlatformSyncSettings, after = '0', snapshot?: string) {
  const exam = await prisma.exam.findFirst({ where: { OR: [{ examCode: ref }, { id: ref }], federation: { managedGlobally: true, enabled: true } } });
  if (!exam || settings.role !== 'PUBLIC') throw new FederationError('公网考试不存在或尚未开启同步', 404);
  if (!snapshot) {
    if (after !== '0') throw new FederationError('导入快照缺失，请重新导入', 409);
    await capturePlatform(settings);
    if (await prisma.systemSetting.count({ where: { OR: [{ key: { startsWith: `platform-problem-error:${exam.id}:` } }, { key: { in: ['platform-capture-error:bank', `platform-capture-error:${exam.id}`] } }] } })) throw new FederationError('本场考试资料或题库映射尚未补齐，请处理同步提示后再导入');
    snapshot = randomUUID();
    const token = snapshot;
    await platformTransaction(async tx => {
      // The sequence lock also prevents journal rows moving between pages while
      // the immutable export is being materialized.
      const definition = wireItem(await tx.platformSyncItem.findUniqueOrThrow({ where: { id: `exam:${exam.examCode}` } }));
      const references = await tx.platformSyncItem.findMany({ where: { scope: exam.examCode, kind: 'PROBLEM' }, select: { payload: true } });
      const bankIds = references.map(r => (r.payload as Record<string, unknown>).bankId).filter((id): id is string => typeof id === 'string');
      const banks = await tx.platformSyncItem.findMany({ where: { id: { in: bankIds }, scope: 'bank', kind: 'BANK', deleted: false }, select: { localId: true } });
      const bankErrors = banks.flatMap(bank => bank.localId ? [`platform-bank-error:${bank.localId}`] : []);
      // A prior mapping can still exist while its current native file is
      // unreadable. Do not publish that old bank snapshot as a fresh import.
      if (bankErrors.length && await tx.systemSetting.count({ where: { key: { in: bankErrors } } })) throw new FederationError('本场考试引用的题目或文件尚未补齐，请等待题库补传后再导入');
      let entries: PlatformItem[] = [], bytes = Buffer.byteLength(JSON.stringify(definition)), page = 0;
      const flush = async () => {
        await tx.systemSetting.create({ data: { key: `platform-export:${token}:${page++}`, value: entries as Prisma.InputJsonValue } });
        entries = []; bytes = Buffer.byteLength(JSON.stringify(definition));
      };
      const kinds = Object.keys(order).concat(['PRINT','CHEATING','RECEIPT','MESSAGE_RECEIPT','ALERT']).sort((a,b) => (order[a] ?? 10) - (order[b] ?? 10));
      for (const kind of kinds) {
        let cursor = 0n;
        for (;;) {
          const rows = await tx.platformSyncItem.findMany({ where: { kind, ...(kind === 'BANK' ? { id: { in: bankIds } } : { scope: exam.examCode }), sequence: { gt: cursor } }, select: { id: true, sequence: true }, orderBy: { sequence: 'asc' }, take: 32 });
          for (const row of rows) {
            const value = wireItem(await tx.platformSyncItem.findUniqueOrThrow({ where: { id: row.id } })), size = Buffer.byteLength(JSON.stringify(value));
            if (size + Buffer.byteLength(JSON.stringify(definition)) > 16 * 1024 * 1024) throw new FederationError('单条考试资料过大', 413);
            if (entries.length === 32 || bytes + size > 16 * 1024 * 1024) await flush();
            entries.push(value); bytes += size; cursor = row.sequence;
          }
          if (rows.length < 32) break;
        }
      }
      if (entries.length || !page) await flush();
      await tx.systemSetting.create({ data: { key: `platform-export:${token}`, value: { scope: exam.examCode, definition, pages: page, expiresAt: Date.now() + 30 * 60_000 } as Prisma.InputJsonValue } });
      await tx.systemSetting.deleteMany({ where: { key: { startsWith: 'platform-export:' }, createdAt: { lt: new Date(Date.now() - 60 * 60_000) } } });
    });
  }
  const row = await prisma.systemSetting.findUnique({ where: { key: `platform-export:${snapshot}` } });
  const meta = row?.value as { scope: string; definition: PlatformItem; pages: number; expiresAt: number } | undefined;
  const page = Number(after);
  if (!meta || meta.scope !== exam.examCode || meta.expiresAt < Date.now() || !Number.isSafeInteger(page) || page < 0 || page >= meta.pages) throw new FederationError('导入快照已过期，请重新导入', 409);
  const content = await prisma.systemSetting.findUniqueOrThrow({ where: { key: `platform-export:${snapshot}:${page}` } });
  return { protocol: PLATFORM_SYNC_PROTOCOL, nodeId: settings.nodeId, snapshot, after: String(page + 1), entries: content.value as unknown as PlatformItem[], definition: meta.definition, hasMore: page + 1 < meta.pages };
}

export async function importPublicExam(link: string, creatorId: string) {
  const settings = await getPlatformSyncSettings();
  if (!settings.enabled || settings.role !== 'LOCAL') throw new FederationError('请先在系统设置配置本机为内网版本并启用同步', 400);
  let url: URL; try { url = new URL(link); } catch { throw new FederationError('请输入完整的公网考试链接', 400); }
  if (url.origin !== settings.publicBaseUrl || url.username || url.password) throw new FederationError('考试链接必须属于系统设置中的公网服务器', 400);
  const ref = url.pathname.match(/\/(?:dashboard\/)?exams\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] || url.searchParams.get('examCode') || url.searchParams.get('examId');
  if (!ref) throw new FederationError('无法从链接识别考试，请复制公网考试详情链接', 400);
  return withPlatformLease(async () => {
    await captureBank(settings);
    const peer = peerConnection(settings);
    let after = '0', scope = '', snapshot: string | undefined;
    for (let page = 0; ; page++) {
      if (page > 10000) throw new FederationError('考试资料过多，请稍后继续导入');
      const bundle = await platformRequest(peer.baseUrl, peer.apiKey, '/api/platform-sync', { action: 'exam', examCode: ref, after, snapshot }, PlatformReplySchema);
      if (!bundle.snapshot || (snapshot && snapshot !== bundle.snapshot)) throw new FederationError('公网导入快照发生变化，请重试');
      snapshot = bundle.snapshot;
      await bindPlatformPeer(bundle.nodeId, settings);
      const definition = bundle.definition;
      if (!definition || definition.kind !== 'EXAM') throw new FederationError('公网考试资料不完整', 502);
      if (!scope) {
        scope = definition.scope;
        const existing = await prisma.exam.findUnique({ where: { examCode: scope }, select: { id: true, federation: true } });
        if (existing && !existing.federation?.managedGlobally) {
          if (existing.federation?.role !== 'EDGE' || existing.federation.boundHubId !== definition.payload.hubNodeId) throw new FederationError('相同考试编号已被本地其他考试使用，不能覆盖');
          await migrateLegacyFederation(existing.id, settings);
        }
        if (existing?.federation?.managedGlobally && existing.federation.enabled) await captureExam(existing.id, settings);
        await mergeExamItem(definition, settings, creatorId);
      } else if (scope !== definition.scope) throw new FederationError('公网考试资料发生变化，请重试');
      await mergePlatformItems(bundle.entries, settings, creatorId);
      if (!bundle.hasMore) break;
      if (BigInt(bundle.after) <= BigInt(after)) throw new FederationError('导入进度无效');
      after = bundle.after;
    }
    const exam = await prisma.exam.findUniqueOrThrow({ where: { examCode: scope }, select: { id: true, examCode: true, name: true } });
    await platformTransaction(tx => tx.examFederation.update({ where: { examId: exam.id }, data: { enabled: true, nextAttemptAt: new Date() } }));
    await drainPlatformInbox(settings);
    return exam;
  }, settings.revision);
}
const shared = globalThis as typeof globalThis & { platformSyncTimer?: ReturnType<typeof setInterval>; platformSyncTask?: Promise<unknown>; platformFilePushTask?: Promise<unknown> };
export function startPlatformSyncWorker() {
  if (shared.platformSyncTimer) return;
  shared.platformSyncTimer = setInterval(() => {
    if (!shared.platformSyncTask) shared.platformSyncTask = runPlatformSync().catch(() => {}).finally(() => { delete shared.platformSyncTask; });
    if (!shared.platformFilePushTask) shared.platformFilePushTask = runBankFilePushes().catch(() => {}).finally(() => { delete shared.platformFilePushTask; });
  }, 3000); shared.platformSyncTimer.unref();
}
