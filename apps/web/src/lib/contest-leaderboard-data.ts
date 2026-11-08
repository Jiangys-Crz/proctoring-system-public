import { prisma } from './db';
import { IGNORED_SUBMISSION_STATUS } from './contest-rules';
import { calculateLeaderboards } from './leaderboards';
import { admittedLeaderboardDataRead } from './heavy-read-admission';
import { RequestAdmissionError } from './request-admission';
import { digest } from './exam-federation-protocol';

async function loadLeaderboardData(examId: string) {
  return prisma.$transaction(async tx => {
    // Rules, points, candidates and results must belong to the same snapshot.
    const exam = await tx.exam.findUniqueOrThrow({ where: { id: examId }, select: {
      id: true, startAt: true, latestStartAt: true, endAt: true, durationMinutes: true, contestRule: true, flexible: true,
      contestType: true, published: true, showObjectiveScore: true, scoreboardFrozenAt: true,
      problems: { select: { id: true, order: true, score: true, hydroScore: true, problemType: true }, orderBy: { order: 'asc' } },
    } });
    const candidates = await tx.candidate.findMany({ where: { examId }, select: {
      id: true, examNumber: true, name: true, teamName: true, groupName: true,
      school: true, college: true, advisor: true, ranked: true, gender: true, teamMembers: true, memberOrder: true, isTeamLeader: true,
    } });
    const submissions = await tx.contestSubmission.findMany({
      where: { examId, status: { not: IGNORED_SUBMISSION_STATUS } },
      select: { id: true, candidateId: true, problemId: true, status: true, score: true, manualScore: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { exam, candidates, submissions, capturedAt: new Date() };
  }, { isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 15_000 });
}
type Data = Awaited<ReturnType<typeof loadLeaderboardData>>;
type Policy = Data['exam'];
export function contestLeaderboardPolicy(exam: Policy) {
  return digest({ startAt: exam.startAt, latestStartAt: exam.latestStartAt, endAt: exam.endAt,
    durationMinutes: exam.durationMinutes, contestRule: exam.contestRule, flexible: exam.flexible, contestType: exam.contestType,
    published: exam.published, showObjectiveScore: exam.showObjectiveScore, scoreboardFrozenAt: exam.scoreboardFrozenAt,
    problems: exam.problems.map(problem => ({ id: problem.id, order: problem.order, score: problem.score, hydroScore: problem.hydroScore, problemType: problem.problemType })),
  });
}
type Entry = { promise: Promise<Data>; rows: number; expiresAt: number; timer?: ReturnType<typeof setTimeout> };
const shared = globalThis as typeof globalThis & { leaderboardSnapshots?: { entries: Map<string, Entry>; rows: number } };
const state = shared.leaderboardSnapshots ??= { entries: new Map<string, Entry>(), rows: 0 };
const MAX_CACHED_ROWS = 100_000;

/** Authorization remains fresh per request. Share a short scoring snapshot,
 * with a row/cell budget so many distinct exams cannot grow a cache unboundedly. */
export function readContestLeaderboardData(examId: string, expectedPolicy: Policy) {
  const policy = contestLeaderboardPolicy(expectedPolicy), key = `${examId}:${policy}`;
  const existing = state.entries.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;
  if (existing) { state.entries.delete(key); state.rows -= existing.rows; clearTimeout(existing.timer); }
  if (state.entries.size >= 128) return Promise.reject(new RequestAdmissionError());
  const entry: Entry = { promise: undefined as unknown as Promise<Data>, rows: 0, expiresAt: Infinity };
  const remove = () => {
    if (state.entries.get(key) !== entry) return;
    state.entries.delete(key); state.rows -= entry.rows; clearTimeout(entry.timer);
  };
  entry.promise = admittedLeaderboardDataRead(() => loadLeaderboardData(examId)).then(data => {
    // A cache built with older visibility/points must not override fresh authorization.
    if (contestLeaderboardPolicy(data.exam) !== policy) { remove(); throw new RequestAdmissionError(); }
    const rows = data.candidates.length + data.submissions.length + data.candidates.length * data.exam.problems.length;
    if (rows + state.rows > MAX_CACHED_ROWS) remove();
    else {
      entry.rows = rows; state.rows += rows;
      entry.expiresAt = Date.now() + 500;
      entry.timer = setTimeout(remove, 500); entry.timer.unref?.();
    }
    return data;
  }).catch(error => { remove(); throw error; });
  state.entries.set(key, entry);
  return entry.promise;
}
const calculations = new WeakMap<Data, { live?: ReturnType<typeof calculateLeaderboards> }>();
export function calculateContestLeaderboard(data: Data, timePoint?: number) {
  const previous = calculations.get(data);
  if (timePoint === undefined && previous?.live) return previous.live;
  const now = timePoint === undefined ? data.capturedAt : new Date(Math.min(+data.capturedAt, timePoint));
  const objectiveIds = new Set(data.exam.problems.filter(p => p.problemType === 'objective').map(p => p.id));
  const visible = now >= data.exam.endAt || data.exam.showObjectiveScore ? data.submissions : data.submissions.filter(row => !objectiveIds.has(row.problemId));
  const result = calculateLeaderboards(data.exam, data.exam.problems, data.candidates, visible, now);
  if (timePoint === undefined) calculations.set(data, { live: result });
  return result;
}
