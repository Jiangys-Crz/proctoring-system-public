import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { calculateLeaderboards } from '@/lib/leaderboards';
import { canAccessExam, canManageExam } from '@/lib/permissions';
import { fail, ok, options, toErrorMessage } from '@/lib/http';
import { flexibleExam, IGNORED_SUBMISSION_STATUS } from '@/lib/contest-rules';
import { admittedLeaderboardRead } from '@/lib/heavy-read-admission';

async function loadOverview(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const timePoint = new URL(request.url).searchParams.get('timePoint');
    if (timePoint !== null && (!Number.isFinite(Number(timePoint)) || Number(timePoint) < 0 || Number(timePoint) > 8.64e15)) return fail('榜单时间无效', 400);
    const snapshot = new Date(timePoint === null ? Date.now() : Math.min(Date.now(), Number(timePoint)));
    const { id } = await context.params;
    if (!(await canAccessExam(user, id))) return fail('无权查看该考试', 403);
    const manageable = await canManageExam(user, id);
    const candidateScope = manageable ? {} : { rooms: { some: { room: { proctors: { some: { userId: user.id } } } } } };

    const exam = await prisma.exam.findUnique({
      where: { id },
      include: {
        problems: {
          orderBy: { order: 'asc' },
          select: { id: true, order: true, hydroProblemId: true, title: true, problemType: true, hydroScore: true, scorePercent: true, score: true }
        },
        candidates: {
          where: candidateScope,
          orderBy: [{ seatNo: 'asc' }, { examNumber: 'asc' }],
          select: { id: true, examNumber: true, name: true, teamName: true, groupName: true, ranked: true, school: true, college: true, gender: true, teamMembers: true }
        },
        _count: { select: { candidates: { where: candidateScope }, submissions: { where: { candidate: candidateScope } }, problems: true } }
      }
    });
    if (!exam) return fail('考试不存在', 404);

    const submissions = await prisma.contestSubmission.findMany({
      where: { examId: id, candidate: candidateScope, status: { not: IGNORED_SUBMISSION_STATUS } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, candidateId: true, problemId: true, status: true, score: true, manualScore: true, createdAt: true }
    });

    const leaderboard = calculateLeaderboards(
      exam,
      exam.problems,
      exam.candidates,
      submissions,
      snapshot,
      true
    );

    return ok({
      exam: {
        id: exam.id,
        examCode: exam.examCode,
        name: exam.name,
        platform: exam.platform,
        platformBaseUrl: exam.platformBaseUrl,
        platformContestId: exam.platformContestId,
        rules: exam.rules,
        contestRule: exam.contestRule,
        contestType: exam.contestType,
        startAt: exam.startAt,
        latestStartAt: exam.latestStartAt,
        endAt: exam.endAt,
        durationMinutes: exam.durationMinutes,
        flexible: flexibleExam(exam),
        problems: exam.problems,
        participantCount: exam._count.candidates,
        submissionCount: exam._count.submissions
      },
      leaderboard,
      canManage: manageable
    });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return admittedLeaderboardRead(request, () => loadOverview(request, context));
}
