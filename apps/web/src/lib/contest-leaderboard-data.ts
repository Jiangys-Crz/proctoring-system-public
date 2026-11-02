import { prisma } from './db';
import { IGNORED_SUBMISSION_STATUS } from './contest-rules';

async function loadLeaderboardData(examId: string) {
  const [candidates, submissions] = await Promise.all([
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

const pending = new Map<string, ReturnType<typeof loadLeaderboardData>>();

// Call only after authenticating the current candidate. Concurrent requests
// share the scoring inputs, never an authorized response or a completed cache.
// Visibility, freeze time and historical snapshots are applied by each caller.
export function readContestLeaderboardData(examId: string) {
  const running = pending.get(examId);
  if (running) return running;
  const task = loadLeaderboardData(examId).finally(() => {
    if (pending.get(examId) === task) pending.delete(examId);
  });
  pending.set(examId, task);
  return task;
}
