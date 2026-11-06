import { CommunicationReplySchema } from './exam-communication-protocol';
import { decodeCommunicationAssets, installPreparedAssets } from './exam-communication-assets';
import { prepareIncomingCommunications } from './exam-communication-incoming';
import { buildCommunicationPage, communicationPage, materializeCommunications, mergeCommunications, prepareCommunications } from './exam-communications';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExamFederation, Prisma } from '@prisma/client';
import { prisma } from './db';
import { RequestParseError } from './http';
import { compareManifests, eligibleSyncExam, syncManifest } from './exam-federation-contract';
import { syncProblemNumber } from './exam-federation-problems';
import { federationTransaction, materializeSubmissions, mergeSnapshots, readSyncPage } from './exam-federation-store';
import { ExchangeReplySchema, FederationError, keyHash, manifestContractHash, ManifestSchema, newSyncKey, openKey, sealKey, syncBaseUrl, syncRequest, SYNC_VERSION } from './exam-federation-protocol';

export const FederationSettingsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('hub-key') }),
  z.object({ action: z.enum(['check', 'edge-connect']), baseUrl: z.string().max(512), examCode: z.string().regex(/^\d{10}$/), apiKey: z.string().max(100).optional() }),
  z.object({ action: z.enum(['pause', 'resume', 'retry']) }),
]);
export async function federationState(examId: string) {
  const exam = await eligibleSyncExam(examId);
  const config = await prisma.examFederation.findUnique({ where: { examId } });
  const [local, imported, queued, pendingPush] = await Promise.all([
    prisma.contestSubmission.count({ where: { examId, syncImported: false } }),
    prisma.contestSubmission.count({ where: { examId, syncImported: true } }),
    prisma.contestSubmission.count({ where: { examId, federationDirty: true } }),
    config?.role === 'EDGE' ? prisma.examFederationEntry.count({ where: { examId, writerNodeId: config.nodeId, sequence: { gt: config.pushCursor } } }) : Promise.resolve(0),
  ]);
  return { examCode: exam.examCode, role: config?.role ?? null, enabled: config?.enabled ?? false,
    baseUrl: config?.remoteBaseUrl ?? '', hasKey: Boolean(config?.apiKeyCiphertext),
    communicationSuccessAt: config?.communicationSuccessAt ?? null, communicationError: config?.communicationError ?? '',
    nodeId: config?.nodeId ?? '', lastSuccessAt: config?.lastSuccessAt ?? null, lastError: config?.lastError ?? '',
    nextAttemptAt: config?.nextAttemptAt ?? null, local, imported, queued, pendingPush,
    pushCursor: config?.pushCursor.toString() ?? '0', pullCursor: config?.pullCursor.toString() ?? '0' };
}
export async function configureFederation(examId: string, input: z.infer<typeof FederationSettingsSchema>) {
  await eligibleSyncExam(examId);
  if (input.action === 'hub-key') {
    const apiKey = newSyncKey();
    await federationTransaction(examId, async tx => {
      const old = await tx.examFederation.findUnique({ where: { examId } });
      if (old && old.role !== 'HUB') throw new FederationError('此考试已作为内网节点配置，不能改为公网汇总节点');
      const nodeId = old?.nodeId ?? randomUUID();
      const manifest = await syncManifest(examId, nodeId, apiKey, tx);
      const data = { role: 'HUB', enabled: true, apiKeyHash: keyHash(apiKey), apiKeyCiphertext: sealKey(apiKey),
        contractHash: manifest.hash, generation: (old?.generation ?? -1) + 1, leaseToken: null, leaseUntil: null, lastError: null, failures: 0, submissionNextAttemptAt: new Date(), communicationNextAttemptAt: new Date(), communicationFailures: 0, communicationError: null, nextAttemptAt: new Date() };
      await tx.examFederation.upsert({ where: { examId }, create: { examId, nodeId, ...data }, update: data });
    });
    return { ...(await federationState(examId)), issuedKey: apiKey };
  }
  if (input.action === 'check' || input.action === 'edge-connect') {
    const old = await prisma.examFederation.findUnique({ where: { examId } });
    if (old && old.role !== 'EDGE') throw new FederationError('此考试已作为公网汇总节点配置，不能连接其他公网节点');
    const key = input.apiKey?.trim() || openKey(old?.apiKeyCiphertext ?? null);
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new FederationError('同步密钥格式不正确', 400);
    const baseUrl = syncBaseUrl(input.baseUrl);
    const remote = await syncRequest(baseUrl, input.examCode, key, { action: 'manifest', version: SYNC_VERSION }, ManifestSchema);
    if (manifestContractHash(remote) !== remote.hash) throw new FederationError('公网考试定义校验失败，请检查配置');
    if (!remote.capabilities?.includes('communications') || !remote.capabilities.includes('qa-assets')) throw new FederationError('请将公网与内网后台都更新到支持公告答疑同步的版本');
    if (Math.abs(Date.now() - +new Date(remote.now)) > 60_000) throw new FederationError('内网与公网服务器时间相差超过一分钟，请先校准时间');
    const nodeId = old?.nodeId ?? randomUUID();
    if (remote.nodeId === nodeId) throw new FederationError('不能连接本机考试，请检查公网地址');
    if (remote.examCode !== input.examCode) throw new FederationError('公网返回的考试编号不一致');
    if (old?.boundHubId && old.boundHubId !== remote.nodeId) throw new FederationError('此考试已绑定另一公网考试，不能混用同步历史');
    await federationTransaction(examId, async tx => {
      const current = await tx.examFederation.findUnique({ where: { examId } });
      if (current?.generation !== old?.generation) throw new FederationError('同步设置已被其他管理员修改，请刷新重试');
      const local = await syncManifest(examId, nodeId, key, tx);
      const problemMapping = compareManifests(local, remote);
      if (current?.boundHubId && await tx.examFederationEntry.findFirst({ where: { examId }, select: { submissionId: true } })) {
        const previousNumber = syncProblemNumber(current);
        if (problemMapping.some(p => previousNumber({ order: p.order, hydroProblemId: p.localNumber }) !== p.remoteNumber)) {
          throw new FederationError('已有提交同步记录，不能改变已绑定的跨网题号映射');
        }
      }
      if (local.examCode !== remote.examCode) {
        const used = await tx.contestSubmission.count({ where: { examId } }) + await tx.clientSession.count({ where: { examId } }) + await tx.loginRequest.count({ where: { examId } });
        if (used || current?.enabled) throw new FederationError('本地考试编号不同且已有考试活动，不能自动更改，请新建同编号考试后连接');
        const collision = await tx.exam.findUnique({ where: { examCode: remote.examCode }, select: { id: true } });
        if (collision && collision.id !== examId) throw new FederationError('公网考试编号已被本地其他考试占用');
        if (input.action === 'edge-connect') await tx.exam.update({ where: { id: examId }, data: { examCode: remote.examCode } });
      }
      if (input.action === 'check') return;
      const contractHash = remote.hash;
      const localContractHash = manifestContractHash({ ...local, examCode: remote.examCode });
      const data = { role: 'EDGE', enabled: true, remoteBaseUrl: baseUrl, apiKeyHash: keyHash(key), apiKeyCiphertext: sealKey(key),
        boundHubId: remote.nodeId, contractHash, localContractHash, problemMapping, generation: (current?.generation ?? -1) + 1, leaseToken: null, leaseUntil: null, failures: 0, lastError: null, submissionNextAttemptAt: new Date(), communicationNextAttemptAt: new Date(), communicationFailures: 0, communicationError: null, nextAttemptAt: new Date() };
      await tx.examFederation.upsert({ where: { examId }, create: { examId, nodeId, ...data }, update: data });
    });
    return { ...(await federationState(examId)), checked: true, matchedCandidates: remote.candidates.length, matchedProblems: remote.problems.length };
  }
  await federationTransaction(examId, async tx => {
    const config = await tx.examFederation.findUnique({ where: { examId } });
    if (!config) throw new FederationError('请先配置公网密钥或内网连接', 400);
    if (input.action === 'resume') {
      const manifest = await syncManifest(examId, config.nodeId, openKey(config.apiKeyCiphertext), tx);
      if (manifest.hash !== (config.localContractHash ?? config.contractHash)) throw new FederationError('考试定义已改变，请重新核对并配置同步');
    }
    await tx.examFederation.update({ where: { examId }, data: { ...(input.action === 'pause' ? { enabled: false } : input.action === 'resume' ? { enabled: true } : {}),
      generation: { increment: 1 }, leaseToken: null, leaseUntil: null, failures: 0, lastError: null, submissionNextAttemptAt: new Date(), communicationNextAttemptAt: new Date(), communicationFailures: 0, communicationError: null, nextAttemptAt: new Date() } });
  });
  return federationState(examId);
}
async function currentLease(tx: Prisma.TransactionClient, config: ExamFederation) {
  const fresh = await tx.examFederation.findUnique({ where: { examId: config.examId } });
  if (!fresh?.enabled || fresh.leaseToken !== config.leaseToken || !fresh.leaseUntil || +fresh.leaseUntil <= Date.now()) throw new FederationError('同步设置已改变，等待下一轮同步');
  // Lock and renew at each bounded DB phase, before remote I/O. Materializing
  // a long backlog must not consume the lease reserved for the next exchange.
  const leaseUntil = new Date(Date.now() + 60_000);
  const renewed = await tx.examFederation.updateMany({ where: { examId: config.examId, enabled: true,
    leaseToken: config.leaseToken, leaseUntil: { gt: new Date() } }, data: { leaseUntil } });
  if (!renewed.count) throw new FederationError('同步租约已被回收，等待下一轮同步');
  return { ...fresh, leaseUntil };
}
async function syncExamSubmissions(config: ExamFederation) {
  try {
    // Bounded backfill; catch up without holding the login pool or an HTTP transaction open.
    for (let index = 0; index < 4; index++) {
      await federationTransaction(config.examId, async tx => { await materializeSubmissions(tx, await currentLease(tx, config)); });
    }
    if (config.role === 'EDGE') {
      const exam = await prisma.exam.findUniqueOrThrow({ where: { id: config.examId }, select: { examCode: true } });
      const key = openKey(config.apiKeyCiphertext);
      for (let index = 0; index < 4; index++) {
        const { fresh, page } = await federationTransaction(config.examId, async tx => {
          const fresh = await currentLease(tx, config);
          return { fresh, page: await readSyncPage(tx, fresh, fresh.pushCursor, 'push') };
        });
        const reply = await syncRequest(config.remoteBaseUrl!, exam.examCode, key, { action: 'exchange', version: SYNC_VERSION,
          nodeId: config.nodeId, hubId: config.boundHubId, contractHash: config.contractHash, after: fresh.pullCursor.toString(), entries: page.entries }, ExchangeReplySchema);
        if (Math.abs(Date.now() - +new Date(reply.now)) > 60_000) throw new FederationError('两端服务器时间偏差过大，请校准时间后重试');
        if (reply.nodeId !== config.boundHubId || BigInt(reply.after) < fresh.pullCursor) throw new FederationError('公网节点或同步进度异常');
        await federationTransaction(config.examId, async tx => {
          const latest = await currentLease(tx, config);
          if (latest.pushCursor !== fresh.pushCursor || latest.pullCursor !== fresh.pullCursor) throw new FederationError('同步进度已改变，请稍后重试');
          await mergeSnapshots(tx, latest, reply.entries);
          await tx.examFederation.update({ where: { examId: config.examId }, data: { pushCursor: BigInt(page.after), pullCursor: BigInt(reply.after),
            lastSuccessAt: new Date(), leaseUntil: new Date(Date.now() + 60_000) } });
        });
        if (!page.entries.length && !reply.entries.length && page.after === fresh.pushCursor.toString() && reply.after === fresh.pullCursor.toString()) break;
      }
    }
    await prisma.examFederation.updateMany({ where: { examId: config.examId, leaseToken: config.leaseToken }, data: {
      failures: 0, lastError: null, submissionNextAttemptAt: new Date(Date.now() + 2000) } });
  } catch (error) {
    const message = error instanceof FederationError ? error.message : '同步暂时失败，将自动重试；请检查公网连接和两端服务状态';
    await prisma.examFederation.updateMany({ where: { examId: config.examId, leaseToken: config.leaseToken }, data: {
      failures: { increment: 1 }, lastError: message,
      submissionNextAttemptAt: new Date(Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(config.failures, 5)) + Math.floor(Math.random() * 1000)) } });
  }
}
async function syncExam(config: ExamFederation) {
  let deferred = false;
  try {
    const communicationsFirst = communicationWaiting.has(config.examId) || +config.communicationNextAttemptAt < +config.submissionNextAttemptAt;
    if (communicationsFirst) deferred = await syncExamCommunications(config) === 'deferred';
    const waiting = communicationWaiting.get(config.examId);
    if (waiting?.generation === config.generation) waiting.ready = false;
    if (+config.submissionNextAttemptAt <= Date.now()) await syncExamSubmissions(config);
    // A rejected/oversized submission or a submission-specific remote failure
    // must not prevent pending replies and notices from getting their turn.
    if (!communicationsFirst) deferred = await syncExamCommunications(config) === 'deferred';
  } finally {
    try {
      const fresh = await prisma.examFederation.findUnique({ where: { examId: config.examId } });
      if (fresh?.leaseToken === config.leaseToken) await prisma.examFederation.updateMany({
        where: { examId: config.examId, leaseToken: config.leaseToken }, data: { leaseToken: null, leaseUntil: null,
          // Leave the content due time intact for fairness, but avoid a hot
          // loop when the bounded content slot is still occupied.
          nextAttemptAt: new Date(Math.min(+fresh.submissionNextAttemptAt, deferred ? Date.now() + 2000 : +fresh.communicationNextAttemptAt)) },
      });
    } finally {
      const waiting = communicationWaiting.get(config.examId);
      if (waiting?.generation === config.generation) waiting.ready = true;
    }
  }
}
type CommunicationWaiter = { generation: number; ready: boolean };
const communicationWorker = globalThis as typeof globalThis & { communicationBusy?: boolean; communicationWaiting?: Map<string, CommunicationWaiter> };
const communicationWaiting = communicationWorker.communicationWaiting ??= new Map<string, CommunicationWaiter>();
const communicationStateSelect = {
  examId: true, enabled: true, generation: true, communicationNextAttemptAt: true, nextAttemptAt: true, leaseToken: true, leaseUntil: true,
} satisfies Prisma.ExamFederationSelect;
type CommunicationState = Prisma.ExamFederationGetPayload<{ select: typeof communicationStateSelect }>;
function validCommunicationWaiter(id: string, ticket: CommunicationWaiter, state: CommunicationState | null | undefined) {
  const foreignLease = state?.leaseToken && state.leaseUntil && +state.leaseUntil > Date.now() && !running.has(id);
  return Boolean(state?.enabled && state.generation === ticket.generation && +state.communicationNextAttemptAt <= Date.now()
    && +state.nextAttemptAt <= Date.now() + 4000 && !foreignLease);
}
/** Non-blocking FIFO admission: no HTTP work or exam lease waits in memory
 * for a slot. Paused, reconfigured and externally claimed waiters are evicted. */
async function takeCommunicationTurn(config: ExamFederation) {
  if (communicationWaiting.get(config.examId)?.generation !== config.generation) communicationWaiting.delete(config.examId);
  if (!communicationWaiting.has(config.examId) && communicationWaiting.size >= 128) {
    if (communicationWorker.communicationBusy) return false;
    // New exams must be able to reclaim a full queue of paused/deleted exams;
    // none of those old exams will run again to remove its own reservation.
    const queued = [...communicationWaiting];
    let states: CommunicationState[];
    try {
      states = await prisma.examFederation.findMany({ where: { examId: { in: queued.map(([id]) => id) } }, select: communicationStateSelect });
    } catch { return false; }
    const byId = new Map(states.map(state => [state.examId, state]));
    for (const [id, ticket] of queued) {
      if (communicationWaiting.get(id) === ticket && !validCommunicationWaiter(id, ticket, byId.get(id))) communicationWaiting.delete(id);
    }
  }
  if (!communicationWaiting.has(config.examId) && communicationWaiting.size < 128) communicationWaiting.set(config.examId, { generation: config.generation, ready: true });
  const own = communicationWaiting.get(config.examId);
  if (!own) return false;
  own.ready = true;
  for (;;) {
    if (communicationWorker.communicationBusy) return false;
    const first = [...communicationWaiting].find(([, ticket]) => ticket.ready);
    if (!first) return false;
    const [id, ticket] = first;
    if (id === config.examId) {
      communicationWaiting.delete(id); communicationWorker.communicationBusy = true; return true;
    }
    let state: CommunicationState | null;
    try {
      state = await prisma.examFederation.findUnique({ where: { examId: id }, select: communicationStateSelect });
    } catch {
      // A failed check must not leave a stale reservation blocking all exams.
      if (communicationWaiting.get(id) === ticket) communicationWaiting.delete(id);
      return false;
    }
    // Another contender can acquire the slot while the lookup is in flight.
    if (communicationWorker.communicationBusy) return false;
    if (communicationWaiting.get(id) !== ticket || !ticket.ready) continue;
    if (validCommunicationWaiter(id, ticket, state)) return false;
    communicationWaiting.delete(id);
  }
}
async function syncExamCommunications(config: ExamFederation): Promise<'idle' | 'deferred' | 'attempted'> {
  const current = await prisma.examFederation.findUnique({ where: { examId: config.examId } });
  if (!current?.enabled || current.leaseToken !== config.leaseToken || +current.communicationNextAttemptAt > Date.now()) {
    if (communicationWaiting.get(config.examId)?.generation === config.generation) communicationWaiting.delete(config.examId);
    return 'idle';
  }
  if (!await takeCommunicationTurn(current)) return 'deferred';
  try {
    const prepared = await prepareCommunications(current);
    await federationTransaction(config.examId, async tx => {
      const fresh = await currentLease(tx, config);
      await materializeCommunications(tx, fresh, prepared);
      await tx.examFederation.update({ where: { examId: config.examId }, data: { leaseUntil: new Date(Date.now() + 60_000) } });
    });
    if (current.role === 'EDGE') for (let round = 0; round < 4; round++) {
      const { fresh, selected } = await federationTransaction(config.examId, async tx => {
        const fresh = await currentLease(tx, config);
        return { fresh, selected: await communicationPage(tx, fresh, fresh.contentPushCursor, true) };
      });
      const page = await buildCommunicationPage(selected);
      const exam = await prisma.exam.findUniqueOrThrow({ where: { id: config.examId }, select: { examCode: true } });
      const response = await syncRequest(current.remoteBaseUrl!, exam.examCode, openKey(current.apiKeyCiphertext), { action: 'communications', version: 1,
        nodeId: current.nodeId, hubId: current.boundHubId, contractHash: current.contractHash, after: fresh.contentPullCursor.toString(), entries: page.entries }, CommunicationReplySchema);
      if (response.nodeId !== current.boundHubId || BigInt(response.after) < fresh.contentPullCursor || Math.abs(Date.now() - +new Date(response.now)) > 60_000) throw new FederationError('公告答疑同步节点、进度或时间异常');
      const buffers = await decodeCommunicationAssets(response.entries, config.examId);
      const incoming = await prepareIncomingCommunications(current, response.entries);
      await federationTransaction(config.examId, async tx => {
        const latest = await currentLease(tx, config);
        if (latest.contentPushCursor !== fresh.contentPushCursor || latest.contentPullCursor !== fresh.contentPullCursor) throw new FederationError('公告答疑同步进度已改变，请重试');
        await installPreparedAssets(tx, latest, incoming);
        await mergeCommunications(tx, latest, response.entries, buffers, incoming);
        await tx.examFederation.update({ where: { examId: config.examId }, data: { contentPushCursor: BigInt(page.after), contentPullCursor: BigInt(response.after),
          communicationSuccessAt: new Date(), leaseUntil: new Date(Date.now() + 60_000) } });
      });
      if (!page.entries.length && !response.entries.length && page.after === fresh.contentPushCursor.toString() && response.after === fresh.contentPullCursor.toString()) break;
    }
    await prisma.examFederation.updateMany({ where: { examId: config.examId, leaseToken: config.leaseToken }, data: { communicationError: prepared.assets.errors[0] || null,
      communicationFailures: 0, communicationNextAttemptAt: new Date(Date.now() + 2000) } });
  } catch (error) {
    await prisma.examFederation.updateMany({ where: { examId: config.examId, leaseToken: config.leaseToken }, data: {
      communicationError: error instanceof FederationError || error instanceof RequestParseError ? error.message : '公告答疑同步暂时失败，将自动重试', communicationFailures: { increment: 1 },
      communicationNextAttemptAt: new Date(Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(current.communicationFailures, 5))) } });
  } finally { communicationWorker.communicationBusy = false; }
  return 'attempted';
}
const shared = globalThis as typeof globalThis & {
  federationTimer?: ReturnType<typeof setInterval>;
  federationTask?: Promise<void>;
  federationRunning?: Map<string, Promise<void>>;
};
const running = shared.federationRunning ??= new Map<string, Promise<void>>();
async function tick() {
  const available = 2 - running.size;
  if (available <= 0) return;
  const now = new Date();
  const configs = await prisma.examFederation.findMany({ where: { enabled: true, examId: { notIn: [...running.keys()] },
    nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, orderBy: { nextAttemptAt: 'asc' }, take: available });
  for (const config of configs) {
    const token = randomUUID();
    const claimed = await prisma.examFederation.updateMany({ where: { examId: config.examId, enabled: true, generation: config.generation, nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + 60_000) } });
    if (!claimed.count) continue;
    // A stalled remote exam occupies only its own slot. Healthy exams may use
    // the other slot again on the next tick without waiting for its timeout.
    const job = syncExam({ ...config, leaseToken: token })
      .catch(() => console.error('Exam federation lease update unavailable'))
      .finally(() => { if (running.get(config.examId) === job) running.delete(config.examId); });
    running.set(config.examId, job);
  }
}
export function startExamFederationWorker() {
  if (shared.federationTimer) return;
  shared.federationTimer = setInterval(() => {
    if (shared.federationTask) return;
    shared.federationTask = tick().catch(() => console.error('Exam federation worker unavailable')).finally(() => { delete shared.federationTask; });
  }, 2000);
  shared.federationTimer.unref();
}
