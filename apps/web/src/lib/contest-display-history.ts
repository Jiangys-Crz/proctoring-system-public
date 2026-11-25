import type { Prisma, User } from '@prisma/client';
import { AuthError } from './auth';
import { isContestLiveSupported, type ContestLiveData } from './contest-live-contract';
import { prisma } from './db';
import { publicTestExamId } from './public-test';

const chartInterval = 300;
const historySelect = { id: true, name: true, endAt: true, platform: true, contestRule: true } as const;
type HistoryOption = Prisma.ExamGetPayload<{ select: typeof historySelect }>;

function allowedHistory({ id, role }: Pick<User, 'id' | 'role'>): Prisma.ExamWhereInput {
  return role === 'SUPER_ADMIN' ? {} : { OR: [{ createdById: id }, { administrators: { some: { userId: id } } }] };
}

async function historyScope(examId: string): Promise<Prisma.ExamWhereInput> {
  const publicId = await publicTestExamId();
  return { id: { notIn: publicId ? [examId, publicId] : [examId] }, published: true, endAt: { lt: new Date() } };
}

export async function contestDisplayHistoryOptions(examId: string, user: Pick<User, 'id' | 'role'>) {
  const candidates = await prisma.exam.findMany({ where: { AND: [await historyScope(examId), allowedHistory(user)] },
    select: historySelect, orderBy: [{ endAt: 'desc' }, { id: 'asc' }], take: 100 });
  return candidates.filter(row => isContestLiveSupported(row.platform, row.contestRule))
    .map(row => ({ id: row.id, name: row.name, endAt: row.endAt.toISOString() }));
}

export async function validateContestDisplayHistory(examId: string, ids: string[], user: Pick<User, 'id' | 'role'>) {
  if (!ids.length) return;
  const candidates = await availableContestDisplayHistory(examId, ids, allowedHistory(user));
  if (candidates.length !== ids.length) throw new AuthError('只能选择你管理的、已发布且已结束的历史赛事', 400);
}

export async function availableContestDisplayHistory(examId: string, ids: string[], access: Prisma.ExamWhereInput = {}) {
  if (!ids.length) return [];
  const rows = await prisma.exam.findMany({ where: { AND: [await historyScope(examId), access, { id: { in: ids } }] }, select: historySelect });
  const byId = new Map(rows.filter(row => isContestLiveSupported(row.platform, row.contestRule)).map(row => [row.id, row]));
  return ids.flatMap(id => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

const accepted = (run: ContestLiveData['timeline'][number]) => run.firstBlood || /^(?:accepted|ac|ok|通过|正确|答案正确)$/i.test(run.verdict?.trim() ?? '');

export function contestFirstSolution(data: ContestLiveData) {
  for (const run of data.timeline) {
    if (!run.verdict) break;
    if (accepted(run)) return { teamId: run.teamId, seconds: run.seconds };
  }
  return null;
}

export function buildContestDisplayHistory(current: ContestLiveData, past: { contest: HistoryOption; data: ContestLiveData }[], cutoff: string | null) {
  const duration = Math.max(0, (Date.parse(cutoff || current.exam.endAt) - Date.parse(current.exam.startAt)) / 1000);
  const size = Math.max(1, Math.min(2880, Math.floor(duration / chartInterval)));
  function buckets(data: ContestLiveData) {
    const output = new Array<number>(size).fill(0);
    for (const run of data.timeline) {
      if (run.seconds >= duration) break;
      if (accepted(run)) output[Math.min(size - 1, Math.floor(run.seconds / chartInterval))]++;
    }
    for (let at = 1; at < size; at++) output[at] += output[at - 1];
    return output;
  }
  const last = current.timeline.at(-1)?.seconds ?? -1;
  return {
    past: past.map(({ contest, data }) => ({ label: contest.name, values: buckets(data) })),
    current: buckets(current).map((value, index) => index <= Math.floor(last / chartInterval) ? value : null),
  };
}
