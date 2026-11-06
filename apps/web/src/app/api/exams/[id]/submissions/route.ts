import { queueContestRejudge } from '@/lib/contest-rejudge';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, ok, options, toErrorMessage } from '@/lib/http';
import { IGNORED_SUBMISSION_STATUS, scaledSubmissionScore } from '@/lib/contest-rules';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权查看该考试的递交记录', 403);
    const exam = await prisma.exam.findUnique({ where: { id }, select: { id: true, platformBaseUrl: true, contestRule: true } });
    if (!exam) return fail('考试不存在', 404);

    // The judge worker refreshes pending records independently. List polling
    // must stay available when Hydro is slow and must not reread all code twice.
    const submissions = await prisma.contestSubmission.findMany({
      where: { examId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        candidate: { select: { examNumber: true, name: true, teamName: true } },
        problem: { select: { order: true, hydroProblemId: true, title: true, problemType: true, hydroScore: true, scorePercent: true, score: true } }
      }
    });
    return ok(submissions.map(submission => ({
      ...submission,
      score: scaledSubmissionScore(exam.contestRule, submission.score, submission.problem.score, submission.problem.hydroScore)
    })));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(_request);
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权重测该考试的递交记录', 403);
    const exam = await prisma.exam.findUnique({ where: { id }, select: { id: true, platformBaseUrl: true } });
    if (!exam) return fail('考试不存在', 404);
    const queued = await queueContestRejudge(id);
    return ok({ total: queued, queued, completed: 0, failed: 0, results: [] });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
