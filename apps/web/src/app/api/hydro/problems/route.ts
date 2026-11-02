import { z } from 'zod';
import { requireUser, AuthError } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { requestHydroBridge } from '@/lib/hydro-contest';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const SearchSchema = z.object({
  examId: z.string().optional(),
  baseUrl: z.string().url().optional(),
  query: z.string().optional().default(''),
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const input = await parseBody(request, SearchSchema);
    if (user.role !== 'SUPER_ADMIN' && (!input.examId || !await canManageExam(user, input.examId))) return fail('无权搜索考试题目', 403);
    const baseUrl = input.baseUrl || process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost';
    const result = await requestHydroBridge({ platformBaseUrl: baseUrl }, '/api/proctor/problems', { query: input.query, limit: input.limit });
    return ok(result, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
