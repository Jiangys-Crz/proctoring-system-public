import { z } from 'zod';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { importPublicExam } from '@/lib/platform-sync';
import { FederationError } from '@/lib/exam-federation-protocol';
import { fail, ok, parseBody, RequestParseError } from '@/lib/http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { const user = await requireSuperAdmin(request); const input = await parseBody(request, z.object({ link: z.string().url().max(2048) })); return ok(await importPublicExam(input.link, user.id), { status: 201 }); }
  catch (error) { if (error instanceof AuthError || error instanceof FederationError) return fail(error.message, error.status); if (error instanceof RequestParseError) return fail(error.message, 400); return fail('导入未完成，已保存进度，请重试', 503); }
}
