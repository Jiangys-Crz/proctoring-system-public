import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyClientTokenForAnySide } from '@/lib/client-auth';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { LoginFlowError } from '@/lib/room-login-policy';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const CancelLoginRequestSchema = z.object({
  sessionId: z.string().min(1).max(191).optional(),
  loginRequestId: z.string().min(1).max(191).optional()
}).refine(input => Boolean(input.sessionId || input.loginRequestId), { message: '缺少 sessionId 或 loginRequestId' });

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, CancelLoginRequestSchema, 16 * 1024);
    const session = await prisma.clientSession.findFirst({
      where: input.sessionId ? { id: input.sessionId } : { loginRequestId: input.loginRequestId },
    });
    if (!session?.loginRequestId) return fail('登录请求不存在', 404);
    if (!verifyClientTokenForAnySide(request, session)) return fail('客户端会话令牌无效或已过期', 401);
    if (input.loginRequestId && input.loginRequestId !== session.loginRequestId) return fail('登录请求与当前会话不匹配', 403);

    const canceled = await withSessionWrite(session.id, async tx => {
      // Match review and login takeover: session -> candidate -> login request.
      await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${session.candidateId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM LoginRequest WHERE id = ${session.loginRequestId} FOR UPDATE`;
      const current = await tx.clientSession.findUnique({ where: { id: session.id }, include: { loginRequest: true, candidate: true } });
      if (!current || !verifyClientTokenForAnySide(request, current)) throw new LoginFlowError('客户端会话令牌无效或已过期', 401);
      if (!current.loginRequest || current.loginRequest.status !== 'REQUESTING' || current.status !== 'WAITING_REVIEW'
        || current.approvedAt || current.lockdown || current.revokedAt || current.candidate.status === 'FINISHED') {
        throw new LoginFlowError('登录请求已处理或当前会话不能取消，请刷新状态', 409);
      }
      const now = new Date();
      const updated = await tx.loginRequest.update({ where: { id: current.loginRequest.id }, data: {
        status: 'REJECTED', rejectReason: '考生已取消登录请求', reviewedAt: now
      } });
      await tx.clientSession.update({ where: { id: current.id }, data: {
        status: 'FINISHED', endedAt: now, revokedAt: now, desktopTokenHash: null, miniProgramTokenHash: null,
        lockdown: false, lockdownReason: null
      } });
      await tx.pairingSession.updateMany({ where: { OR: [
        { recoverySessionId: current.id }, { loginRequestId: current.loginRequest.id }
      ] }, data: { pollTokenHash: null, recoveryTokenHash: null, expiresAt: now } });
      await tx.candidate.update({ where: { id: current.candidateId }, data: {
        status: current.candidate.startedAt ? 'OFFLINE' : 'NOT_REQUESTED'
      } });
      return updated;
    }, { signal: request.signal });
    return ok(canceled);
  } catch (error) {
    if (error instanceof SessionWriteQueueError || error instanceof LoginFlowError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}
export const OPTIONS = options;
