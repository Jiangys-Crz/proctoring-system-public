import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate, canManageExam } from '@/lib/permissions';
import { options, fail, ok, toErrorMessage } from '@/lib/http';
import { acknowledgeAlert } from '@/lib/alert-acknowledgement';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(_request);
    const { id } = await context.params;
    const alert = await prisma.alert.findUnique({ where: { id } });
    if (!alert) return fail('告警不存在', 404);
    if (alert.candidateId && !(await canAccessCandidate(user, alert.candidateId))) return fail('无权处理该告警', 403);
    if (!alert.candidateId && !(await canManageExam(user, alert.examId))) return fail('无权处理该考试告警', 403);
    const updated = await acknowledgeAlert(alert);
    return ok(updated);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
