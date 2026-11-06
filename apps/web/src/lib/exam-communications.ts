import { randomUUID } from 'node:crypto';
import type { ExamFederation, Prisma } from '@prisma/client';
import { prisma } from './db';
import { compareSnapshotVersion, digest, FederationError, keyHash } from './exam-federation-protocol';
import { CommunicationSnapshotSchema, QuestionSnapshotSchema, type CommunicationWire, type QuestionSnapshot } from './exam-communication-protocol';
import { contentIdentity, putCommunication } from './exam-communication-entry';
import { communicationWire, installPreparedAssets, prepareCommunicationAssets, storeCommunicationAsset, type PreparedAssets } from './exam-communication-assets';
import { ensureQuestionMessages, qaAuthorLabel, refreshQuestionSummary } from './qa-thread';
import { settleReads } from './request-admission';

type Tx = Prisma.TransactionClient;
async function questionSnapshot(tx: Tx, config: ExamFederation, id: string, assets: PreparedAssets): Promise<QuestionSnapshot | null> {
  await tx.$queryRaw`SELECT id FROM ExamQuestion WHERE id = ${id} FOR UPDATE`;
  const row = await tx.examQuestion.findUniqueOrThrow({ where: { id }, include: { candidate: { select: { examNumber: true } } } });
  if (row.examId !== config.examId) throw new FederationError('问题不属于当前考试');
  const prior = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, 'question', id) });
  let original = prior ? QuestionSnapshotSchema.parse(prior.snapshot) : null;
  if (original && (original.id !== id || original.examNumber !== row.candidate.examNumber || original.originNodeId !== (row.syncOriginNodeId || config.nodeId))) throw new FederationError('原始问题身份与同步历史不一致');
  if (!row.federationDirty && original) return original;
  // Existing immutable originals still need missing legacy answer messages
  // seeded before metadata export; reuse the original text and identity below.
  const seeded = await ensureQuestionMessages(tx, id);
  if (!original) {
    const initial = await tx.examQuestionMessage.findUniqueOrThrow({ where: { id: seeded.initialMessageId! }, select: { createdAt: true, threadOrder: true } });
    const content = assets.rewrite(row.content); if (content === null) return null;
    original = { kind: 'question', id, originNodeId: row.syncOriginNodeId || config.nodeId, writerNodeId: config.nodeId,
      revision: 1, initialMessageId: seeded.initialMessageId!, initialMessageCreatedAt: initial.createdAt.toISOString(),
      initialThreadOrder: initial.threadOrder.toString(), messageClock: initial.threadOrder.toString(),
      examNumber: row.candidate.examNumber, problemPid: row.problemPid, problemIndex: row.problemIndex, problemTitle: row.problemTitle,
      content, createdAt: row.createdAt.toISOString(), isPublished: false, publicationId: null };
  }
  const { messageClock } = await tx.examQuestion.findUniqueOrThrow({ where: { id }, select: { messageClock: true } });
  const publicationId = row.isPublished ? row.publicationId || randomUUID() : null;
  // Re-publication changes metadata only. URL normalization and a later
  // storage move must never rewrite the already synchronized original text.
  const value: QuestionSnapshot = { ...original, writerNodeId: config.nodeId, revision: row.federationRevision + 1,
    messageClock: messageClock.toString(), isPublished: row.isPublished, publicationId };
  await putCommunication(tx, config, value);
  await tx.examQuestion.update({ where: { id }, data: { initialMessageId: value.initialMessageId, syncOriginNodeId: value.originNodeId, federationDirty: false, publicationId, updatedAt: row.updatedAt } });
  return value;
}
/** Prefetching images and metadata is deliberately outside the exam transaction. */
export async function prepareCommunications(config: ExamFederation) {
  const [questions, messages, announcements] = await settleReads([
    prisma.examQuestion.findMany({ where: { examId: config.examId, federationDirty: true }, select: { id: true, content: true, answer: true }, orderBy: [{ federationAttemptAt: 'asc' }, { id: 'asc' }], take: 8 }),
    prisma.examQuestionMessage.findMany({ where: { question: { examId: config.examId }, federationDirty: true },
      select: { id: true, content: true, question: { select: { id: true, initialMessageId: true, content: true } } }, orderBy: [{ federationAttemptAt: 'asc' }, { id: 'asc' }], take: 8 }),
    prisma.examAnnouncement.findMany({ where: { examId: config.examId, federationDirty: true }, select: { id: true, content: true, sourceQuestion: { select: { id: true, content: true } } },
      orderBy: [{ federationAttemptAt: 'asc' }, { id: 'asc' }], take: 8 }),
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
    const origin = row.syncOriginNodeId || config.nodeId;
    if (origin !== config.nodeId) { await tx.examQuestionMessage.update({ where: { id: row.id }, data: { federationDirty: false } }); continue; }
    const threadOrder = initial ? BigInt(question.initialThreadOrder) : row.threadOrder || (await tx.examQuestionMessage.findUniqueOrThrow({ where: { id: row.id }, select: { threadOrder: true } })).threadOrder;
    await putCommunication(tx, config, { kind: 'message', id: row.id, originNodeId: origin, writerNodeId: origin, revision: 1,
      threadOrder: threadOrder.toString(), question, sender: row.sender, content, creatorLabel: row.sender === 'ADMIN' ? row.creatorLabel || qaAuthorLabel(row.createdBy) : null,
      createdAt: initial ? question.initialMessageCreatedAt : row.createdAt.toISOString() });
    await tx.examQuestionMessage.update({ where: { id: row.id }, data: { federationDirty: false, syncOriginNodeId: origin } });
  }
  for (const item of prepared.announcements) {
    const row = await tx.examAnnouncement.findUnique({ where: { id: item.id }, include: { candidate: { select: { examNumber: true } }, createdBy: { select: { realName: true, nickname: true, username: true } } } });
    if (!row?.federationDirty) continue;
    await tx.examAnnouncement.update({ where: { id: row.id }, data: { federationAttemptAt: new Date(), updatedAt: row.updatedAt } });
    const content = prepared.assets.rewrite(row.content); if (content === null) continue;
    const question = row.sourceQuestionId ? await questionSnapshot(tx, config, row.sourceQuestionId, prepared.assets) : null;
    if (row.sourceQuestionId && !question) continue;
    const origin = row.syncOriginNodeId || config.nodeId;
    if (origin !== config.nodeId) { await tx.examAnnouncement.update({ where: { id: row.id }, data: { federationDirty: false, updatedAt: row.updatedAt } }); continue; }
    await putCommunication(tx, config, { kind: 'announcement', id: row.id, originNodeId: origin, writerNodeId: origin, revision: 1,
      examNumber: row.candidate?.examNumber ?? null, content, creatorLabel: row.creatorLabel || qaAuthorLabel(row.createdBy), createdAt: row.createdAt.toISOString(),
      question, sourcePublicationId: row.sourcePublicationId });
    await tx.examAnnouncement.update({ where: { id: row.id }, data: { federationDirty: false, syncOriginNodeId: origin, updatedAt: row.updatedAt } });
  }
}
function immutableQuestion(a: QuestionSnapshot, b: QuestionSnapshot) {
  return a.initialThreadOrder === b.initialThreadOrder && a.initialMessageId === b.initialMessageId && a.initialMessageCreatedAt === b.initialMessageCreatedAt && a.id === b.id && a.originNodeId === b.originNodeId && a.examNumber === b.examNumber && a.problemPid === b.problemPid
    && a.problemIndex === b.problemIndex && a.problemTitle === b.problemTitle && a.content === b.content && a.createdAt === b.createdAt;
}
async function mergeQuestion(tx: Tx, config: ExamFederation, value: QuestionSnapshot, prepared: PreparedAssets, sourceNodeId?: string) {
  await tx.$queryRaw`SELECT id FROM ExamQuestion WHERE id = ${value.id} FOR UPDATE`;
  const row = await tx.examQuestion.findUnique({ where: { id: value.id }, include: { candidate: { select: { examNumber: true } } } });
  if (row && (row.id !== value.id || row.examId !== config.examId || row.candidate.examNumber !== value.examNumber || (row.syncOriginNodeId || config.nodeId) !== value.originNodeId)) throw new FederationError('问题编号或来源冲突');
  if (row?.federationDirty) {
    if (!await questionSnapshot(tx, config, value.id, prepared)) throw new FederationError('本地问题图片尚未整理完成，将在后续批次重试');
  }
  const old = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, 'question', value.id) });
  if (old) {
    const prior = CommunicationSnapshotSchema.parse(old.snapshot) as QuestionSnapshot;
    if (!immutableQuestion(prior, value)) throw new FederationError('原始问题、考号和创建时间不允许改写');
    const version = compareSnapshotVersion(prior, value);
    if (version > 0) return;
    if (!version) { if (old.payloadHash !== digest(value)) throw new FederationError('问题的同一版本内容不同'); return; }
  }
  if (sourceNodeId && value.writerNodeId !== sourceNodeId) throw new FederationError('问题的更新版本尚未同步，请重试');
  if (!row && value.originNodeId === config.nodeId) throw new FederationError('本机原始问题缺失，请检查数据库备份');
  const candidate = await tx.candidate.findUnique({ where: { examId_examNumber: { examId: config.examId, examNumber: value.examNumber } }, select: { id: true, examNumber: true } });
  if (!candidate || candidate.examNumber !== value.examNumber) throw new FederationError('问题对应考号不一致');
  const data = { initialMessageId: value.initialMessageId, isPublished: value.isPublished, publicationId: value.publicationId, federationDirty: false,
    federationRevision: value.revision - 1, syncOriginNodeId: value.originNodeId };
  if (row) await tx.examQuestion.update({ where: { id: value.id }, data });
  else {
    await tx.examQuestion.create({ data: { messageClock: BigInt(value.messageClock), id: value.id, examId: config.examId, candidateId: candidate.id, problemPid: value.problemPid,
      problemIndex: value.problemIndex, problemTitle: value.problemTitle, content: value.content, createdAt: new Date(value.createdAt), ...data } });
    await tx.examQuestionMessage.create({ data: { id: value.initialMessageId, questionId: value.id, sender: 'CANDIDATE', threadOrder: BigInt(value.initialThreadOrder),
      content: value.content, createdAt: new Date(value.initialMessageCreatedAt), syncOriginNodeId: value.originNodeId, federationDirty: false } });
  }
  await tx.$executeRaw`UPDATE ExamQuestion SET messageClock = GREATEST(messageClock, ${BigInt(value.messageClock)}) WHERE id = ${value.id}`;
  await tx.examAnnouncement.updateMany({ where: { sourceQuestionId: value.id,
    ...(value.publicationId ? { sourcePublicationId: { not: value.publicationId } } : {}) }, data: { withdrawn: true } });
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
      continue;
    }
    if (value.originNodeId !== value.writerNodeId || value.revision !== 1) throw new FederationError('消息、公告和图片是不可改写的原始记录');
    if (value.kind === 'asset') {
      if (await tx.examFederationAsset.findUnique({ where: { id: value.id }, select: { id: true } })) throw new FederationError('图片编号与其他来源冲突');
      const bytes = buffers.get(value.id);
      if (!bytes) throw new FederationError('同步图片内容尚未准备完成，请重试');
      await storeCommunicationAsset(tx, config, value, bytes);
      references.add(value.id, value.accessKey);
    } else {
      references.check(value.content);
      if (value.question) {
        references.check(value.question.content);
        await mergeQuestion(tx, config, value.question, prepared, sourceNodeId);
      }
      if (value.kind === 'message') {
        const prior = await tx.examQuestionMessage.findUnique({ where: { id: value.id } });
        if (prior && (prior.id !== value.id || prior.questionId !== value.question.id || (prior.syncOriginNodeId || config.nodeId) !== value.originNodeId || prior.content !== value.content || prior.sender !== value.sender)) throw new FederationError('答疑消息编号冲突');
        if (prior) await tx.examQuestionMessage.update({ where: { id: value.id }, data: { threadOrder: BigInt(value.threadOrder), createdAt: new Date(value.createdAt), creatorLabel: value.creatorLabel } });
        if (!prior) await tx.examQuestionMessage.create({ data: { id: value.id, questionId: value.question.id, threadOrder: BigInt(value.threadOrder), sender: value.sender,
          content: value.content, creatorLabel: value.creatorLabel, deliveredAt: new Date(), createdAt: new Date(value.createdAt), syncOriginNodeId: value.originNodeId, federationDirty: false } });
        await tx.$executeRaw`UPDATE ExamQuestion SET messageClock = GREATEST(messageClock, ${BigInt(value.threadOrder)}) WHERE id = ${value.question.id}`;
        await refreshQuestionSummary(tx, value.question.id);
      } else {
        if (await tx.examAnnouncement.findUnique({ where: { id: value.id }, select: { id: true } })) throw new FederationError('公告编号与本地记录冲突');
        const candidate = value.examNumber ? await tx.candidate.findUnique({ where: { examId_examNumber: { examId: config.examId, examNumber: value.examNumber } } }) : null;
        if (value.examNumber && candidate?.examNumber !== value.examNumber) throw new FederationError('公告对应考号不一致');
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
