import { randomUUID } from 'node:crypto';
import { Prisma, type ContestSubmission, type ExamFederation } from '@prisma/client';
import { prisma } from './db';
import { syncProblemNumber } from './exam-federation-problems';
import { compareSnapshotVersion, digest, FederationError, SnapshotSchema, SYNC_BATCH, SYNC_BYTES, type SyncSnapshot } from './exam-federation-protocol';

export const federationChange = () => ({ federationDirty: true, federationRevision: { increment: 1 }, federationWriteToken: randomUUID() } as const);
export async function federationTransaction<T>(examId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
        return work(tx);
      }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 15000 });
    } catch (error) {
      if (attempt >= 2 || (error as { code?: string })?.code !== 'P2034') throw error;
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}
function snapshot(row: ContestSubmission & { problem: { order: number; hydroProblemId: string } }, nodeId: string, problemNumber: string): SyncSnapshot {
  return SnapshotSchema.parse({
    id: row.id, originNodeId: row.syncOriginNodeId || nodeId, writerNodeId: nodeId, revision: row.federationRevision + 1,
    examNumber: row.candidateExamNumber, problemOrder: row.problem.order, problemNumber,
    lang: row.lang, code: row.code, status: row.status, statusText: row.statusText, score: row.score,
    manualScore: row.manualScore, manualScoreUpdatedAt: row.manualScoreUpdatedAt?.toISOString() ?? null,
    totalTestCases: row.totalTestCases, passedTestCases: row.passedTestCases, time: row.time, memory: row.memory,
    testCases: row.testCases, subtasks: row.subtasks, judgeAt: row.judgeAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  });
}
async function putEntry(tx: Prisma.TransactionClient, config: ExamFederation, value: SyncSnapshot) {
  const { sequence } = await tx.examFederation.update({ where: { examId: config.examId }, data: { sequence: { increment: 1 } }, select: { sequence: true } });
  const identity = { examId: config.examId, originNodeId: value.originNodeId, submissionId: value.id };
  const existing = await tx.examFederationEntry.findUnique({ where: { submissionId: value.id }, select: { submissionId: true, examId: true, originNodeId: true } });
  const data = { writerNodeId: value.writerNodeId, revision: value.revision, sequence, payloadHash: digest(value), snapshot: value as Prisma.InputJsonValue };
  if (existing) {
    if (existing.submissionId !== value.id || existing.examId !== config.examId || existing.originNodeId !== value.originNodeId) throw new FederationError('提交编号存在来源冲突');
    await tx.examFederationEntry.update({ where: { examId_originNodeId_submissionId: identity }, data });
  } else await tx.examFederationEntry.create({ data: { ...identity, ...data } });
}
type SourceRow = ContestSubmission & { problem: { order: number; hydroProblemId: string }; candidate: { examNumber: string } };
async function materializeRow(tx: Prisma.TransactionClient, config: ExamFederation, row: SourceRow, number: ReturnType<typeof syncProblemNumber>) {
  const value = snapshot({ ...row, candidateExamNumber: row.candidate.examNumber }, config.nodeId, number(row.problem));
  if (Buffer.byteLength(JSON.stringify(value)) > SYNC_BYTES - 1024 * 1024) throw new FederationError('单条提交的评测详情过大，请检查判题结果');
  const old = await tx.examFederationEntry.findUnique({ where: { submissionId: row.id } });
  if (old && (old.originNodeId !== value.originNodeId || old.examId !== config.examId)) throw new FederationError('提交编号存在来源冲突');
  const prior = old ? SnapshotSchema.parse(old.snapshot) : null;
  if (!prior || compareSnapshotVersion(value, prior) > 0) await putEntry(tx, config, value);
  else if (compareSnapshotVersion(value, prior) < 0 || old!.payloadHash !== digest(value)) throw new FederationError('提交版本内容冲突，请检查本机数据库');
  // Origin is immutable metadata. A concurrent judge update may prevent clearing
  // dirty, but must not leave an already exported original without its origin.
  // Raw SQL intentionally leaves updatedAt untouched for other delta consumers.
  await tx.$executeRaw`UPDATE ContestSubmission SET syncOriginNodeId = ${value.originNodeId} WHERE id = ${row.id} AND syncOriginNodeId IS NULL`;
  await tx.contestSubmission.updateMany({ where: { id: row.id, federationRevision: row.federationRevision },
    data: { syncOriginNodeId: value.originNodeId, federationDirty: false, updatedAt: row.updatedAt } });
}
/** Both original submissions and locally rejudged replicas can produce a newer result snapshot. */
export async function materializeSubmissions(tx: Prisma.TransactionClient, config: ExamFederation) {
  const rows = await tx.contestSubmission.findMany({ where: { examId: config.examId, federationDirty: true },
    include: { problem: { select: { order: true, hydroProblemId: true } }, candidate: { select: { examNumber: true } } }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: SYNC_BATCH });
  const number = syncProblemNumber(config);
  for (const row of rows) await materializeRow(tx, config, row, number);
}
/** Called only while holding the Exam lock. Imports never acquire a local Hydro record or enter its judge queue. */
export async function mergeSnapshots(tx: Prisma.TransactionClient, config: ExamFederation, entries: SyncSnapshot[], sourceNodeId?: string) {
  const number = syncProblemNumber(config);
  for (const value of entries) {
    if (sourceNodeId && value.writerNodeId !== sourceNodeId) throw new FederationError('提交更新的操作节点不一致');
    // Serialize a remote import with result writers. Flush any newer local result
    // before comparing versions, including a result not yet picked up by the timer.
    await tx.$queryRaw`SELECT id FROM ContestSubmission WHERE id = ${value.id} FOR UPDATE`;
    const occupied = await tx.contestSubmission.findUnique({ where: { id: value.id },
      include: { problem: { select: { order: true, hydroProblemId: true } }, candidate: { select: { examNumber: true } } } });
    const occupiedOrigin = occupied?.syncOriginNodeId || (occupied && !occupied.syncImported ? config.nodeId : null);
    if (occupied && (occupied.id !== value.id || occupied.examId !== config.examId || occupiedOrigin !== value.originNodeId)) throw new FederationError('提交编号与本地记录来源冲突');
    if (occupied?.federationDirty) await materializeRow(tx, config, occupied, number);
    const existing = await tx.examFederationEntry.findUnique({ where: { submissionId: value.id } });
    if (existing) {
      if (existing.submissionId !== value.id || existing.examId !== config.examId || existing.originNodeId !== value.originNodeId) throw new FederationError('提交编号已被其他来源使用');
      const version = compareSnapshotVersion(SnapshotSchema.parse(existing.snapshot), value);
      if (version > 0) continue;
      if (version === 0) {
        if (existing.payloadHash !== digest(value)) throw new FederationError('同一提交版本包含不同内容');
        continue;
      }
      const prior = SnapshotSchema.parse(existing.snapshot);
      if (prior.examNumber !== value.examNumber || prior.problemOrder !== value.problemOrder || prior.problemNumber !== value.problemNumber
        || prior.createdAt !== value.createdAt || prior.code !== value.code) throw new FederationError('原始提交身份、时间和代码不允许在重测时修改');
    }
    if (!existing && sourceNodeId && value.originNodeId !== sourceNodeId) throw new FederationError('远端重测必须对应已经同步的原始提交');
    if (!occupied && value.originNodeId === config.nodeId) throw new FederationError('本机原始提交缺失，请检查是否恢复了不完整备份');
    const candidate = await tx.candidate.findUnique({ where: { examId_examNumber: { examId: config.examId, examNumber: value.examNumber } } });
    const problem = await tx.examProblem.findUnique({ where: { examId_order: { examId: config.examId, order: value.problemOrder } } });
    const exam = await tx.exam.findUniqueOrThrow({ where: { id: config.examId }, select: { examCode: true } });
    if (!candidate || candidate.examNumber !== value.examNumber || !problem || number(problem) !== value.problemNumber) throw new FederationError('提交对应的考号或题号映射不一致，同步已暂停');
    if (value.manualScore !== null && value.manualScore > problem.score) throw new FederationError('同步的人工评分超过题目满分');
    const data = {
      examId: config.examId, candidateId: candidate.id, problemId: problem.id, candidateExamNumber: candidate.examNumber,
      candidateName: candidate.name, teamName: candidate.teamName, teamMembers: candidate.teamMembers, teamMemberStudentIds: candidate.teamMemberStudentIds,
      actorKey: `${exam.examCode}:${candidate.examNumber}`, hydroRecordId: null, deferredJudge: false, judgeClaimedAt: null, judgeError: null,
      lang: value.lang, code: value.code, status: value.status, statusText: value.statusText, score: value.score, manualScore: value.manualScore,
      manualScoreUpdatedAt: value.manualScoreUpdatedAt ? new Date(value.manualScoreUpdatedAt) : null,
      totalTestCases: value.totalTestCases, passedTestCases: value.passedTestCases, time: value.time, memory: value.memory,
      testCases: (value.testCases ?? Prisma.JsonNull) as Prisma.InputJsonValue, subtasks: (value.subtasks ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      judgeAt: value.judgeAt ? new Date(value.judgeAt) : null, createdAt: new Date(value.createdAt),
      syncImported: occupied?.syncImported ?? true, syncOriginNodeId: value.originNodeId, federationDirty: false, federationRevision: value.revision - 1, federationWriteToken: randomUUID(), judgeForced: false,
    };
    if (occupied) {
      const changed = await tx.contestSubmission.updateMany({ where: { id: value.id, examId: config.examId, syncOriginNodeId: value.originNodeId }, data });
      if (!changed.count) throw new FederationError('提交来源已改变，不能覆盖本地记录');
    } else await tx.contestSubmission.create({ data: { id: value.id, ...data } });
    await putEntry(tx, config, value);
  }
}
/** Advance over filtered rows too. Cursors refer to committed sequence numbers, never timestamps. */
export async function readSyncPage(tx: Prisma.TransactionClient, config: ExamFederation, after: bigint, mode: 'push' | 'pull', requester?: string) {
  if (after > config.sequence) throw new FederationError('同步进度超出服务器历史，请检查是否恢复了旧数据库备份');
  const rows = await tx.examFederationEntry.findMany({ where: { examId: config.examId, sequence: { gt: after, lte: config.sequence },
    writerNodeId: mode === 'push' ? config.nodeId : { not: requester || config.nodeId } },
    orderBy: { sequence: 'asc' }, take: SYNC_BATCH });
  const entries: SyncSnapshot[] = []; let cursor = after, size = 1024, consumed = 0;
  for (const row of rows) {
    const value = SnapshotSchema.parse(row.snapshot), bytes = Buffer.byteLength(JSON.stringify(value));
    if (size + bytes > SYNC_BYTES - 512 * 1024 && entries.length) break;
    size += bytes; entries.push(value); consumed++; cursor = row.sequence;
  }
  // Rows belonging to other writers can be skipped: a later modification gets
  // a new sequence and can never appear behind the committed cursor.
  if (consumed === rows.length && rows.length < SYNC_BATCH) cursor = config.sequence;
  return { entries, after: cursor.toString() };
}
