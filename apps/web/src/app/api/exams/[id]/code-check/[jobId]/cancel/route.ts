import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, ok, options, toErrorMessage } from '@/lib/http';
import { cancelCodeCheckJob } from '@/lib/code-check/service';

export const runtime = 'nodejs';
export async function POST(_request: Request, context: { params: Promise<{ id: string; jobId: string }> }) {
  try {
    const user = await requireUser(_request); const { id, jobId } = await context.params;
    if (!await canManageExam(user, id)) return fail('无权停止本场比赛代码查重', 403);
    await cancelCodeCheckJob(id, jobId);
    return ok({ stopped: true });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}
export const OPTIONS = options;
