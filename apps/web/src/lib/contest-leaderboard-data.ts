import { prisma } from './db';
import { IGNORED_SUBMISSION_STATUS } from './contest-rules';
import { admittedLeaderboardDataRead } from './heavy-read-admission';
import { RequestAdmissionError, settleReads } from './request-admission';

async function loadLeaderboardData(examId: string) {
  const [candidates, submissions] = await settleReads([
    prisma.candidate.findMany({ where: { examId }, select: {
      id: true, examNumber: true, name: true, teamName: true, groupName: true,
      school: true, college: true, ranked: true, gender: true, teamMembers: true,
    } }),
    prisma.contestSubmission.findMany({
      where: { examId, status: { not: IGNORED_SUBMISSION_STATUS } },
      select: { id: true, candidateId: true, problemId: true, status: true, score: true, manualScore: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { candidates, submissions };
}

const shared = globalThis as typeof globalThis & { leaderboardDataPending?: Map<string, ReturnType<typeof loadLeaderboardData>> };
const pending = shared.leaderboardDataPending ??= new Map<string, ReturnType<typeof loadLeaderboardData>>();

// Call only after authenticating the current candidate. Concurrent requests
// share the scoring inputs, never an authorized response or a completed cache.
// Visibility, freeze time and historical snapshots are applied by each caller.
export function readContestLeaderboardData(examId: string) {
  const running = pending.get(examId);
  if (running) return running;
  // Bound distinct waiting exams as well as active queries. Same-exam callers
  // still share one pending promise and retain fresh caller authorization.
  if (pending.size >= 128) return Promise.reject(new RequestAdmissionError());
  const task = admittedLeaderboardDataRead(() => loadLeaderboardData(examId)).finally(() => {
    if (pending.get(examId) === task) pending.delete(examId);
  });
  pending.set(examId, task);
  return task;
}
