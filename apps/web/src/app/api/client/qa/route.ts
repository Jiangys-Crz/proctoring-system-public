import { admittedQaRead, admittedQaWrite } from '@/lib/qa-admission';
import { randomUUID } from 'node:crypto';
import { appendQuestionMessage, ensureQuestionMessages, initialQuestionMessageId, qaContentDto, qaMessagesForRead, refreshQuestionSummary, requireFreshQaSession, requireQuestionExam } from '@/lib/qa-thread';
import { readCandidateQa } from '@/lib/qa-read';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyClientTokenForAnySide } from '@/lib/client-auth';
import { AuthError } from '@/lib/auth';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { effectiveEnd } from '@/lib/contest-rules';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const QuestionSchema = z.discriminatedUnion('action', [z.object({
  action: z.literal('message'), sessionId: z.string().min(1), questionId: z.string().min(1).optional(), content: z.string().trim().min(1).max(10000),
  problem: z.object({
    pid: z.union([z.string(), z.number()]).transform(String).pipe(z.string().max(191)),
    index: z.string().trim().min(1).max(20),
    title: z.string().trim().min(1).max(200)
  }).nullable().optional()
}), z.object({ action: z.literal('ack-announcement'), sessionId: z.string().min(1), announcementId: z.string().min(1) }), z.object({ action: z.literal('ack-reply'), sessionId: z.string().min(1), messageId: z.string().min(1) })]);

async function authorizedSession(request: Request, sessionId: string) {
  const session = await prisma.clientSession.findUnique({ where: { id: sessionId }, include: { exam: true, candidate: { select: { startedAt: true } } } });
  if (!session) return { error: fail('客户端会话不存在', 404) };
  if (!verifyClientTokenForAnySide(request, session)) return { error: fail('客户端会话令牌无效或已过期', 401) };
  return { session };
}

async function getQa(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId') || '';
    if (!sessionId) return fail('缺少有效 sessionId', 400);
    const authorized = await authorizedSession(request, sessionId);
    if ('error' in authorized) return authorized.error!;
    const { questions, announcements } = await readCandidateQa(authorized.session.examId, authorized.session.candidateId);
    return ok(qaContentDto({
      questions: questions.map(question => {
        const { initialMessageId: _initial, messages: _messages, ...visible } = question;
        return { ...visible, owned: question.candidateId === authorized.session.candidateId,
          messages: qaMessagesForRead(question).map(({ threadOrder: _order, ...message }) => message) };
      }),
      announcements: announcements.map(item => ({ ...item, acknowledged: item.receipts.length > 0, receipts: undefined }))
    }));
  } catch (error) {
    return fail(toErrorMessage(error), 500);
  }
}

async function postQa(request: Request) {
  try {
    const input = await parseBody(request, QuestionSchema, 65536);
    const authorized = await authorizedSession(request, input.sessionId);
    if ('error' in authorized) return authorized.error!;
    if (input.action === 'ack-announcement') {
      await withSessionWrite(input.sessionId, async tx => {
        const current = await requireFreshQaSession(tx, request, input.sessionId, { allowEnded: true });
        const announcement = await tx.examAnnouncement.findFirst({ where: { id: input.announcementId, examId: current.examId, OR: [{ candidateId: null }, { candidateId: current.candidateId }] } });
        if (!announcement) throw new AuthError('公告不存在', 404);
        await tx.examAnnouncementReceipt.upsert({ where: { announcementId_candidateId: { announcementId: announcement.id, candidateId: current.candidateId } }, create: { announcementId: announcement.id, candidateId: current.candidateId }, update: { acknowledgedAt: new Date() } });
      }, { signal: request.signal });
      return ok({ acknowledged: true });
    }
    if (input.action === 'ack-reply') {
      await withSessionWrite(input.sessionId, async tx => {
        const current = await requireFreshQaSession(tx, request, input.sessionId, { allowEnded: true });
        const message = await tx.examQuestionMessage.findFirst({ where: { id: input.messageId, sender: 'ADMIN', question: { examId: current.examId, candidateId: current.candidateId } } });
        if (!message) throw new AuthError('回复不存在', 404);
        await tx.examQuestionMessage.update({ where: { id: message.id }, data: { acknowledgedAt: new Date() } });
      }, { signal: request.signal });
      return ok({ acknowledged: true });
    }
    if (authorized.session.status === 'FINISHED' || effectiveEnd(authorized.session.exam, authorized.session.candidate.startedAt || authorized.session.startedAt) <= new Date()) return fail('考试已结束，不能继续提问', 409);
    if (input.questionId) {
      const existing = await prisma.examQuestion.findFirst({ where: { id: input.questionId, examId: authorized.session.examId, candidateId: authorized.session.candidateId }, select: { id: true, candidateId: true } });
      if (!existing) return fail('问题会话不存在', 404);
      const message = await withSessionWrite(input.sessionId, async tx => {
        // Session -> exam -> question matches other candidate writes. The
        // session lock prevents a replacement login between auth and append.
        await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${authorized.session.examId} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM ExamQuestion WHERE id = ${existing.id} FOR UPDATE`;
        const fresh = await requireFreshQaSession(tx, request, input.sessionId);
        if (fresh.examId !== authorized.session.examId || fresh.candidateId !== authorized.session.candidateId) throw new AuthError('考试会话已改变，请刷新后重试', 409);
        const current = await tx.examQuestion.findUnique({ where: { id: existing.id } });
        requireQuestionExam(current, fresh.examId);
        if (current!.candidateId !== fresh.candidateId) throw new AuthError('无权继续该问题会话', 403);
        await ensureQuestionMessages(tx, existing.id);
        if (effectiveEnd(fresh.exam, fresh.candidate.startedAt || fresh.startedAt) <= new Date()) throw new AuthError('考试已结束，不能继续提问', 409);
        const saved = await appendQuestionMessage(tx, existing.id, { sender: 'CANDIDATE', content: input.content });
        await refreshQuestionSummary(tx, existing.id);
        return saved;
      }, { signal: request.signal });
      return ok(qaContentDto(message), { status: 201 });
    }
    const questionId = `q_${randomUUID()}`;
    const question = await withSessionWrite(input.sessionId, async tx => {
      await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${authorized.session.examId} FOR SHARE`;
      const fresh = await requireFreshQaSession(tx, request, input.sessionId);
      if (fresh.examId !== authorized.session.examId || fresh.candidateId !== authorized.session.candidateId) throw new AuthError('考试会话已改变，请刷新后重试', 409);
      const initialClock = BigInt(Date.now());
      return tx.examQuestion.create({
        data: {
          messageClock: initialClock, initialMessageId: initialQuestionMessageId(questionId), id: questionId, examId: fresh.examId,
          candidateId: fresh.candidateId,
          sessionId: fresh.id,
          problemPid: input.problem?.pid,
          problemIndex: input.problem?.index,
          problemTitle: input.problem?.title,
          content: input.content,
          messages: { create: { id: initialQuestionMessageId(questionId), threadOrder: initialClock, sender: 'CANDIDATE', deliveredAt: new Date(), content: input.content } }
        },
        select: { id: true, problemPid: true, problemIndex: true, problemTitle: true, content: true, answer: true, answeredAt: true, createdAt: true, updatedAt: true, messages: true }
      });
    }, { signal: request.signal });
    return ok(qaContentDto(question), { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;

export async function GET(request: Request) { return admittedQaRead(request, () => getQa(request)); }
export async function POST(request: Request) { return admittedQaWrite(request, () => postQa(request)); }
