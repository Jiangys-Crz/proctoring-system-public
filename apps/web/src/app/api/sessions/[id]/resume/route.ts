import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { publicClientSession } from '@/lib/client-auth';
import { resumeCandidateExam } from '@/lib/candidate-resume';
import { LoginFlowError } from '@/lib/room-login-policy';
import { options, fail, ok, toErrorMessage } from '@/lib/http';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(_request);
    const { id } = await context.params;
    const session = await prisma.clientSession.findUnique({ where: { id }, include: { exam: true, candidate: true } });
    if (!session) return fail('客户端会话不存在', 404);
    if (!(await canAccessCandidate(user, session.candidateId))) return fail('无权恢复该考生考试', 403);
    await resumeCandidateExam(session.candidateId, user, session.id);
    const updated = await prisma.clientSession.findUniqueOrThrow({ where: { id } });

    return ok(publicClientSession(updated));
  } catch (error) {
    if (error instanceof AuthError || error instanceof LoginFlowError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
