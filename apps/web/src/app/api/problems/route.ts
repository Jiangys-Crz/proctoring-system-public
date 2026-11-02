import { requireSuperAdmin, AuthError } from '@/lib/auth';
import { requestHydroBridge } from '@/lib/hydro-contest';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { z } from 'zod';

const Schema = z.object({ query: z.string().optional().default(''), limit: z.coerce.number().int().min(1).max(100).optional().default(50) });
export async function GET(request: Request) {
  try {
    await requireSuperAdmin();
    const url = new URL(request.url);
    const data = await requestHydroBridge({ platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' }, '/api/proctor/problems', { query: url.searchParams.get('query') || '', limit: Number(url.searchParams.get('limit') || 100) });
    return ok(data, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) { if (error instanceof AuthError) return fail(error.message, error.status); return fail(toErrorMessage(error), 502); }
}
export async function POST(request: Request) {
  try { await requireSuperAdmin(request); const input = await parseBody(request, Schema); const data = await requestHydroBridge({ platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' }, '/api/proctor/problems', input); return ok(data, { headers: { 'Cache-Control': 'no-store, max-age=0' } }); }
  catch (error) { if (error instanceof AuthError) return fail(error.message, error.status); if (error instanceof RequestParseError) return fail(error.message, 400, error.details); return fail(toErrorMessage(error), 502); }
}
export const OPTIONS = options;
