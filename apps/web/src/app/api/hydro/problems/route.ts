import { z } from 'zod';
import { requireUser, AuthError } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { requestHydroBridge } from '@/lib/hydro-contest';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { acquireProblemSearchSlot, isRequestAdmissionError } from '@/lib/request-admission';

const SearchSchema = z.object({
  examId: z.string().optional(),
  baseUrl: z.string().url().optional(),
  query: z.string().max(1000).optional().default(''),
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
});

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const user = await requireUser(request);
    release = await acquireProblemSearchSlot(request.signal);
    const input = await parseBody(request, SearchSchema, 16 * 1024);
    if (user.role !== 'SUPER_ADMIN' && (!input.examId || !await canManageExam(user, input.examId))) return fail('无权搜索考试题目', 403);
    const baseUrl = input.baseUrl || process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost';
    const result = await requestHydroBridge({ platformBaseUrl: baseUrl }, '/api/proctor/problems', { query: input.query, limit: input.limit });
    return ok(result, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    if (isRequestAdmissionError(error)) {
      const response = fail('题库查询繁忙，请稍后重试', 503);
      response.headers.set('Retry-After', '2');
      return response;
    }
    return fail(toErrorMessage(error), 502);
  } finally { release?.(); }
}

export const OPTIONS = options;
