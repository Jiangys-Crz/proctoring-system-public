import { z } from 'zod';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const AppealSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().trim().min(1).max(2000)
});

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, AppealSchema);
    const session = await prisma.clientSession.findUnique({
      where: { id: input.sessionId },
      include: { candidate: true }
    });
    if (!session) return fail('客户端会话不存在', 404);
    if (!verifyClientTokenForSession(request, session, 'DESKTOP')) return fail('客户端会话令牌无效或已过期', 401);
    if (await isPublicTestExam(session.examId)) return fail('环境测试不保存监考记录', 403);
    const alert = await prisma.alert.create({
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
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
