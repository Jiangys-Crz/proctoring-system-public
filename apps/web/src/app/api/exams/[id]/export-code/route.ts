import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, toErrorMessage } from '@/lib/http';
import { acquireCodeExport, prepareCodeExport, streamCodeExport } from '@/lib/code-export';
import { isRequestAdmissionError } from '@/lib/request-admission';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let release: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权导出该考试代码', 403);
    release = await acquireCodeExport(request.signal);
    signal = AbortSignal.any([request.signal, AbortSignal.timeout(10 * 60_000)]);
    const exam = await prisma.exam.findUnique({ where: { id }, select: { examCode: true, name: true } });
    if (!exam) return fail('考试不存在', 404);
    if (request.method === 'HEAD') return new Response(null, { headers: {
      'content-type': 'application/zip', 'content-disposition': `attachment; filename="exam-${exam.examCode}-codes.zip"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    } });
    const prepared = await prepareCodeExport(id, signal);
    signal.throwIfAborted();
    const body = streamCodeExport(prepared, exam, signal, release);
    // The stream owns the slot until close and pending source reads settle.
    release = undefined;
    try {
      return new Response(body, { headers: {
        'content-type': 'application/zip', 'content-disposition': `attachment; filename="exam-${exam.examCode}-codes.zip"`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      } });
    } catch (error) { await body.cancel().catch(() => {}); throw error; }
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (isRequestAdmissionError(error)) { const response = fail('代码导出服务繁忙，请稍后重试', 503); response.headers.set('Retry-After', '5'); return response; }
    if (request.signal.aborted) return fail('代码导出已取消', 408);
    if (signal?.aborted) return fail('代码导出超时，请重试', 504);
    return fail(toErrorMessage(error), 500);
  } finally { release?.(); }
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) { return GET(request, context); }
