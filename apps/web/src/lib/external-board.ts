import { createHash, randomUUID } from 'node:crypto';
import { prisma } from './db';
import { getExternalLoginSettings } from './settings';
import { publicTestExamId } from './public-test';
import { ExternalBoardCredentialError, externalBoardEndpoint, externalBoardFallbackKey, externalBoardProblem, externalBoardSubmission } from './external-board-payload';
import { appendExternalBoardLog } from './external-board-log';
import { externalBoardTransaction } from './external-board-transaction';
import { readNovaJudgeBoard, novaBoardHash } from './novajudge-board';

const SCHEDULER_MS = 1_000;
const LEASE_MS = 60_000;
const BATCH_SIZE = 50;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
class PushStopped extends Error {}
class PushError extends Error {}
const worker = globalThis as typeof globalThis & {
  externalBoardTimer?: ReturnType<typeof setInterval>;
  externalBoardTask?: Promise<void>;
  externalBoardControllers?: Map<string, AbortController>;
};

export function cancelExternalBoardPush(examId: string) {
  worker.externalBoardControllers?.get(examId)?.abort();
}

/** One bounded batch per exam; checkpoints survive restarts and failed POSTs. */
export async function pushExternalBoard(examId: string) {
  const startedAt = Date.now();
  const now = new Date();
  const exam = await prisma.exam.findUnique({ where: { id: examId }, include: {
    problems: { orderBy: { order: 'asc' } },
    candidates: { select: { id: true, examNumber: true }, orderBy: { id: 'asc' } },
  } });
  if (!exam?.externalBoardEnabled || !exam.externalBoardBaseUrl || !exam.externalBoardEventId || exam.id === await publicTestExamId()) return;
  const intervalMs = exam.externalBoardIntervalSeconds * 1000;
  const retryMs = Math.max(intervalMs, 30_000);
  const token = randomUUID();
  const claimed = await externalBoardTransaction(examId, async tx => {
    await tx.externalBoardSync.upsert({ where: { examId }, create: { examId }, update: {} });
    return tx.externalBoardSync.updateMany({ where: {
      examId, exam: { externalBoardEnabled: true, externalBoardBaseUrl: exam.externalBoardBaseUrl, externalBoardEventId: exam.externalBoardEventId, externalBoardApiKey: exam.externalBoardApiKey, externalBoardIntervalSeconds: exam.externalBoardIntervalSeconds },
      AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
    }, data: { leaseToken: token, leaseUntil: new Date(+now + LEASE_MS) } });
  });
  if (!claimed.count) return;
  const controller = new AbortController();
  worker.externalBoardControllers ??= new Map();
  worker.externalBoardControllers.set(examId, controller);
  const ownsLease = { examId, leaseToken: token };
  let problemCount = 0, submissionCount = 0;
  const logTarget = { examId, baseUrl: exam.externalBoardBaseUrl, eventId: exam.externalBoardEventId };
  try {
    const appKey = exam.externalBoardApiKey?.trim() || externalBoardFallbackKey(exam.externalBoardBaseUrl, await getExternalLoginSettings());
    if (!appKey) throw new PushError('请填写推送密钥或在系统设置中配置 CWNUPAA 外部登录密钥，并在官网授予外榜权限');
    const nova = exam.platform === 'NOVAJUDGE' ? await readNovaJudgeBoard(exam, controller.signal, new Set(exam.candidates.map(candidate => candidate.examNumber))) : null;
    const problems = nova ? nova.problems : exam.problems.map(externalBoardProblem);
    const configHash = hash([exam.externalBoardBaseUrl, appKey, exam.externalBoardEventId, exam.startAt, exam.endAt,
      exam.platform, exam.platformBaseUrl, exam.platformContestId, exam.novaJudgeApiKey, exam.novaJudgeTimezone,
      exam.problems.map(p => [p.id, p.order, p.score, p.hydroScore]), exam.candidates]);
    const problemsHash = hash(problems);
    let state = await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId } });
    if (state.leaseToken !== token) throw new PushStopped();
    const reset = state.configHash !== configHash;
    if (reset || !state.scanUntil) {
      // Revisit 30 seconds at each completed scan to cover a concurrent commit.
      const cursorAt = reset || !state.syncedThrough ? null : new Date(+state.syncedThrough - 30_000);
      const updated = await prisma.externalBoardSync.updateMany({ where: ownsLease, data: {
        configHash, ...(reset ? { problemsHash: null, syncedThrough: null } : {}),
        scanUntil: now, cursorAt, cursorId: null,
      } });
      if (!updated.count) throw new PushStopped();
      state = { ...state, configHash, scanUntil: now, cursorAt, cursorId: null,
        ...(reset ? { problemsHash: null, syncedThrough: null } : {}) };
    }

    async function post(kind: 'problems' | 'submissions', items: unknown[]) {
      if (controller.signal.aborted) throw new PushStopped();
      // Recheck the saved switch before EVERY request, including the second
      // request in a tick. No HTTP request runs inside a database transaction.
      const renewed = await externalBoardTransaction(examId, tx => tx.externalBoardSync.updateMany({ where: {
        ...ownsLease, leaseUntil: { gt: new Date() },
        exam: { externalBoardEnabled: true, externalBoardBaseUrl: exam!.externalBoardBaseUrl, externalBoardEventId: exam!.externalBoardEventId, externalBoardApiKey: exam!.externalBoardApiKey, externalBoardIntervalSeconds: exam!.externalBoardIntervalSeconds,
          platform: exam!.platform, platformBaseUrl: exam!.platformBaseUrl, platformContestId: exam!.platformContestId, novaJudgeApiKey: exam!.novaJudgeApiKey, novaJudgeTimezone: exam!.novaJudgeTimezone },
      }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }));
      if (!renewed.count || controller.signal.aborted) throw new PushStopped();
      let response: Response;
      try {
        response = await fetch(externalBoardEndpoint(exam!.externalBoardBaseUrl!, exam!.externalBoardEventId!, kind), {
          method: 'POST', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: appKey, [kind]: items }),
        });
      } catch {
        if (controller.signal.aborted) throw new PushStopped();
        throw new PushError('连接 CWNUPAA 官网失败或超时，后台将自动重试');
      }
      const result = await response.json().catch(() => null);
      // Never persist arbitrary remote messages: they may echo a submitted key.
      if (response.status === 403 || Number(result?.code) === 403) throw new PushError('CWNUPAA 密钥未被授予外榜权限，请在官网接口管理中检查');
      if (!response.ok || Number(result?.code) !== 200) throw new PushError('CWNUPAA 拒绝接收，请检查 API 地址、密钥启用状态及赛事 ID');
      if (kind === 'submissions') {
        const count = typeof result?.data === 'string' ? result.data.match(/^成功处理并保存了 (\d+) 条提交记录$/)?.[1] : undefined;
        if (count === undefined || Number(count) !== items.length) {
          throw new PushError('官网未完整接收提交记录，请检查赛事 ID、报名审核状态及比赛账号是否与考号一致');
        }
      }
      if (kind === 'problems') problemCount += items.length;
      else submissionCount += items.length;
    }

    if (state.problemsHash !== problemsHash && problems.length) {
      await post('problems', problems);
      await prisma.externalBoardSync.updateMany({ where: ownsLease, data: { problemsHash } });
    }
    if (nova) {
      const savedRecords = await prisma.novaJudgeBoardRecord.findMany({ where: { examId }, select: { remoteId: true, payloadHash: true } });
      const previous = new Map(savedRecords.map(record => [record.remoteId, record.payloadHash]));
      const changed = nova.records.map(record => ({ ...record, payloadHash: novaBoardHash([configHash, record.payload]) }))
        .filter(record => previous.get(record.remoteId) !== record.payloadHash);
      const batch: typeof changed = [];
      let bytes = 0;
      for (const record of changed) {
        const size = Buffer.byteLength(JSON.stringify(record.payload));
        if (batch.length >= BATCH_SIZE || (batch.length && bytes + size > 1_000_000)) break;
        batch.push(record); bytes += size;
      }
      if (batch.length) await post('submissions', batch.map(record => record.payload));
      const complete = changed.length === batch.length;
      await externalBoardTransaction(examId, async tx => {
        const saved = await tx.externalBoardSync.updateMany({ where: ownsLease, data: {
          scanUntil: complete ? null : now, syncedThrough: complete ? now : state.syncedThrough,
          lastSuccessAt: new Date(), lastError: null, nextAttemptAt: new Date(Date.now() + intervalMs), leaseToken: null, leaseUntil: null,
        } });
        if (!saved.count) throw new PushStopped();
        for (const record of batch) await tx.novaJudgeBoardRecord.upsert({
          where: { examId_remoteId: { examId, remoteId: record.remoteId } },
          create: { examId, remoteId: record.remoteId, payloadHash: record.payloadHash }, update: { payloadHash: record.payloadHash },
        });
      });
      appendExternalBoardLog({ ...logTarget, status: 'SUCCESS', problemCount, submissionCount, durationMs: Date.now() - startedAt,
        message: complete ? 'NovaJudge 外榜同步完成' : 'NovaJudge 推送成功，剩余记录将在下一次继续推送' });
      return;
    }
    const rows = await prisma.contestSubmission.findMany({ where: {
      examId, createdAt: { gte: exam.startAt, lt: exam.endAt },
      updatedAt: { lt: state.scanUntil! },
      AND: [{ OR: [{ judgeAt: { not: null } }, { status: 30 }, { manualScore: { not: null } }] }],
      ...(state.cursorAt ? { OR: [
        { updatedAt: { gt: state.cursorAt } },
        { updatedAt: state.cursorAt, ...(state.cursorId ? { id: { gt: state.cursorId } } : {}) },
      ] } : {}),
    }, select: {
      id: true, updatedAt: true, status: true, statusText: true, judgeAt: true, score: true, manualScore: true,
      lang: true, code: true, time: true, memory: true, createdAt: true,
      candidate: { select: { examNumber: true } },
      problem: { select: { id: true, order: true, title: true, score: true, hydroScore: true, timeLimitMs: true, memoryLimitMb: true } },
    }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: BATCH_SIZE });
    // Bound request size while preserving a single large submission intact.
    const batch: typeof rows = [];
    const payloads: ReturnType<typeof externalBoardSubmission>[] = [];
    let bytes = 0;
    for (const row of rows) {
      const payload = externalBoardSubmission(row, row.problem, row.candidate);
      const size = Buffer.byteLength(JSON.stringify(payload));
      if (batch.length && bytes + size > 1_000_000) break;
      batch.push(row); payloads.push(payload); bytes += size;
    }
    if (batch.length) await post('submissions', payloads);
    const complete = rows.length < BATCH_SIZE && batch.length === rows.length;
    const last = batch.at(-1);
    const saved = await externalBoardTransaction(examId, tx => tx.externalBoardSync.updateMany({ where: ownsLease, data: {
      ...(last ? { cursorAt: last.updatedAt, cursorId: last.id } : {}),
      ...(complete ? { syncedThrough: state.scanUntil, scanUntil: null, cursorAt: null, cursorId: null } : {}),
      lastSuccessAt: new Date(), lastError: null,
      nextAttemptAt: new Date(Date.now() + intervalMs), leaseToken: null, leaseUntil: null,
    } }));
    if (saved.count) appendExternalBoardLog({
      ...logTarget, status: 'SUCCESS', problemCount, submissionCount, durationMs: Date.now() - startedAt,
      message: problemCount || submissionCount ? `推送成功${complete ? '' : '，剩余记录将在下一次继续推送'}` : '同步检查完成，没有新增或更新的提交记录',
    });
  } catch (error) {
    const stopped = error instanceof PushStopped;
    const message = error instanceof PushError || error instanceof ExternalBoardCredentialError ? error.message : exam.platform === 'NOVAJUDGE' && error instanceof Error
      && /^NovaJudge|^读取 NovaJudge|^请填写 NovaJudge/.test(error.message) ? error.message : '外榜推送失败，后台将自动重试';
    const saved = await externalBoardTransaction(examId, tx => tx.externalBoardSync.updateMany({ where: ownsLease, data: {
      leaseToken: null, leaseUntil: null,
      ...(stopped ? {} : { lastError: message, nextAttemptAt: new Date(Date.now() + retryMs) }),
    } }));
    if (saved.count) appendExternalBoardLog({
      ...logTarget, status: stopped ? 'INFO' : 'ERROR', problemCount, submissionCount, durationMs: Date.now() - startedAt,
      message: stopped ? '本次推送已停止' : `${message}；${retryMs / 1000} 秒后自动重试`,
    });
  } finally {
    if (worker.externalBoardControllers.get(examId) === controller) worker.externalBoardControllers.delete(examId);
  }
}

export async function pushExternalBoards() {
  const exams = await prisma.exam.findMany({ where: {
    externalBoardEnabled: true, externalBoardBaseUrl: { not: null }, externalBoardEventId: { not: null },
    OR: [{ externalBoardSync: null }, { externalBoardSync: { nextAttemptAt: null } },
      { externalBoardSync: { nextAttemptAt: { lte: new Date() } } }],
  }, select: { id: true }, orderBy: { startAt: 'desc' } });
  // Keep external traffic and DB usage bounded even with many enabled exams.
  for (let offset = 0; offset < exams.length; offset += 2) {
    await Promise.allSettled(exams.slice(offset, offset + 2).map(exam => pushExternalBoard(exam.id)));
  }
}

export function triggerExternalBoardPush() {
  if (worker.externalBoardTask) return worker.externalBoardTask;
  const task = pushExternalBoards().catch(() => console.error('External board worker failed; will retry'))
    .finally(() => { if (worker.externalBoardTask === task) delete worker.externalBoardTask; });
  worker.externalBoardTask = task;
  return task;
}

export function requestExternalBoardPush() {
  // A setting change may revoke an active batch. Start again once it has released its resources.
  if (worker.externalBoardTask) void worker.externalBoardTask.then(() => triggerExternalBoardPush());
  else void triggerExternalBoardPush();
}

export function startExternalBoardWorker() {
  if (worker.externalBoardTimer) return;
  worker.externalBoardTimer = setInterval(() => { void triggerExternalBoardPush(); }, SCHEDULER_MS);
  worker.externalBoardTimer.unref();
}
