import { assertFederationDefinitionMutable } from '@/lib/exam-federation-contract';
import { problemLabel } from '@/lib/contest-rules';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const ProblemScoresSchema = z.object({
  problems: z.array(z.object({
    id: z.string().min(1),
    score: z.coerce.number().int().min(0).max(100000),
    label: z.string().trim().min(1).max(6).regex(/^[^\s/\\\u0000-\u001f]+$/)
  })).min(1)
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权管理该考试的题目', 403);
    const input = await parseBody(request, ProblemScoresSchema);
    await prisma.$transaction(async tx => {
      await assertFederationDefinitionMutable(tx, id);
      const current = await tx.examProblem.findMany({ where: { examId: id } });
      const requested = new Map(input.problems.map(item => [item.id, item]));
      if (requested.size !== input.problems.length || input.problems.some(item => !current.some(row => row.id === item.id))) throw new RequestParseError('部分题目不存在、重复或不属于该考试');
      const labels = current.map(row => (requested.get(row.id)?.label || row.label || problemLabel(row.order)).toUpperCase());
      if (new Set(labels).size !== labels.length) throw new RequestParseError('题号不能与本场其他题目重复');
      for (const item of input.problems) await tx.examProblem.update({
        where: { id: item.id },
        data: { scorePercent: item.score, score: item.score, label: item.label }
      });
    });
    return ok(await prisma.examProblem.findMany({ where: { examId: id }, orderBy: { order: 'asc' } }));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
