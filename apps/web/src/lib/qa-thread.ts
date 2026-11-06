import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { RequestParseError } from './http';
import { effectiveEnd } from './contest-rules';

export const initialQuestionMessageId = (id: string) => `qm_${createHash('sha256').update(id + ':initial').digest('hex')}`;
export function qaAuthorLabel(user: { realName?: string | null; nickname?: string | null; username?: string | null } | null | undefined) {
  return (user?.realName || user?.nickname || user?.username || '监考老师').slice(0, 200);
}
type ReadMessage = { id: string; sender: 'ADMIN' | 'CANDIDATE'; content: string; createdAt: Date; threadOrder?: bigint };
/** Show partial legacy threads without writing during a read or inventing
 * persisted message identities. Legacy placeholders never require receipts. */
export function qaMessagesForRead<T extends ReadMessage>(question: {
  id: string; content: string; answer: string | null; createdAt: Date; answeredAt: Date | null; initialMessageId?: string | null;
  answeredByLabel?: string | null; answeredBy?: Parameters<typeof qaAuthorLabel>[0]; messages: T[];
}) {
  const root = question.messages.find(message => message.id === question.initialMessageId && message.sender === 'CANDIDATE' && message.content === question.content)
    || question.messages.filter(message => message.sender === 'CANDIDATE' && message.content === question.content)
      .sort((a, b) => +a.createdAt - +b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  const hasAnswer = !question.answer || question.messages.some(message => message.sender === 'ADMIN' && message.content === question.answer);
  if (root && question.messages[0] === root && hasAnswer && question.messages.every(message => (message.threadOrder || 0n) > 0n)) return question.messages;
  const rootClock = root?.threadOrder || BigInt(Math.max(1, +(root?.createdAt || question.createdAt)));
  const initial = root || { id: `legacy-question:${question.id}`, sender: 'CANDIDATE' as const, content: question.content,
    createdAt: question.createdAt, threadOrder: rootClock, acknowledgedAt: null, createdBy: null, creatorLabel: null };
  const messages: Array<T | typeof initial | { id: string; sender: 'ADMIN'; content: string; createdAt: Date; threadOrder: bigint; acknowledgedAt: Date | null; createdBy: null; creatorLabel: string }> = [...question.messages];
  if (!hasAnswer) {
    const answeredAt = question.answeredAt || question.createdAt;
    const clock = BigInt(Math.max(1, +question.createdAt, +answeredAt));
    messages.push({ id: `legacy-answer:${question.id}`, sender: 'ADMIN', content: question.answer!, createdAt: answeredAt,
      threadOrder: (clock > rootClock ? clock : rootClock) + 1n, acknowledgedAt: question.answeredAt, createdBy: null,
      creatorLabel: question.answeredByLabel || qaAuthorLabel(question.answeredBy) });
  }
  const order = (message: ReadMessage) => {
    if (message.threadOrder && message.threadOrder > 0n) return message.threadOrder;
    const time = BigInt(Math.max(1, +message.createdAt));
    return time > rootClock ? time : rootClock + 1n;
  };
  const remaining = messages.filter(message => message !== root).sort((a, b) => {
    const left = order(a), right = order(b);
    return (left < right ? -1 : left > right ? 1 : 0) || +a.createdAt - +b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return [initial, ...remaining];
}
export async function qaQuestionTransaction<T>(id: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(async tx => {
      const parent = await tx.examQuestion.findUnique({ where: { id }, select: { examId: true } });
      if (!parent) throw new RequestParseError('问题会话不存在');
      await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${parent.examId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM ExamQuestion WHERE id = ${id} FOR UPDATE`;
      return work(tx);
    }, { isolationLevel: 'ReadCommitted', maxWait: 3000, timeout: 10000 }); }
    catch (error) { if (attempt >= 2 || (error as { code?: string })?.code !== 'P2034') throw error; }
  }
}
export async function ensureQuestionMessages(tx: Prisma.TransactionClient, id: string) {
  const question = await tx.examQuestion.findUniqueOrThrow({ where: { id }, include: { answeredBy: { select: { realName: true, nickname: true, username: true } } } });
  if (question.initialMessageId && question.messageClock > 0n) {
    // An older server can append zero-order rows after the thread itself was
    // upgraded. A healthy parent does not imply every child was initialized.
    // A prior partial upgrade can also have an answer summary without its
    // message. Check exact text, not the database's case-insensitive collation.
    const [health] = await tx.$queryRaw<Array<{ hasInitial: number | bigint; hasLegacy: number | bigint; hasAnswer: number | bigint }>>`SELECT
      EXISTS(SELECT 1 FROM ExamQuestionMessage WHERE id = ${question.initialMessageId} AND questionId = ${id}
        AND sender = 'CANDIDATE' AND BINARY content = BINARY ${question.content}) AS hasInitial,
      EXISTS(SELECT 1 FROM ExamQuestionMessage WHERE questionId = ${id} AND threadOrder = 0) AS hasLegacy,
      (${question.answer} IS NULL OR OCTET_LENGTH(${question.answer}) = 0 OR EXISTS(SELECT 1 FROM ExamQuestionMessage
        WHERE questionId = ${id} AND sender = 'ADMIN' AND BINARY content = BINARY ${question.answer})) AS hasAnswer`;
    if (!health?.hasInitial) throw new RequestParseError('原始提问与首问消息不一致，请核对历史记录');
    if (!health.hasLegacy && health.hasAnswer) return question;
  }
  // A partially upgraded thread may contain follow-ups or admin replies but
  // lack the actual opening message. Its first candidate row is not enough.
  const matching = question.initialMessageId ? [] : await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM ExamQuestionMessage WHERE questionId = ${id} AND sender = 'CANDIDATE' AND BINARY content = BINARY ${question.content}
    ORDER BY createdAt ASC, BINARY id ASC LIMIT 1`;
  const initialId = question.initialMessageId || matching[0]?.id || initialQuestionMessageId(id);
  const config = question.syncOriginNodeId ? await tx.examFederation.findUnique({ where: { examId: question.examId }, select: { nodeId: true } }) : null;
  const imported = Boolean(question.syncOriginNodeId && question.syncOriginNodeId !== config?.nodeId);
  const initialClock = BigInt(Math.max(1, +question.createdAt));
  if (!question.initialMessageId && !matching.length) await tx.examQuestionMessage.createMany({ data: [{
    id: initialId, threadOrder: initialClock, questionId: id, sender: 'CANDIDATE', content: question.content, createdAt: question.createdAt,
    syncOriginNodeId: question.syncOriginNodeId, federationDirty: !imported,
  }], skipDuplicates: true });
  const initial = await tx.examQuestionMessage.findUnique({ where: { id: initialId }, select: { questionId: true, sender: true, content: true, createdAt: true, threadOrder: true } });
  if (!initial || initial.questionId !== id || initial.sender !== 'CANDIDATE' || initial.content !== question.content) throw new RequestParseError('原始提问与首问消息不一致，请核对历史记录');
  const exported = await tx.$queryRaw<Array<{ id: string }>>`SELECT m.id FROM ExamQuestionMessage m
    INNER JOIN ExamFederationContent c ON c.examId = ${question.examId} AND c.kind = 'message' AND c.entityId = m.id
    WHERE m.questionId = ${id} AND m.threadOrder = 0 LIMIT 1`;
  const exportedInitial = initial.threadOrder === 0n && await tx.examFederationContent.findUnique({
    where: { examId_kind_entityId: { examId: question.examId, kind: 'question', entityId: id } }, select: { entityId: true },
  });
  if (exported.length || exportedInitial) throw new RequestParseError('历史消息顺序与同步快照不一致，请核对历史记录');
  const rootClock = initial.threadOrder || BigInt(Math.max(1, +initial.createdAt));
  const answeredClock = BigInt(Math.max(+question.createdAt, +(question.answeredAt || question.createdAt)));
  const answerClock = (answeredClock > rootClock ? answeredClock : rootClock) + 1n;
  if (question.answer) {
    const answered = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM ExamQuestionMessage
      WHERE questionId = ${id} AND sender = 'ADMIN' AND BINARY content = BINARY ${question.answer} LIMIT 1`;
    if (!answered.length) await tx.examQuestionMessage.createMany({ data: [{
      id: `qm_${createHash('sha256').update(id + ':legacy-answer:' + question.answer).digest('hex')}`, questionId: id,
      sender: 'ADMIN' as const, threadOrder: answerClock, content: question.answer, createdById: question.answeredById,
      creatorLabel: question.answeredByLabel || qaAuthorLabel(question.answeredBy), acknowledgedAt: question.answeredAt,
      createdAt: question.answeredAt || question.createdAt, syncOriginNodeId: question.syncOriginNodeId, federationDirty: !imported,
    }], skipDuplicates: true });
  }
  // Normalize every existing legacy row too, including an admin reply that
  // arrived before a missing opening message was repaired.
  await tx.$executeRaw`UPDATE ExamQuestionMessage SET threadOrder = GREATEST(
    CASE WHEN id = ${initialId} THEN 1 ELSE ${rootClock + 1n} END,
    TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', createdAt) DIV 1000)
    WHERE questionId = ${id} AND threadOrder = 0`;
  const maximum = await tx.examQuestionMessage.aggregate({ where: { questionId: id }, _max: { threadOrder: true } });
  const clock = maximum._max.threadOrder && maximum._max.threadOrder > question.messageClock ? maximum._max.threadOrder : question.messageClock || 1n;
  await tx.examQuestion.update({ where: { id }, data: { initialMessageId: initialId, messageClock: clock, updatedAt: question.updatedAt } });
  // Old reply writes did not update the question summary atomically. Derive it
  // from the repaired thread on the source too, as receivers do on import.
  // Backfilling history must not make it look like a newly received reply.
  await refreshQuestionSummary(tx, id, question.updatedAt);
  return tx.examQuestion.findUniqueOrThrow({ where: { id }, include: { answeredBy: { select: { realName: true, nickname: true, username: true } } } });
}
export async function refreshQuestionSummary(tx: Prisma.TransactionClient, id: string, updatedAt?: Date) {
  const orderBy = [{ threadOrder: 'desc' as const }, { createdAt: 'desc' as const }, { id: 'desc' as const }];
  const latest = await tx.examQuestionMessage.findFirst({ where: { questionId: id }, orderBy });
  const answer = latest?.sender === 'ADMIN' ? latest : await tx.examQuestionMessage.findFirst({ where: { questionId: id, sender: 'ADMIN' }, orderBy });
  await tx.examQuestion.update({ where: { id }, data: { answer: answer?.content ?? null,
    answeredAt: latest?.sender === 'ADMIN' ? latest.createdAt : null,
    answeredById: latest?.sender === 'ADMIN' ? latest.createdById : null,
    answeredByLabel: latest?.sender === 'ADMIN' ? latest.creatorLabel : null,
    ...(updatedAt ? { updatedAt } : {}),
  } });
}
export function qaAnnouncementVisibility() {
  return { withdrawn: false, OR: [{ sourceQuestionId: null }, { sourceQuestion: { isPublished: true } }] } satisfies Prisma.ExamAnnouncementWhereInput;
}
/** Content URLs are kept independent of installation domains in the sync stream. */
export function localQaContent(content: string) {
  const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return content.replace(/(?<![A-Za-z0-9:/])\/api\/qa-assets\/[a-f0-9-]{36}\?key=[A-Za-z0-9_-]{43}/gi, value => base + value);
}
export function qaContentDto<T>(value: T): T {
  if (typeof value === 'bigint') return value.toString() as T;
  if (Array.isArray(value)) return value.map(qaContentDto) as T;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    (key === 'content' || key === 'answer') && typeof child === 'string' ? localQaContent(child) : qaContentDto(child)])) as T;
}
export function nextPublicationId(published: boolean) { return published ? randomUUID() : null; }
export function requireQuestionExam(question: { examId: string } | null, examId: string) {
  if (!question || question.examId !== examId) throw new RequestParseError('问题会话不存在或已改变，请刷新后重试');
}

export async function requireFreshQaSession(tx: Prisma.TransactionClient, request: Request, sessionId: string, options: { allowEnded?: boolean } = {}) {
  const { verifyClientTokenForAnySide } = await import('./client-auth');
  const { AuthError } = await import('./auth');
  const session = await tx.clientSession.findUnique({ where: { id: sessionId }, include: { exam: true, candidate: { select: { startedAt: true } } } });
  if (!session || !verifyClientTokenForAnySide(request, session)) throw new AuthError('客户端会话已注销，请重新登录', 401);
  if (!options.allowEnded && (session.status === 'FINISHED' || effectiveEnd(session.exam, session.candidate.startedAt || session.startedAt) <= new Date())) throw new AuthError('考试已结束，不能继续提问', 409);
  return session;
}

export async function appendQuestionMessage(tx: Prisma.TransactionClient, questionId: string, data: { sender: 'ADMIN' | 'CANDIDATE'; content: string; createdById?: string; creatorLabel?: string }) {
  const question = await tx.examQuestion.findUniqueOrThrow({ where: { id: questionId }, select: { messageClock: true } });
  const now = BigInt(Date.now()); const clock = (question.messageClock > now ? question.messageClock : now) + 1n;
  await tx.examQuestion.update({ where: { id: questionId }, data: { messageClock: clock } });
  return tx.examQuestionMessage.create({ data: { questionId, ...data, threadOrder: clock, deliveredAt: new Date() } });
}
