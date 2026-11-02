import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, ok, options, toErrorMessage } from '@/lib/http';
import { getCodeCheckDetail } from '@/lib/code-check/service';

export const runtime = 'nodejs';
export async function GET(_request: Request, context: { params: Promise<{ id: string; pairId: string }> }) {
  try {
    const user = await requireUser(); const { id, pairId } = await context.params;
    if (!await canManageExam(user, id)) return fail('无权查看本场比赛查重代码快照', 403);
    const result = await getCodeCheckDetail(id, pairId);
    return result ? ok(result, { headers: { 'Cache-Control': 'no-store' } }) : fail('查重配对不存在', 404);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}
export const OPTIONS = options;
