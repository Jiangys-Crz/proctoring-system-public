import { randomUUID } from 'node:crypto';
import { federationChange } from '@/lib/exam-federation-store';
import { prisma } from './db';
import { judgeStatistics, requestHydroLanguages, submitHydroJudge } from './hydro-contest';
import { resolveJudgeLanguage } from './exam-languages';
import { contestSubmissionStatusSelect, syncContestSubmissionStatuses } from './contest-submission-sync';
import { isPublicTestExam } from './public-test';
import { publicTestJudgeProblem } from './public-test-judge';

async function inChunks<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  for (let index = 0; index < items.length; index += size) {
    await Promise.allSettled(items.slice(index, index + size).map(run));
  }
}

// The database is the durable queue. A lease prevents concurrent web workers
// from sending the same deferred submission while another worker is active.
async function dispatchDeferredSubmissions(examId?: string) {
  const now = new Date();
  const stale = new Date(+now - 60_000);
  const pending = await prisma.contestSubmission.findMany({
    where: { ...(examId ? { examId } : {}), status: { not: 30 }, deferredJudge: true, hydroRecordId: null,
      AND: [
        { OR: [
          { judgeForced: true },
          { problem: { problemType: { notIn: ['objective', 'submit_answer'] } } },
          { problem: { problemType: { in: ['objective', 'submit_answer'] } }, exam: { OR: [
            { contestRule: 'KS' },
            { AND: [{ showObjectiveScore: true }, { contestRule: { notIn: ['OI', 'LANQIAO', 'KS'] } }] },
            { endAt: { lte: now } },
          ] } },
        ] },
        { OR: [{ judgeClaimedAt: null }, { judgeClaimedAt: { lt: stale } }] },
      ] },
    // Scan identities only. A burst of large submissions must not keep 100
    // complete code bodies resident while just eight are being dispatched.
    select: { id: true, problem: { select: { problemType: true } } },
    orderBy: { createdAt: 'asc' }, take: 100,
  });
  const availableLanguages = pending.some(submission => !['objective', 'submit_answer'].includes(submission.problem.problemType))
    ? await requestHydroLanguages().catch(() => []) : [];
  await inChunks(pending, 8, async (item) => {
    // Each batch gets a fresh lease. Reusing the scan timestamp made later
    // batches' leases expire before their Hydro request had even finished.
    const claimedAt = new Date(); const writeToken = randomUUID();
    const claim = await prisma.contestSubmission.updateMany({
      where: { id: item.id, status: { not: 30 }, deferredJudge: true, hydroRecordId: null, OR: [{ judgeClaimedAt: null }, { judgeClaimedAt: { lt: new Date(+claimedAt - 60_000) } }] },
      data: { judgeClaimedAt: claimedAt, federationWriteToken: writeToken },
    });
    if (!claim.count) return;
    try {
      const submission = await prisma.contestSubmission.findFirst({
        where: { id: item.id, status: { not: 30 }, deferredJudge: true, hydroRecordId: null, judgeClaimedAt: claimedAt, federationWriteToken: writeToken },
        select: { id: true, examId: true, lang: true, code: true,
          exam: { select: { platformBaseUrl: true } }, problem: { select: { hydroProblemId: true, problemType: true } } },
      });
      if (!submission) return;
      let judgeLanguage = submission.lang;
      if (!['objective', 'submit_answer'].includes(submission.problem.problemType) && availableLanguages.length) {
        if (!availableLanguages.some((language) => language.id === judgeLanguage)) {
          judgeLanguage = resolveJudgeLanguage(judgeLanguage, availableLanguages.map(language => language.id)) || judgeLanguage;
        }
      }
      const storedPid = Number(submission.problem.hydroProblemId);
      const pid = Number.isSafeInteger(storedPid) && storedPid > 0 ? storedPid
        : await isPublicTestExam(submission.examId) ? await publicTestJudgeProblem(submission.examId) : storedPid;
      const result = await submitHydroJudge(submission.exam, {
        pid, lang: judgeLanguage, code: submission.code,
      });
      await prisma.contestSubmission.updateMany({ where: { id: item.id, status: { not: 30 }, hydroRecordId: null, judgeClaimedAt: claimedAt, federationWriteToken: writeToken }, data: {
        ...federationChange(), judgeForced: false, hydroRecordId: result.id, lang: judgeLanguage, status: result.status, statusText: result.statusText,
        score: result.score, ...judgeStatistics(result.testCases), time: result.time, memory: result.memory,
        testCases: result.testCases as any, subtasks: result.subtasks as any,
        judgeAt: result.judgeAt ? new Date(result.judgeAt) : null,
        deferredJudge: !result.judgeAt, judgeClaimedAt: null, judgeError: null,
      } });
    } catch (error) {
      // Keep the row queued; a later tick retries when Hydro recovers.
      await prisma.contestSubmission.updateMany({ where: { id: item.id, status: { not: 30 }, hydroRecordId: null, judgeClaimedAt: claimedAt, federationWriteToken: writeToken }, data: {
        judgeError: error instanceof Error ? error.message.slice(0, 1000) : '判题失败',
        judgeClaimedAt: new Date(),
      } });
    }
  });
}

type JudgeStatusCursor = { createdAt: Date; id: string };

async function syncPendingContestSubmissions(examId?: string, after?: JudgeStatusCursor) {
  const judging = await prisma.contestSubmission.findMany({
    where: { ...(examId ? { examId } : {}), status: { not: 30 }, hydroRecordId: { not: null }, judgeAt: null,
      ...(after ? { OR: [
        { createdAt: { gt: after.createdAt } },
        { createdAt: after.createdAt, id: { gt: after.id } },
      ] } : {}),
    },
    select: { ...contestSubmissionStatusSelect, createdAt: true, exam: { select: { platformBaseUrl: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200,
  });
  // Local judging uses the system Hydro connection, not historical exam URLs.
  // Splitting this page by those URLs could turn one 200-ID batch into 200
  // concurrent requests to the same Hydro before the old-plugin fallback.
  if (judging.length) await Promise.allSettled([syncContestSubmissionStatuses(judging[0].exam, judging)]);
  // Advance even when older records remain pending. Reset at the end so a
  // stuck first page cannot starve newly accepted submissions or old rejudges.
  const last = judging.at(-1);
  return judging.length === 200 && last ? { createdAt: last.createdAt, id: last.id } : undefined;
}

export async function judgeDeferredSubmissions(examId?: string) {
  await dispatchDeferredSubmissions(examId);
  await syncPendingContestSubmissions(examId);
}

const worker = globalThis as typeof globalThis & {
  deferredJudgeTimer?: ReturnType<typeof setInterval>;
  deferredJudgeTask?: Promise<void>;
  judgeStatusTask?: Promise<void>;
  judgeStatusCursor?: JudgeStatusCursor;
};

// A submission burst and the timer share one scan per process. The database
// leases above still prevent duplicate judging across different processes.
export function triggerDeferredJudge() {
  if (worker.deferredJudgeTask) return worker.deferredJudgeTask;
  const task = dispatchDeferredSubmissions()
    .catch(error => console.error('Deferred exam judge failed', error instanceof Error ? error.message : 'Unknown error'))
    .finally(() => { if (worker.deferredJudgeTask === task) delete worker.deferredJudgeTask; });
  worker.deferredJudgeTask = task;
  return task;
}

export function triggerJudgeStatusSync() {
  if (worker.judgeStatusTask) return worker.judgeStatusTask;
  const task = syncPendingContestSubmissions(undefined, worker.judgeStatusCursor)
    .then(cursor => { worker.judgeStatusCursor = cursor; })
    .catch(error => console.error('Exam judge status sync failed', error instanceof Error ? error.message : 'Unknown error'))
    .finally(() => { if (worker.judgeStatusTask === task) delete worker.judgeStatusTask; });
  worker.judgeStatusTask = task;
  return task;
}

export function startDeferredJudgeWorker() {
  if (worker.deferredJudgeTimer) return;
  // Hydro may be slow to accept a batch; already-running results must continue
  // refreshing independently rather than wait behind the send queue.
  worker.deferredJudgeTimer = setInterval(() => { void triggerDeferredJudge(); void triggerJudgeStatusSync(); }, 1_000);
  worker.deferredJudgeTimer.unref();
}
