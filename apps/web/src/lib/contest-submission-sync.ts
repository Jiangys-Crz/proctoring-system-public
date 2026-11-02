import type { Exam, Prisma } from '@prisma/client';
import { prisma } from './db';
import {
  judgeStatistics,
  HydroRequestError,
  requestHydroJudgeStatus,
  requestHydroJudgeStatuses,
  type HydroRecordPayload,
} from './hydro-contest';

export const contestSubmissionStatusSelect = {
  id: true, hydroRecordId: true, judgeAt: true, status: true,
  statusText: true, score: true, totalTestCases: true, passedTestCases: true,
  time: true, memory: true, testCases: true, subtasks: true,
  deferredJudge: true, judgeClaimedAt: true, judgeError: true,
} satisfies Prisma.ContestSubmissionSelect;

type SubmissionStatus = Prisma.ContestSubmissionGetPayload<{ select: typeof contestSubmissionStatusSelect }>;
type PendingSubmission = Pick<SubmissionStatus, 'id' | 'hydroRecordId' | 'judgeAt' | 'status'> & Partial<SubmissionStatus>;

// Admin refreshes and the worker can overlap. Share work for the same remote
// record; never let stale responses race a rejudge to overwrite newer results.
const inFlight = new Map<string, Promise<void>>();

function updateData(result: HydroRecordPayload) {
  return {
    status: result.status,
    statusText: result.statusText,
    score: result.score,
    ...judgeStatistics(result.testCases),
    time: result.time,
    memory: result.memory,
    testCases: result.testCases as any,
    subtasks: result.subtasks as any,
    judgeAt: result.judgeAt ? new Date(result.judgeAt) : null,
    deferredJudge: !result.judgeAt,
    judgeClaimedAt: null,
    judgeError: null,
  };
}

export async function syncContestSubmissionStatuses(
  exam: Pick<Exam, 'platformBaseUrl'>,
  submissions: PendingSubmission[],
) {
  const pending = submissions.filter((submission) => submission.status !== 30 && submission.hydroRecordId && !submission.judgeAt).slice(0, 200);
  if (!pending.length) return;
  const key = (submission: PendingSubmission) => JSON.stringify([exam.platformBaseUrl, submission.id, submission.hydroRecordId]);
  const waiting = new Set<Promise<void>>();
  const fresh = pending.filter(submission => {
    const running = inFlight.get(key(submission));
    if (running) waiting.add(running);
    return !running;
  });
  if (fresh.length) {
    const task = syncPending(exam, fresh).finally(() => {
      for (const submission of fresh) {
        if (inFlight.get(key(submission)) === task) inFlight.delete(key(submission));
      }
    });
    for (const submission of fresh) inFlight.set(key(submission), task);
    waiting.add(task);
  }
  await Promise.all(waiting);
}

async function syncPending(exam: Pick<Exam, 'platformBaseUrl'>, pending: PendingSubmission[]) {
  const ids = [...new Set(pending.map(submission => submission.hydroRecordId!))];
  let results: HydroRecordPayload[];
  try {
    results = await requestHydroJudgeStatuses(exam, ids);
  } catch (error) {
    // Only an absent batch endpoint indicates an older plugin. A timeout,
    // overload, auth failure or 5xx must not fan out into 200 more requests.
    if (!(error instanceof HydroRequestError) || ![404, 405].includes(error.status)) throw error;
    results = [];
    for (let index = 0; index < ids.length; index += 5) {
      const settled = await Promise.allSettled(ids.slice(index, index + 5).map(id => requestHydroJudgeStatus(exam, id)));
      results.push(...settled.flatMap(item => item.status === 'fulfilled' ? [item.value] : []));
      // Stop probing an old plugin when its individual endpoint is unavailable.
      if (settled.every(item => item.status === 'rejected')) break;
    }
  }
  const resultById = new Map(results.map(result => [result.id, result]));
  for (let index = 0; index < pending.length; index += 5) {
    await Promise.all(pending.slice(index, index + 5).map(async submission => {
      const result = resultById.get(submission.hydroRecordId!);
      if (!result) return;
      const data = updateData(result);
      const unchanged = submission.status === data.status && submission.statusText === data.statusText
        && submission.score === data.score && submission.totalTestCases === data.totalTestCases
        && submission.passedTestCases === data.passedTestCases && submission.time === data.time
        && submission.memory === data.memory && Number(submission.judgeAt) === Number(data.judgeAt)
        && submission.deferredJudge === data.deferredJudge && !submission.judgeClaimedAt && !submission.judgeError
        && JSON.stringify(submission.testCases) === JSON.stringify(data.testCases)
        && (data.subtasks === undefined || JSON.stringify(submission.subtasks) === JSON.stringify(data.subtasks));
      if (unchanged) return;
      await prisma.contestSubmission.updateMany({
        where: { id: submission.id, hydroRecordId: submission.hydroRecordId, judgeAt: null, status: { not: 30 } },
        data,
      });
    }));
  }
}
