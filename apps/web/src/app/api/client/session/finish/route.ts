import { z } from 'zod';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { publicClientSession, verifyClientTokenForSession } from '@/lib/client-auth';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { LoginFlowError } from '@/lib/room-login-policy';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const FinishSchema = z.object({
  sessionId: z.string().min(1).max(191),
  confirmationText: z.string().min(1).max(2048)
});

function expectedText(candidate: { examNumber: string; name: string | null; teamName: string | null }) {
  return `考号${candidate.examNumber}，姓名${candidate.name || candidate.teamName || candidate.examNumber}确认结束考试`;
}

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, FinishSchema, 16 * 1024);
    const session = await prisma.clientSession.findUnique({
      where: { id: input.sessionId },
      include: { candidate: true }
    });
    if (!session) return fail('客户端会话不存在', 404);
    if (!verifyClientTokenForSession(request, session, 'DESKTOP')) return fail('客户端会话令牌无效或已过期', 401);
    if (input.confirmationText.trim() !== expectedText(session.candidate)) {
      return fail(`确认文字不正确，请输入：${expectedText(session.candidate)}`, 400);
    }
    const updated = await withSessionWrite(session.id, async (tx) => {
      await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${session.candidateId} FOR UPDATE`;
      const current = await tx.clientSession.findUnique({ where: { id: session.id }, include: { candidate: true } });
      // A takeover or desktop recovery may revoke/replace the token after the
      // first read. An obsolete computer must never finish the new session.
      if (!current || current.revokedAt || !verifyClientTokenForSession(request, current, 'DESKTOP')) {
        throw new LoginFlowError('客户端会话令牌无效或已注销，请刷新状态', 401);
      }
      if (input.confirmationText.trim() !== expectedText(current.candidate)) throw new LoginFlowError('考生信息已更新，请重新确认结束考试', 409);
      if (current.status === 'FINISHED') {
        const { candidate: _candidate, ...sessionRow } = current;
        return sessionRow;
      }
      const endedAt = new Date();
      await tx.clientSession.updateMany({
        where: { examId: session.examId, candidateId: session.candidateId, status: { not: 'FINISHED' } },
        data: {
          status: 'FINISHED',
          endedAt,
          lockdown: false,
          lockdownReason: null
        }
      });
      await tx.candidate.update({
        where: { id: session.candidateId },
        data: { status: 'FINISHED' }
      });
      if (!await isPublicTestExam(session.examId, tx)) await tx.alert.create({
        data: {
          examId: session.examId,
          candidateId: session.candidateId,
          sessionId: session.id,
          type: 'MANUAL_NOTE',
          severity: 1,
          message: `考生 ${current.candidate.examNumber} ${current.candidate.name || current.candidate.teamName || ''} 已本人确认结束考试`
        }
      });
      return tx.clientSession.findUniqueOrThrow({ where: { id: session.id } });
    }, { signal: request.signal });
    return ok(publicClientSession(updated));
  } catch (error) {
    if (error instanceof SessionWriteQueueError || error instanceof LoginFlowError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
