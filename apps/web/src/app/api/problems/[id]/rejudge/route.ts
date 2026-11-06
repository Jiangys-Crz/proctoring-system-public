import { requireSuperAdmin, AuthError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { judgeStatistics, submitHydroJudge } from '@/lib/hydro-contest';
import { fail, ok, toErrorMessage } from '@/lib/http';
import { createRequestAdmission, isRequestAdmissionError } from '@/lib/request-admission';

const shared = globalThis as typeof globalThis & { problemRejudgeAdmission?: ReturnType<typeof createRequestAdmission> };
const acquire = shared.problemRejudgeAdmission ??= createRequestAdmission(1, 0, 1000);

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
  let release: (() => void) | undefined;
  try {
    await requireSuperAdmin(_request);
    release = await acquire(_request.signal);
    const { id } = await context.params;
    const records = await prisma.problemSubmission.findMany({
      where: { problemId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, hydroRecordId: true },
    });
    const results: Array<{ id: string; ok: boolean; message?: string }> = [];
    for (const item of records) {
      try {
        // Keep one code body resident, and skip a run replaced since the scan.
        const record = await prisma.problemSubmission.findFirst({
          where: { id: item.id, problemId: id, hydroRecordId: item.hydroRecordId },
          select: { id: true, hydroRecordId: true, lang: true, code: true },
        });
        if (!record) throw new Error('该提交已删除或被其他重测替换，请刷新后重试');
        const remote = await resubmitWithRetry(id, record.lang, record.code);
        const stats = judgeStatistics(remote.testCases);
        const changed = await prisma.problemSubmission.updateMany({
          where: { id: record.id, hydroRecordId: record.hydroRecordId },
          data: {
            hydroRecordId: remote.id,
            lang: remote.lang || record.lang,
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
        if (!changed.count) throw new Error('该提交已删除或被其他重测替换，迟到结果未写入');
        results.push({ id: item.id, ok: true });
      } catch (error) {
        results.push({ id: item.id, ok: false, message: toErrorMessage(error) });
      }
      // Hydro applies a global burst limit; preserving order and pacing keeps a
      // whole-problem rejudge from failing partway through.
      await wait(300);
    }
    return ok({ total: records.length, completed: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length, results });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (isRequestAdmissionError(error)) { const response = fail('题库重测正在执行，请稍后重试', 503); response.headers.set('Retry-After', '3'); return response; }
    return fail(toErrorMessage(error), 502);
  } finally { release?.(); }
}
