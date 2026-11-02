import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireSuperAdmin, requireUser } from '@/lib/auth';
import { canAccessExam } from '@/lib/permissions';
import { requestHydroProblem } from '@/lib/hydro-contest';
import { getHydroSettings } from '@/lib/settings';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { problemLimits } from '@/lib/problem-limits';
import { problemFullScore } from '@/lib/problem-score';

const ImportProblemsSchema = z.object({
  problemIds: z.array(z.string().trim().min(1)).min(1).max(200),
  scorePercents: z.array(z.coerce.number().int().min(1).max(1000)).optional(),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!(await canAccessExam(user, id))) return fail('无权查看该考试', 403);
    const problems = await prisma.examProblem.findMany({ where: { examId: id }, orderBy: { order: 'asc' } });
    return ok(problems);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin(request);
    const { id } = await context.params;
    const input = await parseBody(request, ImportProblemsSchema);
    const exam = await prisma.exam.findUnique({ where: { id } });
    if (!exam) return fail('考试不存在', 404);
    const hydroSettings = await getHydroSettings();
    const imported = [];
    for (const [index, problemId] of input.problemIds.entries()) {
      const hydro = await requestHydroProblem({ platformBaseUrl: exam.platformBaseUrl }, problemId);
      const config = hydro.config && typeof hydro.config === 'object' ? hydro.config : {};
      const limits = problemLimits(config as Record<string, unknown>);
      const languages = Array.isArray((config as { langs?: unknown }).langs) ? (config as { langs: unknown[] }).langs.filter((item): item is string => typeof item === 'string') : [];
      const existing = await prisma.examProblem.findFirst({ where: { examId: id, hydroDomain: hydroSettings.problemDomainId, hydroProblemId: String(hydro.id || problemId) } });
      const hydroScore = problemFullScore(hydro) ?? 100;
      const scorePercent = input.scorePercents?.[index] || 100;
      const data = {
        order: existing?.order ?? index,
        hydroDomain: hydroSettings.problemDomainId,
        hydroProblemId: String(hydro.id || problemId),
        title: hydro.title || `题目 ${index + 1}`,
        content: hydro.content || '',
        html: Boolean(hydro.html),
        problemType: String((config as { type?: unknown }).type || 'default'),
        config: config as any,
        hydroScore,
        scorePercent,
        score: scorePercent,
        timeLimitMs: limits.timeLimitMs,
        memoryLimitMb: limits.memoryLimitMb,
        languages: languages as any,
        files: (hydro.files || []) as any,
      };
      const saved = existing
        ? await prisma.examProblem.update({ where: { id: existing.id }, data })
        : await prisma.examProblem.create({ data: { ...data, examId: id } });
      imported.push(saved);
    }
    await prisma.exam.update({ where: { id }, data: { published: true } });
    return ok(imported, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
