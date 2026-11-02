import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { resumeCandidateExam } from '@/lib/candidate-resume';
import { LoginFlowError } from '@/lib/room-login-policy';
import { options, fail, ok, toErrorMessage } from '@/lib/http';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(_request);
    const { id } = await context.params;
    if (!await canAccessCandidate(user, id)) return fail('无权恢复该考生考试', 403);
    return ok(await resumeCandidateExam(id, user));
  } catch (error) {
    if (error instanceof AuthError || error instanceof LoginFlowError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
