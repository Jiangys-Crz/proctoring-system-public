import { z } from 'zod';
import { requireUser, AuthError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { resolveJudgeLanguage } from '@/lib/exam-languages';
import { judgeStatistics, requestHydroLanguages, submitHydroJudge } from '@/lib/hydro-contest';
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
          status: 30,
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

    let judgeLanguage = submission.lang;
    if (!['objective', 'submit_answer'].includes(submission.problem.problemType)) {
      const availableLanguages = await requestHydroLanguages().catch(() => []);
      if (availableLanguages.length && !availableLanguages.some(language => language.id === judgeLanguage)) {
          judgeLanguage = resolveJudgeLanguage(judgeLanguage, availableLanguages.map(language => language.id)) || judgeLanguage;
      }
    }
    const result = await submitHydroJudge(submission.exam, {
      pid: Number(submission.problem.hydroProblemId),
      lang: judgeLanguage,
      code: submission.code,
    });
    await prisma.contestSubmission.update({
      where: { id: submission.id },
      data: {
        hydroRecordId: result.id,
        lang: judgeLanguage,
        status: result.status,
        statusText: result.statusText,
        score: result.score,
        ...judgeStatistics(result.testCases),
        time: result.time,
        memory: result.memory,
        testCases: result.testCases as any,
        subtasks: result.subtasks as any,
        judgeAt: result.judgeAt ? new Date(result.judgeAt) : null,
        deferredJudge: !result.judgeAt,
        judgeClaimedAt: null,
        judgeError: null,
      },
    });
    return ok({ id: submission.id, action: input.action });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
