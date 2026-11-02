import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyClientTokenForAnySide } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const CancelLoginRequestSchema = z
  .object({
    sessionId: z.string().optional(),
    loginRequestId: z.string().optional()
  })
  .refine((input) => Boolean(input.sessionId || input.loginRequestId), {
    message: '缺少 sessionId 或 loginRequestId'
  });

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, CancelLoginRequestSchema);
    const session = await prisma.clientSession.findFirst({
      where: input.sessionId ? { id: input.sessionId } : { loginRequestId: input.loginRequestId },
      include: { loginRequest: true }
    });
    if (!session || !session.loginRequest) return fail('登录请求不存在', 404);
    const loginRequest = session.loginRequest;
    if (!verifyClientTokenForAnySide(request, session)) return fail('客户端会话令牌无效或已过期', 401);
    if (loginRequest.status !== 'REQUESTING' || session.status !== 'WAITING_REVIEW') {
      return fail('当前登录请求不能取消', 400);
    }

    const now = new Date();
    const canceled = await prisma.$transaction(async (tx) => {
      const updated = await tx.loginRequest.update({
        where: { id: session.loginRequestId || loginRequest.id },
        data: {
          status: 'REJECTED',
          rejectReason: '考生已取消登录请求',
          reviewedAt: now
        }
      });
      await tx.clientSession.updateMany({
        where: { loginRequestId: updated.id },
        data: {
          status: 'FINISHED',
          endedAt: now,
          lockdown: false,
          lockdownReason: null
        }
      });
      await tx.candidate.update({
        where: { id: session.candidateId },
        data: { status: 'NOT_REQUESTED', abnormal: false }
      });
      return updated;
    });

    return ok(canceled);
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
