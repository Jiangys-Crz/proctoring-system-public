import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyClientTokenForAnySide } from '@/lib/client-auth';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const QuestionSchema = z.discriminatedUnion('action', [z.object({
  action: z.literal('message'), sessionId: z.string().min(1), questionId: z.string().min(1).optional(), content: z.string().trim().min(1).max(10000),
  problem: z.object({
    pid: z.union([z.string(), z.number()]).transform(String),
    index: z.string().trim().min(1).max(20),
    title: z.string().trim().min(1).max(200)
  }).nullable().optional()
}), z.object({ action: z.literal('ack-announcement'), sessionId: z.string().min(1), announcementId: z.string().min(1) }), z.object({ action: z.literal('ack-reply'), sessionId: z.string().min(1), messageId: z.string().min(1) })]);

function questionMessages(question: { content: string; answer: string | null; createdAt: Date; answeredAt: Date | null; messages: Array<{ id: string; sender: 'CANDIDATE' | 'ADMIN'; content: string; acknowledgedAt: Date | null; createdAt: Date }> }) {
  if (question.messages.length) return question.messages;
  return [
    { id: `legacy-question`, sender: 'CANDIDATE' as const, content: question.content, acknowledgedAt: null, createdAt: question.createdAt },
    ...(question.answer ? [{ id: `legacy-answer`, sender: 'ADMIN' as const, content: question.answer, acknowledgedAt: question.answeredAt, createdAt: question.answeredAt || question.createdAt }] : [])
  ];
}

async function authorizedSession(request: Request, sessionId: string) {
  const session = await prisma.clientSession.findUnique({ where: { id: sessionId }, include: { exam: true } });
  if (!session) return { error: fail('客户端会话不存在', 404) };
  if (!verifyClientTokenForAnySide(request, session)) return { error: fail('客户端会话令牌无效或已过期', 401) };
  return { session };
}

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId') || '';
    if (!sessionId) return fail('缺少有效 sessionId', 400);
    const authorized = await authorizedSession(request, sessionId);
    if ('error' in authorized) return authorized.error;
    const [questions, announcements] = await Promise.all([
      prisma.examQuestion.findMany({
        where: { examId: authorized.session.examId, OR: [{ candidateId: authorized.session.candidateId }, { isPublished: true }] },
        select: { id: true, candidateId: true, isPublished: true, problemPid: true, problemIndex: true, problemTitle: true, content: true, answer: true, answeredAt: true, createdAt: true, updatedAt: true, messages: { select: { id: true, sender: true, content: true, acknowledgedAt: true, createdAt: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        take: 50
      }),
      prisma.examAnnouncement.findMany({
        where: {
          examId: authorized.session.examId,
          OR: [{ candidateId: null }, { candidateId: authorized.session.candidateId }]
        },
        select: { id: true, candidateId: true, content: true, createdAt: true, updatedAt: true, receipts: { where: { candidateId: authorized.session.candidateId }, select: { id: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50
      })
    ]);
    return ok({
      questions: questions.map(question => ({ ...question, owned: question.candidateId === authorized.session.candidateId, messages: questionMessages(question) })),
      announcements: announcements.map(item => ({ ...item, acknowledged: item.receipts.length > 0, receipts: undefined }))
    });
  } catch (error) {
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, QuestionSchema);
    const authorized = await authorizedSession(request, input.sessionId);
    if ('error' in authorized) return authorized.error;
    if (input.action === 'ack-announcement') {
      const announcement = await prisma.examAnnouncement.findFirst({ where: { id: input.announcementId, examId: authorized.session.examId, OR: [{ candidateId: null }, { candidateId: authorized.session.candidateId }] } });
      if (!announcement) return fail('公告不存在', 404);
      await prisma.examAnnouncementReceipt.upsert({ where: { announcementId_candidateId: { announcementId: announcement.id, candidateId: authorized.session.candidateId } }, create: { announcementId: announcement.id, candidateId: authorized.session.candidateId }, update: { acknowledgedAt: new Date() } });
      return ok({ acknowledged: true });
    }
    if (input.action === 'ack-reply') {
      const message = await prisma.examQuestionMessage.findFirst({ where: { id: input.messageId, sender: 'ADMIN', question: { examId: authorized.session.examId, candidateId: authorized.session.candidateId } } });
      if (!message) return fail('回复不存在', 404);
      await prisma.examQuestionMessage.update({ where: { id: message.id }, data: { acknowledgedAt: new Date() } });
      return ok({ acknowledged: true });
    }
    if (authorized.session.status === 'FINISHED' || authorized.session.exam.endAt <= new Date()) return fail('考试已结束，不能继续提问', 409);
    if (input.questionId) {
      const existing = await prisma.examQuestion.findFirst({ where: { id: input.questionId, examId: authorized.session.examId, candidateId: authorized.session.candidateId }, include: { messages: true } });
      if (!existing) return fail('问题会话不存在', 404);
      const message = await prisma.$transaction(async tx => {
        if (!existing.messages.length) {
          await tx.examQuestionMessage.create({ data: { questionId: existing.id, sender: 'CANDIDATE', content: existing.content, createdAt: existing.createdAt } });
          if (existing.answer) await tx.examQuestionMessage.create({ data: { questionId: existing.id, sender: 'ADMIN', content: existing.answer, createdById: existing.answeredById, acknowledgedAt: existing.answeredAt, createdAt: existing.answeredAt || existing.createdAt } });
        }
        await tx.examQuestion.update({ where: { id: existing.id }, data: { answeredAt: null, answeredById: null } });
        return tx.examQuestionMessage.create({ data: { questionId: existing.id, sender: 'CANDIDATE', content: input.content } });
      });
      return ok(message, { status: 201 });
    }
    const question = await prisma.examQuestion.create({
      data: {
        examId: authorized.session.examId,
        candidateId: authorized.session.candidateId,
        sessionId: authorized.session.id,
        problemPid: input.problem?.pid,
        problemIndex: input.problem?.index,
        problemTitle: input.problem?.title,
        content: input.content,
        messages: { create: { sender: 'CANDIDATE', content: input.content } }
      },
      select: { id: true, problemPid: true, problemIndex: true, problemTitle: true, content: true, answer: true, answeredAt: true, createdAt: true, updatedAt: true, messages: true }
    });
    return ok(question, { status: 201 });
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
