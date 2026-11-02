import { prisma } from '@/lib/db';
import { requestOjLogin } from '@/lib/oj';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { options, fail, ok, toErrorMessage } from '@/lib/http';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(_request);
    const { id } = await context.params;
    const session = await prisma.clientSession.findUnique({
      where: { id },
      include: { exam: true, candidate: true }
    });
    if (!session) return fail('客户端会话不存在', 404);
    if (!(await canAccessCandidate(user, session.candidateId))) return fail('无权处理该考生', 403);
    const loginUrl = await requestOjLogin(session.exam, session.candidate);
    const ticket = await prisma.oJLoginTicket.create({
      data: {
        examId: session.examId,
        candidateId: session.candidateId,
        sessionId: session.id,
        status: 'ISSUED',
        loginUrl,
        expiresAt: new Date(Date.now() + 2 * 60 * 1000)
      }
    });
    return ok(ticket);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
