import type { Candidate, ClientSession, Exam, ExamProblem } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { requireClientSession } from '@/lib/client-auth';
import { effectiveEnd } from './contest-rules';
import { canViewTeamSubmissions } from './contest-format';
import { prisma } from './db';
import { isPublicTestExam } from './public-test';

export type ContestSession = ClientSession & { exam: Exam & { problems: ExamProblem[] }; candidate: Candidate };
export type ContestSummarySession = ClientSession & { exam: Exam & { problems: Array<Pick<ExamProblem,
  'id' | 'order' | 'title' | 'scorePercent' | 'problemType' | 'score' | 'hydroScore' | 'updatedAt'>> }; candidate: Candidate };
export async function requireContestSession<T extends boolean = false>(request: Request, sessionId: string, summaryOnly?: T, allowExternal = false) {
  const authorized = await requireClientSession(request, sessionId, 'DESKTOP', summaryOnly ? 'contest-summary' : true);
  if (!authorized.ok) return authorized;
  const session = authorized.session as T extends true ? ContestSummarySession : ContestSession;
  if (session.exam.platform === 'NOVAJUDGE' && !allowExternal) return { ok: false as const, status: 403, message: '本场考试请在 NovaJudge 中答题，监考客户端需要支持 NovaJudge 的版本' };
  if (!session.approvedAt || !['APPROVED', 'IN_EXAM', 'LOCKED', 'FINISHED'].includes(session.status)) return { ok: false as const, status: 403, message: '当前会话不可访问考试' };
  if (session.exam.platformContestId === 'local' && !session.exam.published) return { ok: false as const, status: 403, message: '考试尚未发布' };
  session.startedAt = session.candidate.startedAt || session.startedAt;
  return { ok: true as const, session };
}
export function proctorSessionEndAt(session: { startedAt?: Date | null; candidate?: { startedAt?: Date | null }; exam: Exam }) {
  return effectiveEnd(session.exam, session.candidate?.startedAt || session.startedAt);
}

type SubmissionScopeSession = {
  exam: Pick<Exam, 'id' | 'contestRule' | 'contestType' | 'teamAccountMode' | 'allowTeamSubmissionView'>;
  candidate: Pick<Candidate, 'id' | 'teamName'>;
};

export async function contestSubmissionWhere(session: SubmissionScopeSession): Promise<Prisma.ContestSubmissionWhereInput> {
  const { exam, candidate } = session;
  const own = { examId: exam.id, candidateId: candidate.id };
  if (!canViewTeamSubmissions(exam) || !candidate.teamName?.trim()) return own;
  if (await isPublicTestExam(exam.id)) return own;

  // Use current membership within this exam, never a historical submission's
  // teamName/actorKey. MySQL's collation may ignore case/accents, so verify exact
  // names before granting access. Shared accounts already own all their rows.
  const members = await prisma.candidate.findMany({
    where: { examId: exam.id, teamName: candidate.teamName },
    select: { id: true, teamName: true },
  });
  const ids = [...new Set([candidate.id, ...members.filter(member => member.teamName === candidate.teamName).map(member => member.id)])];
  return ids.length === 1 ? own : { examId: exam.id, candidateId: { in: ids } };
}
