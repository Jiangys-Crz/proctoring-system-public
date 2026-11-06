import { z } from 'zod';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { qaAuthorLabel } from '@/lib/qa-thread';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const WarningSchema = z.object({
  candidateId: z.string().min(1),
  sessionId: z.string().optional(),
  content: z.string().trim().min(1).max(10000).optional()
});

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const input = await parseBody(request, WarningSchema);
    if (!(await canAccessCandidate(user, input.candidateId))) return fail('无权警告该考生', 403);
    const candidate = await prisma.candidate.findUnique({ where: { id: input.candidateId }, include: { exam: true } });
    if (!candidate) return fail('考生不存在', 404);
    if (await isPublicTestExam(candidate.examId)) return fail('环境测试不保存监考记录', 403);
    if (input.sessionId && !(await prisma.clientSession.findFirst({ where: { id: input.sessionId, candidateId: candidate.id, examId: candidate.examId } }))) {
      return fail('客户端会话不属于该考生', 403);
    }
    const now = new Date();
    if (now < candidate.exam.startAt || now > candidate.exam.endAt) return fail('当前不在考试时间内，不能发送警告消息', 400);
    const announcement = await prisma.examAnnouncement.create({
      data: { examId: candidate.examId, candidateId: candidate.id, createdById: user.id, creatorLabel: qaAuthorLabel(user), deliveredAt: now,
        content: input.content || '监考老师提醒你：请遵守考试纪律并注意考试要求。请确认已读。' }
    });
    return ok(announcement, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
