import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const ProblemScoresSchema = z.object({
  problems: z.array(z.object({
    id: z.string().min(1),
    scorePercent: z.coerce.number().int().min(0).max(100)
  })).min(1)
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权管理该考试的题目', 403);
    const input = await parseBody(request, ProblemScoresSchema);
    const current = await prisma.examProblem.findMany({ where: { examId: id, id: { in: input.problems.map(item => item.id) } } });
    if (current.length !== input.problems.length) return fail('部分题目不存在或不属于该考试', 400);
    await prisma.$transaction(input.problems.map(item => {
      return prisma.examProblem.update({
        where: { id: item.id },
        data: { scorePercent: item.scorePercent, score: item.scorePercent }
      });
    }));
    return ok(await prisma.examProblem.findMany({ where: { examId: id }, orderBy: { order: 'asc' } }));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
