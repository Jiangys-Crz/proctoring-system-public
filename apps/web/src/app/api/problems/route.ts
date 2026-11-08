import { requireSuperAdmin, AuthError } from '@/lib/auth';
import { requestHydroBridge } from '@/lib/hydro-contest';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { z } from 'zod';
import { acquireProblemSearchSlot, isRequestAdmissionError } from '@/lib/request-admission';

const Schema = z.object({ query: z.string().max(1000).optional().default(''), limit: z.coerce.number().int().min(1).max(100).optional().default(50) });
function searchError(error: unknown) {
  if (error instanceof AuthError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  if (isRequestAdmissionError(error)) {
    const response = fail('题库查询繁忙，请稍后重试', 503);
    response.headers.set('Retry-After', '2');
    return response;
  }
  return fail(toErrorMessage(error), 502);
}
export async function GET(request: Request) {
  let release: (() => void) | undefined;
  try {
    await requireSuperAdmin();
    const url = new URL(request.url);
    const parsed = Schema.safeParse({ query: url.searchParams.get('query') || '', limit: url.searchParams.get('limit') ?? 100 });
    if (!parsed.success) throw new RequestParseError('请求参数不正确', parsed.error.flatten());
    release = await acquireProblemSearchSlot(request.signal);
    const data = await requestHydroBridge({ platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' }, '/api/proctor/problems', parsed.data);
    return ok(data, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) { return searchError(error); }
  finally { release?.(); }
}
export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    await requireSuperAdmin(request);
    release = await acquireProblemSearchSlot(request.signal);
    const input = await parseBody(request, Schema, 16 * 1024);
    const data = await requestHydroBridge({ platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' }, '/api/proctor/problems', input);
    return ok(data, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) { return searchError(error); }
  finally { release?.(); }
}
export const OPTIONS = options;
