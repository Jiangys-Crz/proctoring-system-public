import { randomUUID } from 'node:crypto';
import type { ExamFederation, Prisma } from '@prisma/client';
import { prisma } from './db';
import { compareSnapshotVersion, digest, FederationError, keyHash } from './exam-federation-protocol';
import { CommunicationSnapshotSchema, QuestionSnapshotSchema, type CommunicationWire, type QuestionSnapshot } from './exam-communication-protocol';
import { contentIdentity, putCommunication } from './exam-communication-entry';
import { communicationWire, installPreparedAssets, prepareCommunicationAssets, storeCommunicationAsset, type PreparedAssets } from './exam-communication-assets';
import { ensureQuestionMessages, legacyQuestionAnswerId, legacyMessageAliasKey, qaAuthorLabel, refreshQuestionSummary, reconcileQuestionPublication } from './qa-thread';
import { RequestParseError } from './http';
import { settleReads } from './request-admission';

type Tx = Prisma.TransactionClient;
async function questionSnapshot(tx: Tx, config: ExamFederation, id: string, assets: PreparedAssets): Promise<QuestionSnapshot | null> {
  await tx.$queryRaw`SELECT id FROM ExamQuestion WHERE id = ${id} FOR UPDATE`;
  const row = await tx.examQuestion.findUniqueOrThrow({ where: { id }, include: { candidate: { select: { examNumber: true, syncKey: true } } } });
  if (row.examId !== config.examId) throw new FederationError('问题不属于当前考试');
  if (config.managedGlobally && !row.candidate.syncKey) throw new FederationError('考生映射尚未同步，将自动重试');
  const mappedProblem = config.managedGlobally && row.problemPid ? await tx.examProblem.findFirst({ where: { examId: config.examId, hydroProblemId: row.problemPid }, select: { syncKey: true } }) : null;
  if (config.managedGlobally && row.problemPid && !mappedProblem?.syncKey) throw new FederationError('题目映射尚未同步，将自动重试');
  const prior = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, 'question', id) });
  let original = prior ? QuestionSnapshotSchema.parse(prior.snapshot) : null;
  if (original && (original.id !== id || (config.managedGlobally ? original.candidateKey !== row.candidate.syncKey : original.examNumber !== row.candidate.examNumber) || original.originNodeId !== (row.syncOriginNodeId || config.nodeId))) throw new FederationError('原始问题身份与同步历史不一致');
  // Existing immutable originals still need missing legacy answer messages
  // seeded before metadata export; reuse the original text and identity below.
  const seeded = await ensureQuestionMessages(tx, id);
  if (!row.federationDirty && original) return original;
  if (!original) {
    const initial = await tx.examQuestionMessage.findUniqueOrThrow({ where: { id: seeded.initialMessageId! }, select: { createdAt: true, threadOrder: true } });
    const content = assets.rewrite(row.content); if (content === null) return null;
    original = { kind: 'question', id, originNodeId: row.syncOriginNodeId || config.nodeId, writerNodeId: config.nodeId,
      revision: 1, initialMessageId: seeded.initialMessageId!, initialMessageCreatedAt: initial.createdAt.toISOString(),
      initialThreadOrder: initial.threadOrder.toString(), messageClock: initial.threadOrder.toString(),
      candidateKey: row.candidate.syncKey || undefined, examNumber: row.candidate.examNumber, problemPid: config.managedGlobally && row.problemPid ? mappedProblem!.syncKey : row.problemPid, problemIndex: row.problemIndex, problemTitle: row.problemTitle,
      content, createdAt: row.createdAt.toISOString(), isPublished: false, publicationId: null };
  }
  const { messageClock } = await tx.examQuestion.findUniqueOrThrow({ where: { id }, select: { messageClock: true } });
  const publicationId = row.isPublished ? row.publicationId || randomUUID() : null;
  // Re-publication changes metadata only. URL normalization and a later
  // storage move must never rewrite the already synchronized original text.
  const value: QuestionSnapshot = { ...original, writerNodeId: config.nodeId, revision: Math.max(row.federationRevision + 1, prior ? original.revision + 1 : 1),
    messageClock: messageClock.toString(), isPublished: row.isPublished, publicationId };
  await putCommunication(tx, config, value);
  await tx.examQuestion.update({ where: { id }, data: { initialMessageId: value.initialMessageId, syncOriginNodeId: value.originNodeId, federationDirty: false, federationRevision: value.revision - 1, publicationId, updatedAt: row.updatedAt } });
  return value;
}
export class QaHistoryRepairError extends FederationError {
  constructor(readonly questionId: string, message: string) { super(message); }
}
const qaHistoryFailurePrefix = (examId: string) => `qa-history-error:${digest(examId)}:`;
export const qaHistoryFailureKey = (examId: string, questionId: string) => `${qaHistoryFailurePrefix(examId)}${digest(questionId)}`;
/** An unrelated successful page must not hide a still-unrepaired legacy row. */
export async function pendingQaHistoryError(tx: Tx, config: ExamFederation) {
  const failures = await tx.systemSetting.findMany({ where: { key: { startsWith: qaHistoryFailurePrefix(config.examId) } },
    select: { key: true, value: true }, orderBy: { key: 'asc' }, take: 8 });
  for (const failure of failures) {
    const value = failure.value as { examId?: string; questionId?: string; message?: string } | null;
    if (!value || value.examId !== config.examId || typeof value.questionId !== 'string') return '历史答疑恢复记录异常，请核对同步记录';
    const question = await tx.examQuestion.findFirst({ where: { id: value.questionId, examId: config.examId }, select: { id: true } });
    if (!question) { await tx.systemSetting.deleteMany({ where: { key: failure.key } }); continue; }
    return typeof value.message === 'string' ? value.message : '部分历史答疑尚未补齐，原记录已保留';
  }
  return null;
}
/** Repair clean legacy rows too; a dirty-only query cannot discover missing history. */
export async function repairCommunicationHistory(tx: Tx, config: ExamFederation) {
  const key = `qa-history:${config.examId}`;
  const progress = await tx.systemSetting.findUnique({ where: { key } });
  const state = progress?.value as { after?: string; announcementAfter?: string; questionDone?: boolean; announcementDone?: boolean; nextAt?: number } | undefined;
  if ((state?.nextAt || 0) > Date.now()) return false;
  const after = state?.after;
  const questions = state?.questionDone ? [] : await tx.examQuestion.findMany({ where: { examId: config.examId, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 1, select: { id: true } });
  for (const row of questions) {
    let question;
    try { question = await ensureQuestionMessages(tx, row.id); } catch (error) {
      if (error instanceof FederationError || error instanceof RequestParseError) throw new QaHistoryRepairError(row.id, error.message);
      throw error;
    }
    const known = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, 'question', row.id), select: { entityId: true } });
    if (!known && !question.federationDirty) await tx.examQuestion.update({ where: { id: row.id }, data: { federationDirty: true, updatedAt: question.updatedAt } });
    await tx.$executeRaw`UPDATE ExamQuestionMessage AS message
      LEFT JOIN ExamFederationContent AS content ON content.examId = ${config.examId} AND content.kind = 'message' AND content.entityId = message.id
      SET message.federationDirty = true
      WHERE message.questionId = ${row.id} AND content.entityId IS NULL AND message.federationDirty = false
      AND (message.syncOriginNodeId IS NULL OR message.syncOriginNodeId = ${config.nodeId})`;
    await tx.systemSetting.deleteMany({ where: { key: qaHistoryFailureKey(config.examId, row.id) } });
  }
  const notices = state?.announcementDone ? [] : await tx.examAnnouncement.findMany({ where: { examId: config.examId, ...(state?.announcementAfter ? { id: { gt: state.announcementAfter } } : {}) }, select: { id: true, syncOriginNodeId: true, updatedAt: true }, orderBy: { id: 'asc' }, take: 1 });
  for (const row of notices) if (!row.syncOriginNodeId || row.syncOriginNodeId === config.nodeId) {
    const known = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, 'announcement', row.id), select: { entityId: true } });
    if (!known) await tx.examAnnouncement.updateMany({ where: { id: row.id, federationDirty: false }, data: { federationDirty: true, updatedAt: row.updatedAt } });
  }
  const questionDone = Boolean(state?.questionDone || !questions.length), announcementDone = Boolean(state?.announcementDone || !notices.length);
  const more = !questionDone || !announcementDone;
  const value = { after: more ? questions[questions.length - 1]?.id || after || '' : '', announcementAfter: more ? notices[notices.length - 1]?.id || state?.announcementAfter || '' : '', questionDone: more && questionDone, announcementDone: more && announcementDone, nextAt: more ? 0 : Date.now() + 30_000 };
  await tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return more;
}
/** Prefetching images and metadata is deliberately outside the exam transaction. */
export async function prepareCommunications(config: ExamFederation) {
  // Newly queued UUIDs must not jump ahead of older unattempted rows solely
  // because their random ID sorts earlier. Attempt time still rotates retries.
  const [questions, messages, announcements] = await settleReads([
    prisma.examQuestion.findMany({ where: { examId: config.examId, federationDirty: true }, select: { id: true, content: true, answer: true }, orderBy: [{ federationAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 8 }),
    prisma.examQuestionMessage.findMany({ where: { question: { examId: config.examId }, federationDirty: true },
      select: { id: true, content: true, question: { select: { id: true, initialMessageId: true, content: true } } }, orderBy: [{ federationAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 8 }),
    prisma.examAnnouncement.findMany({ where: { examId: config.examId, federationDirty: true }, select: { id: true, content: true, sourceQuestion: { select: { id: true, content: true } } },
      orderBy: [{ federationAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 8 }),
  ]);
  const ids = [...new Set([...questions.map(row => row.id), ...messages.map(row => row.question.id), ...announcements.flatMap(row => row.sourceQuestion ? [row.sourceQuestion.id] : [])])];
  const stored = ids.length ? await prisma.examFederationContent.findMany({ where: { examId: config.examId, kind: 'question', entityId: { in: ids } }, select: { entityId: true } }) : [];
  const known = new Set(stored.map(row => row.entityId));
  const contents = [
    ...questions.flatMap(row => known.has(row.id) ? [] : [row.content, row.answer || '']),
    ...messages.flatMap(row => [
      ...(known.has(row.question.id) && row.id === row.question.initialMessageId ? [] : [row.content]),
      ...(known.has(row.question.id) ? [] : [row.question.content]),
    ]),
    ...announcements.flatMap(row => [row.content, ...(row.sourceQuestion && !known.has(row.sourceQuestion.id) ? [row.sourceQuestion.content] : [])]),
  ];
  const assets = await prepareCommunicationAssets(config, contents);
  return { questions, messages, announcements, assets };
}
export async function materializeCommunications(tx: Tx, config: ExamFederation, prepared: Awaited<ReturnType<typeof prepareCommunications>>) {
  await installPreparedAssets(tx, config, prepared.assets);
  for (const row of prepared.questions) {
    await tx.examQuestion.updateMany({ where: { id: row.id }, data: { federationAttemptAt: new Date(), updatedAt: (await tx.examQuestion.findUniqueOrThrow({ where: { id: row.id }, select: { updatedAt: true } })).updatedAt } });
    await questionSnapshot(tx, config, row.id, prepared.assets);
  }
  for (const item of prepared.messages) {
    const row = await tx.examQuestionMessage.findUnique({ where: { id: item.id }, include: { createdBy: { select: { realName: true, nickname: true, username: true } } } });
    if (!row?.federationDirty) continue;
    if (row.threadOrder === 0n) {
      await tx.$queryRaw`SELECT id FROM ExamQuestion WHERE id = ${row.questionId} FOR UPDATE`;
      await ensureQuestionMessages(tx, row.questionId);
    }
    await tx.examQuestionMessage.update({ where: { id: row.id }, data: { federationAttemptAt: new Date() } });
    const question = await questionSnapshot(tx, config, row.questionId, prepared.assets); if (!question) continue;
    const initial = row.id === question.initialMessageId;
    if (initial) {
      const original = await tx.examQuestion.findUniqueOrThrow({ where: { id: row.questionId }, select: { content: true } });
      if (row.sender !== 'CANDIDATE' || row.content !== original.content) throw new FederationError('首问消息与原始提问不一致，不能覆盖已有追问，请核对历史记录');
    }
    const content = initial ? question.content : prepared.assets.rewrite(row.content); if (content === null) continue;
    // questionSnapshot may have repaired a legacy initial row's origin after
    // this row was read. Its immutable source is always the question's source.
    const origin = initial ? question.originNodeId : row.syncOriginNodeId || config.nodeId;
    if (origin !== config.nodeId) { await tx.examQuestionMessage.update({ where: { id: row.id }, data: { federationDirty: false } }); continue; }
    const threadOrder = initial ? BigInt(question.initialThreadOrder) : row.threadOrder || (await tx.examQuestionMessage.findUniqueOrThrow({ where: { id: row.id }, select: { threadOrder: true } })).threadOrder;
    const stored = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, 'message', row.id), select: { snapshot: true } });
    if (stored) {
      const prior = CommunicationSnapshotSchema.parse(stored.snapshot);
      if (prior.kind !== 'message' || prior.originNodeId !== origin || prior.question.id !== row.questionId || prior.sender !== row.sender || prior.content !== content || prior.threadOrder !== threadOrder.toString() || prior.createdAt !== (initial ? question.initialMessageCreatedAt : row.createdAt.toISOString())) throw new FederationError('已同步的答疑原始消息不允许改写');
      await tx.examQuestionMessage.update({ where: { id: row.id }, data: { federationDirty: false, syncOriginNodeId: origin } });
      continue;
    }
    await putCommunication(tx, config, { kind: 'message', id: row.id, originNodeId: origin, writerNodeId: origin, revision: 1,
      threadOrder: threadOrder.toString(), question, sender: row.sender, content, creatorLabel: row.sender === 'ADMIN' ? row.creatorLabel || qaAuthorLabel(row.createdBy) : null,
      createdAt: initial ? question.initialMessageCreatedAt : row.createdAt.toISOString() });
    await tx.examQuestionMessage.update({ where: { id: row.id }, data: { federationDirty: false, syncOriginNodeId: origin } });
  }
  for (const item of prepared.announcements) {
    const row = await tx.examAnnouncement.findUnique({ where: { id: item.id }, include: { candidate: { select: { examNumber: true, syncKey: true } }, createdBy: { select: { realName: true, nickname: true, username: true } } } });
    if (!row?.federationDirty) continue;
    if (config.managedGlobally && row.candidate && !row.candidate.syncKey) throw new FederationError('公告考生映射尚未同步，将自动重试');
    await tx.examAnnouncement.update({ where: { id: row.id }, data: { federationAttemptAt: new Date(), updatedAt: row.updatedAt } });
    const content = prepared.assets.rewrite(row.content); if (content === null) continue;
    const question = row.sourceQuestionId ? await questionSnapshot(tx, config, row.sourceQuestionId, prepared.assets) : null;
    if (row.sourceQuestionId && !question) continue;
    const origin = row.syncOriginNodeId || config.nodeId;
    if (origin !== config.nodeId) { await tx.examAnnouncement.update({ where: { id: row.id }, data: { federationDirty: false, updatedAt: row.updatedAt } }); continue; }
    const stored = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, 'announcement', row.id), select: { snapshot: true } });
    if (stored) {
      const prior = CommunicationSnapshotSchema.parse(stored.snapshot);
      if (prior.kind !== 'announcement' || prior.originNodeId !== origin || prior.content !== content || prior.question?.id !== (row.sourceQuestionId || undefined) || prior.sourcePublicationId !== row.sourcePublicationId || prior.createdAt !== row.createdAt.toISOString() || (config.managedGlobally ? (prior.candidateKey || null) !== (row.candidate?.syncKey || null) : prior.examNumber !== (row.candidate?.examNumber || null))) throw new FederationError('已同步的原始公告不允许改写');
      await tx.examAnnouncement.update({ where: { id: row.id }, data: { federationDirty: false, syncOriginNodeId: origin, updatedAt: row.updatedAt } });
      continue;
    }
    await putCommunication(tx, config, { kind: 'announcement', id: row.id, originNodeId: origin, writerNodeId: origin, revision: 1,
      candidateKey: row.candidate?.syncKey || undefined, examNumber: row.candidate?.examNumber ?? null, content, creatorLabel: row.creatorLabel || qaAuthorLabel(row.createdBy), createdAt: row.createdAt.toISOString(),
      question, sourcePublicationId: row.sourcePublicationId });
    await tx.examAnnouncement.update({ where: { id: row.id }, data: { federationDirty: false, syncOriginNodeId: origin, updatedAt: row.updatedAt } });
  }
}
function immutableQuestion(a: QuestionSnapshot, b: QuestionSnapshot, managedGlobally: boolean) {
  return a.initialThreadOrder === b.initialThreadOrder && a.initialMessageId === b.initialMessageId && a.initialMessageCreatedAt === b.initialMessageCreatedAt && a.id === b.id && a.originNodeId === b.originNodeId && a.candidateKey === b.candidateKey && (managedGlobally || a.examNumber === b.examNumber) && a.problemPid === b.problemPid
    && a.problemIndex === b.problemIndex && a.problemTitle === b.problemTitle && a.content === b.content && a.createdAt === b.createdAt;
}
async function mergeQuestion(tx: Tx, config: ExamFederation, value: QuestionSnapshot, prepared: PreparedAssets, sourceNodeId?: string) {
  await tx.$queryRaw`SELECT id FROM ExamQuestion WHERE id = ${value.id} FOR UPDATE`;
  const row = await tx.examQuestion.findUnique({ where: { id: value.id }, include: { candidate: { select: { examNumber: true, syncKey: true } } } });
  if (row && (row.id !== value.id || row.examId !== config.examId || (config.managedGlobally ? row.candidate.syncKey !== value.candidateKey : row.candidate.examNumber !== value.examNumber) || (row.syncOriginNodeId || config.nodeId) !== value.originNodeId)) throw new FederationError('问题编号或来源冲突');
  if (row?.federationDirty) {
    if (!await questionSnapshot(tx, config, value.id, prepared)) throw new FederationError('本地问题图片尚未整理完成，将在后续批次重试');
  }
  const old = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, 'question', value.id) });
  if (old) {
    const prior = CommunicationSnapshotSchema.parse(old.snapshot) as QuestionSnapshot;
    if (!immutableQuestion(prior, value, config.managedGlobally)) throw new FederationError('原始问题、考生身份和创建时间不允许改写');
    const version = compareSnapshotVersion(prior, value);
    if (version >= 0) {
      if (!version && old.payloadHash !== digest(value)) throw new FederationError('问题的同一版本内容不同');
      // Replays also repair visibility left behind by an older merge path.
      await reconcileQuestionPublication(tx, value.id, prior.isPublished, prior.publicationId);
      return;
    }
  }
  if (sourceNodeId && value.writerNodeId !== sourceNodeId) throw new FederationError('问题的更新版本尚未同步，请重试');
  if (!row && value.originNodeId === config.nodeId) throw new FederationError('本机原始问题缺失，请检查数据库备份');
  const candidate = config.managedGlobally ? await tx.candidate.findFirst({ where: { examId: config.examId, syncKey: value.candidateKey || '__missing' }, select: { id: true, examNumber: true } }) : await tx.candidate.findUnique({ where: { examId_examNumber: { examId: config.examId, examNumber: value.examNumber } }, select: { id: true, examNumber: true } });
  if (!candidate || (!config.managedGlobally && candidate.examNumber !== value.examNumber)) throw new FederationError('问题对应考号不一致');
  const mappedProblem = config.managedGlobally && value.problemPid ? await tx.examProblem.findFirst({ where: { examId: config.examId, syncKey: value.problemPid }, select: { hydroProblemId: true } }) : null;
  if (config.managedGlobally && value.problemPid && !mappedProblem) throw new FederationError('答疑题目映射尚未同步，将自动重试');
  const data = { initialMessageId: value.initialMessageId, isPublished: value.isPublished, publicationId: value.publicationId, federationDirty: false,
    federationRevision: value.revision - 1, syncOriginNodeId: value.originNodeId };
  if (row) await tx.examQuestion.update({ where: { id: value.id }, data });
  else {
    await tx.examQuestion.create({ data: { messageClock: BigInt(value.messageClock), id: value.id, examId: config.examId, candidateId: candidate.id, problemPid: config.managedGlobally && value.problemPid ? mappedProblem!.hydroProblemId : value.problemPid,
      problemIndex: value.problemIndex, problemTitle: value.problemTitle, content: value.content, createdAt: new Date(value.createdAt), ...data } });
    await tx.examQuestionMessage.create({ data: { id: value.initialMessageId, questionId: value.id, sender: 'CANDIDATE', threadOrder: BigInt(value.initialThreadOrder),
      content: value.content, createdAt: new Date(value.initialMessageCreatedAt), syncOriginNodeId: value.originNodeId, federationDirty: false } });
  }
  await tx.$executeRaw`UPDATE ExamQuestion SET messageClock = GREATEST(messageClock, ${BigInt(value.messageClock)}) WHERE id = ${value.id}`;
  await reconcileQuestionPublication(tx, value.id, value.isPublished, value.publicationId);
  await putCommunication(tx, config, value);
}
async function assetReferenceChecker(tx: Tx, examId: string, entries: CommunicationWire[]) {
  const pattern = /(?<![A-Za-z0-9:/])\/api\/qa-assets\/([a-f0-9-]{36})\?key=([A-Za-z0-9_-]{43})/gi;
  const contents = entries.flatMap(({ snapshot }) => snapshot.kind === 'asset' ? []
    : snapshot.kind === 'question' ? [snapshot.content] : [snapshot.content, ...(snapshot.question ? [snapshot.question.content] : [])]);
  const ids = [...new Set(contents.flatMap(content => [...content.matchAll(pattern)].map(match => match[1].toLowerCase())))];
  const assets = ids.length ? await tx.examFederationAsset.findMany({ where: { examId, id: { in: ids } }, select: { id: true, accessKeyHash: true } }) : [];
  const hashes = new Map(assets.map(asset => [asset.id.toLowerCase(), asset.accessKeyHash]));
  const keys = new Map<string, string>();
  return {
    check(content: string) {
      for (const match of content.matchAll(pattern)) {
        const expected = keys.get(match[2]) || keyHash(match[2]); keys.set(match[2], expected);
        if (hashes.get(match[1].toLowerCase()) !== expected) throw new FederationError('问题或公告的图片尚未同步，请重试');
      }
    },
    // Preserve wire order: a new asset only becomes available after its bytes
    // were installed in this transaction, never merely from its declaration.
    add(id: string, key: string) { hashes.set(id.toLowerCase(), keyHash(key)); },
  };
}
export async function mergeCommunications(tx: Tx, config: ExamFederation, entries: CommunicationWire[], buffers: Map<string, Buffer>, prepared: PreparedAssets, sourceNodeId?: string) {
  if (sourceNodeId && entries.some(({ snapshot }) => snapshot.writerNodeId !== sourceNodeId)) throw new FederationError('公告答疑的操作节点不一致');
  const references = await assetReferenceChecker(tx, config.examId, entries);
  for (const { snapshot: value } of entries) {
    if (value.kind === 'question') { references.check(value.content); await mergeQuestion(tx, config, value, prepared, sourceNodeId); continue; }
    const old = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, value.kind, value.id) });
    if (old) {
      if (old.payloadHash !== digest(value)) throw new FederationError('同一公告、消息或图片包含不同内容');
      if (value.kind === 'asset' && !await tx.examFederationAsset.findUnique({ where: { id: value.id }, select: { id: true } })) {
        const bytes = buffers.get(value.id);
        if (!bytes) throw new FederationError('同步图片原文件缺失，等待补传');
        await storeCommunicationAsset(tx, config, value, bytes);
        references.add(value.id, value.accessKey);
      }
      continue;
    }
    if (value.originNodeId !== value.writerNodeId || value.revision !== 1) throw new FederationError('消息、公告和图片是不可改写的原始记录');
    if (value.kind === 'asset') {
      const existing = await tx.examFederationAsset.findUnique({ where: { id: value.id }, select: { examId: true, originNodeId: true, sha256: true, byteSize: true, accessKeyHash: true } });
      if (existing) {
        if (existing.examId !== config.examId || existing.originNodeId !== value.originNodeId || existing.sha256 !== value.sha256 || existing.byteSize !== value.byteSize || existing.accessKeyHash !== keyHash(value.accessKey)) throw new FederationError('图片编号与其他来源冲突');
      } else {
        const bytes = buffers.get(value.id);
        if (!bytes) throw new FederationError('同步图片内容尚未准备完成，请重试');
        await storeCommunicationAsset(tx, config, value, bytes);
      }
      references.add(value.id, value.accessKey);
    } else {
      references.check(value.content);
      if (value.question) {
        references.check(value.question.content);
        await mergeQuestion(tx, config, value.question, prepared, sourceNodeId);
      }
      if (value.kind === 'message') {
        const legacyId = value.sender === 'ADMIN' && value.originNodeId !== config.nodeId
          ? legacyQuestionAnswerId(value.question.id, value.originNodeId, value.content) : value.id;
        // The exam/question lock does not exclude a student's receipt writer.
        // Read both the real and synthetic message only after locking them.
        await tx.$queryRaw`SELECT id FROM ExamQuestionMessage WHERE id IN (${value.id}, ${legacyId}) ORDER BY BINARY id FOR UPDATE`;
        const prior = await tx.examQuestionMessage.findUnique({ where: { id: value.id } });
        const priorOrigin = prior?.syncOriginNodeId || (value.id === value.question.initialMessageId ? value.question.originNodeId : config.nodeId);
        if (prior && (prior.id !== value.id || prior.questionId !== value.question.id || priorOrigin !== value.originNodeId || prior.content !== value.content || prior.sender !== value.sender)) throw new FederationError('答疑消息编号冲突');
        let legacyAcknowledgedAt: Date | null = null;
        if (value.sender === 'ADMIN' && value.originNodeId !== config.nodeId) {
          const legacy = legacyId !== value.id ? await tx.examQuestionMessage.findUnique({ where: { id: legacyId } }) : null;
          // Only a proven, unexported synthetic copy can be replaced by the
          // source's actual message. Independent real replies keep their IDs.
          if (legacy && legacy.questionId === value.question.id && legacy.sender === 'ADMIN' && !legacy.federationDirty
            && legacy.syncOriginNodeId === value.originNodeId && legacy.content === value.content
            && legacy.createdAt.toISOString() === value.createdAt && legacy.creatorLabel === value.creatorLabel) {
            const indexed = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, 'message', legacyId), select: { entityId: true } });
            const exam = await tx.exam.findUniqueOrThrow({ where: { id: config.examId }, select: { examCode: true } });
            const receipt = await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope: exam.examCode, kind: 'MESSAGE_RECEIPT', localId: legacyId } }, select: { id: true } });
            if (!indexed && !receipt) {
              const key = legacyMessageAliasKey(config.examId, legacyId), alias = { examId: config.examId, from: legacyId, to: value.id };
              const existing = await tx.systemSetting.findUnique({ where: { key } });
              if (existing && (existing.value as {to?:string}).to !== value.id) throw new FederationError('历史答疑消息已对应其他原始回复');
              await tx.systemSetting.upsert({ where: { key }, create: { key, value: alias }, update: {} });
              legacyAcknowledgedAt = legacy.acknowledgedAt; await tx.examQuestionMessage.delete({ where: { id: legacyId } });
            }
          }
        }
        if (prior) await tx.examQuestionMessage.update({ where: { id: value.id }, data: { threadOrder: BigInt(value.threadOrder), createdAt: new Date(value.createdAt), creatorLabel: value.creatorLabel, syncOriginNodeId: value.originNodeId, federationDirty: false } });
        if (!prior) await tx.examQuestionMessage.create({ data: { id: value.id, questionId: value.question.id, threadOrder: BigInt(value.threadOrder), sender: value.sender,
          content: value.content, creatorLabel: value.creatorLabel, acknowledgedAt: legacyAcknowledgedAt, deliveredAt: new Date(), createdAt: new Date(value.createdAt), syncOriginNodeId: value.originNodeId, federationDirty: false } });
        if (legacyAcknowledgedAt) await tx.$executeRaw`UPDATE ExamQuestionMessage SET acknowledgedAt = GREATEST(COALESCE(acknowledgedAt, ${legacyAcknowledgedAt}), ${legacyAcknowledgedAt}) WHERE id = ${value.id}`;
        await tx.$executeRaw`UPDATE ExamQuestion SET messageClock = GREATEST(messageClock, ${BigInt(value.threadOrder)}) WHERE id = ${value.question.id}`;
        await refreshQuestionSummary(tx, value.question.id);
      } else {
        if (await tx.examAnnouncement.findUnique({ where: { id: value.id }, select: { id: true } })) throw new FederationError('公告编号与本地记录冲突');
        const candidate = value.examNumber ? config.managedGlobally ? await tx.candidate.findFirst({ where: { examId: config.examId, syncKey: value.candidateKey || '__missing' } }) : await tx.candidate.findUnique({ where: { examId_examNumber: { examId: config.examId, examNumber: value.examNumber } } }) : null;
        if (value.examNumber && (!candidate || (!config.managedGlobally && candidate.examNumber !== value.examNumber))) throw new FederationError('公告对应考号不一致');
        const question = value.question ? await tx.examQuestion.findUniqueOrThrow({ where: { id: value.question.id }, select: { publicationId: true, isPublished: true } }) : null;
        await tx.examAnnouncement.create({ data: { id: value.id, examId: config.examId, candidateId: candidate?.id, content: value.content,
          creatorLabel: value.creatorLabel, deliveredAt: new Date(), createdAt: new Date(value.createdAt), syncOriginNodeId: value.originNodeId, federationDirty: false,
          sourceQuestionId: value.question?.id, sourcePublicationId: value.sourcePublicationId,
          withdrawn: Boolean(question && (!question.isPublished || question.publicationId !== value.sourcePublicationId)) } });
      }
    }
    await putCommunication(tx, config, value);
  }
}
export async function communicationPage(tx: Tx, config: ExamFederation, after: bigint, push: boolean, requester?: string) {
  if (after > config.contentSequence) throw new FederationError('公告答疑同步进度超出服务器历史');
  const rows = await tx.examFederationContent.findMany({ where: { examId: config.examId, sequence: { gt: after, lte: config.contentSequence },
    writerNodeId: push ? config.nodeId : { not: requester || config.nodeId } }, orderBy: { sequence: 'asc' }, take: 8 });
  return { rows, ceiling: config.contentSequence, after };
}
export async function buildCommunicationPage(page: Awaited<ReturnType<typeof communicationPage>>) { return communicationWire(page.rows, page.ceiling, page.after); }
