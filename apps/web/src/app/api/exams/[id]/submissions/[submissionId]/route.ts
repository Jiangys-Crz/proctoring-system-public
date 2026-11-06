import { queueContestRejudge } from '@/lib/contest-rejudge';
import { federationChange } from '@/lib/exam-federation-store';
import { z } from 'zod';
import { requireUser, AuthError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { canManageExam } from '@/lib/permissions';

const ActionSchema = z.object({ action: z.enum(['rejudge', 'ignore']) });

export async function POST(request: Request, context: { params: Promise<{ id: string; submissionId: string }> }) {
  try {
    const user = await requireUser(request);
    const { id, submissionId } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权管理该考试的递交记录', 403);
    const input = await parseBody(request, ActionSchema);
    const submission = await prisma.contestSubmission.findFirst({
      where: { id: submissionId, examId: id },
      include: { exam: { select: { platformBaseUrl: true } }, problem: { select: { hydroProblemId: true, problemType: true } } },
    });
    if (!submission) return fail('递交记录不存在', 404);

    if (input.action === 'ignore') {
      await prisma.contestSubmission.update({
        where: { id: submission.id },
        data: {
          ...federationChange(), judgeForced: false, status: 30,
          statusText: '成绩已取消',
          score: 0,
          deferredJudge: false,
          judgeClaimedAt: null,
          judgeError: null,
          judgeAt: new Date(),
        },
      });
      return ok({ id: submission.id, action: input.action });
    }

    const queued = await queueContestRejudge(id, submission.id);
    if (!queued) return fail('该提交已有重测任务，请等待结果后再操作', 409);
    return ok({ id: submission.id, action: input.action });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
