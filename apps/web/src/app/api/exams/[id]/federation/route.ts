import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { configureFederation, federationState, FederationSettingsSchema } from '@/lib/exam-federation';
import { FederationError } from '@/lib/exam-federation-protocol';
import { fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await context.params;
    if (!await canManageExam(user, id)) return fail('无权查看该考试的同步设置', 403);
    return ok(await federationState(id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof FederationError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id } = await context.params;
    if (!await canManageExam(user, id)) return fail('无权修改该考试的同步设置', 403);
    const input = await parseBody(request, FederationSettingsSchema, 4096);
    return ok(await configureFederation(id, input), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof FederationError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}
