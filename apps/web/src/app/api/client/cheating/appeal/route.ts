import { z } from 'zod';
import { isPublicTestExam } from '@/lib/public-test';
import { clientSessionTokenFromRequest, verifyClientTokenForSession } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { SessionWriteQueueError, withSessionWrite } from '@/lib/session-write';

const AppealSchema = z.object({
  sessionId: z.string().min(1).max(191),
  message: z.string().trim().min(1).max(2000)
});

export async function POST(request: Request) {
  try {
    if (!clientSessionTokenFromRequest(request)) return fail('缺少客户端会话令牌', 401);
    const input = await parseBody(request, AppealSchema, 16 * 1024);
    return await withSessionWrite(input.sessionId, async tx => {
      const session = await tx.clientSession.findUnique({ where: { id: input.sessionId } });
      if (!session) return fail('客户端会话不存在', 404);
      if (!verifyClientTokenForSession(request, session, 'DESKTOP')) return fail('客户端会话令牌无效或已过期', 401);
      if (await isPublicTestExam(session.examId, tx)) return fail('环境测试不保存监考记录', 403);
      // A replacement session can inherit a mark recorded against its predecessor.
      const mark = await tx.cheatingRecord.findFirst({ where: { examId: session.examId, candidateId: session.candidateId, canceledAt: null }, select: { id: true } });
      if (!mark) return fail('当前没有需要申诉的作弊标记', 409);
      const alert = await tx.alert.create({
        data: {
          examId: session.examId,
          candidateId: session.candidateId,
          sessionId: session.id,
          type: 'MANUAL_NOTE',
          severity: 5,
          message: `作弊申诉：${input.message}`
        }
      });
      return ok(alert, { status: 201 });
    }, { signal: request.signal });
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
