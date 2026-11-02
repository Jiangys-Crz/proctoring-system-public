import { requireSuperAdmin, AuthError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { judgeStatistics, submitHydroJudge } from '@/lib/hydro-contest';
import { fail, ok, toErrorMessage } from '@/lib/http';

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function isRateLimitError(error: unknown) {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('too frequent') || message.includes('rate limit') || message.includes('429');
}

async function resubmitWithRetry(problemId: string, lang: string, code: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await submitHydroJudge(
        { platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' },
        { pid: Number(problemId), lang, code },
      );
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === 2) throw error;
      await wait(1_000 * (attempt + 1));
    }
  }
  throw lastError;
}

/** Rejudge every locally stored submission for a problem in chronological order. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin(_request);
    const { id } = await context.params;
    const records = await prisma.problemSubmission.findMany({
      where: { problemId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const results: Array<{ id: string; ok: boolean; message?: string }> = [];
    for (const record of records) {
      try {
        const remote = await resubmitWithRetry(id, record.lang, record.code);
        const stats = judgeStatistics(remote.testCases);
        await prisma.problemSubmission.update({
          where: { id: record.id },
          data: {
            hydroRecordId: remote.id,
            status: remote.status || 0,
            statusText: remote.statusText || 'Waiting',
            score: remote.score || 0,
            totalTestCases: stats.totalTestCases,
            passedTestCases: stats.passedTestCases,
            time: remote.time || 0,
            memory: remote.memory || 0,
            testCases: remote.testCases as any,
            subtasks: remote.subtasks as any,
            judgeAt: remote.judgeAt ? new Date(remote.judgeAt) : null,
          },
        });
        results.push({ id: record.id, ok: true });
      } catch (error) {
        results.push({ id: record.id, ok: false, message: toErrorMessage(error) });
      }
      // Hydro applies a global burst limit; preserving order and pacing keeps a
      // whole-problem rejudge from failing partway through.
      await wait(300);
    }
    return ok({ total: records.length, completed: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length, results });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}
