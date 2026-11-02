import { z } from 'zod';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { publicClientSession, verifyClientTokenForSession } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const FinishSchema = z.object({
  sessionId: z.string().min(1),
  confirmationText: z.string().min(1)
});

function expectedText(candidate: { examNumber: string; name: string | null; teamName: string | null }) {
  return `考号${candidate.examNumber}，姓名${candidate.name || candidate.teamName || candidate.examNumber}确认结束考试`;
}

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, FinishSchema);
    const session = await prisma.clientSession.findUnique({
      where: { id: input.sessionId },
      include: { candidate: true }
    });
    if (!session) return fail('客户端会话不存在', 404);
    if (!verifyClientTokenForSession(request, session, 'DESKTOP')) return fail('客户端会话令牌无效或已过期', 401);
    if (input.confirmationText.trim() !== expectedText(session.candidate)) {
      return fail(`确认文字不正确，请输入：${expectedText(session.candidate)}`, 400);
    }
    const updated = await prisma.$transaction(async (tx) => {
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
          message: `考生 ${session.candidate.examNumber} ${session.candidate.name || session.candidate.teamName || ''} 已本人确认结束考试`
        }
      });
      return tx.clientSession.findUniqueOrThrow({ where: { id: session.id } });
    });
    return ok(publicClientSession(updated));
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
