import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, ok, options, toErrorMessage } from '@/lib/http';
import { resolveJudgeLanguage } from '@/lib/exam-languages';
import { judgeStatistics, requestHydroLanguages, submitHydroJudge } from '@/lib/hydro-contest';
import { IGNORED_SUBMISSION_STATUS, scaledSubmissionScore } from '@/lib/contest-rules';

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function isRateLimitError(error: unknown) {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('too frequent') || message.includes('rate limit') || message.includes('429');
}

async function submitWithRetry(exam: { platformBaseUrl: string }, pid: number, lang: string, code: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await submitHydroJudge(exam, { pid, lang, code });
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === 2) throw error;
      await wait(1_000 * (attempt + 1));
    }
  }
  throw lastError;
}

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
    const submissions = await prisma.contestSubmission.findMany({
      where: { examId: id, status: { not: IGNORED_SUBMISSION_STATUS } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { problem: { select: { hydroProblemId: true, problemType: true } } },
    });
    const availableLanguages = await requestHydroLanguages().catch(() => []);
    const results: Array<{ id: string; ok: boolean; message?: string }> = [];
    for (const submission of submissions) {
      try {
        let judgeLanguage = submission.lang;
        if (!['objective', 'submit_answer'].includes(submission.problem.problemType)
          && availableLanguages.length
          && !availableLanguages.some(language => language.id === judgeLanguage)) {
          judgeLanguage = resolveJudgeLanguage(judgeLanguage, availableLanguages.map(language => language.id)) || judgeLanguage;
        }
        const remote = await submitWithRetry(exam, Number(submission.problem.hydroProblemId), judgeLanguage, submission.code);
        await prisma.contestSubmission.update({
          where: { id: submission.id },
          data: {
            hydroRecordId: remote.id,
            lang: judgeLanguage,
            status: remote.status,
            statusText: remote.statusText,
            score: remote.score,
            ...judgeStatistics(remote.testCases),
            time: remote.time,
            memory: remote.memory,
            testCases: remote.testCases as any,
            subtasks: remote.subtasks as any,
            judgeAt: remote.judgeAt ? new Date(remote.judgeAt) : null,
            deferredJudge: !remote.judgeAt,
            judgeClaimedAt: null,
            judgeError: null,
            // manualScore and manualScoreUpdatedAt are intentionally preserved.
          },
        });
        results.push({ id: submission.id, ok: true });
      } catch (error) {
        results.push({ id: submission.id, ok: false, message: toErrorMessage(error) });
      }
      await wait(300);
    }
    return ok({
      total: submissions.length,
      completed: results.filter(result => result.ok).length,
      failed: results.filter(result => !result.ok).length,
      results,
    });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
