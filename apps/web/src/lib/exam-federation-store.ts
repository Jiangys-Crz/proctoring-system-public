import { randomUUID } from 'node:crypto';
import { Prisma, type ContestSubmission, type ExamFederation } from '@prisma/client';
import { prisma } from './db';
import { assertPlatformLease } from './platform-sync-lock';
import { syncProblemNumber } from './exam-federation-problems';
import { sameJudgement } from './contest-judgement';
import { compareSnapshotVersion, digest, FederationError, SnapshotSchema, SYNC_BATCH, SYNC_BYTES, type SyncSnapshot } from './exam-federation-protocol';

export const federationChange = () => ({ federationDirty: true, federationAttemptAt: null, federationError: null, federationRevision: { increment: 1 }, federationWriteToken: randomUUID() } as const);
export async function federationTransaction<T>(examId: string, work: (tx: Prisma.TransactionClient) => Promise<T>, timeout = 15000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await assertPlatformLease(tx);
        await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
        const result = await work(tx);
        await assertPlatformLease(tx);
        return result;
      }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout });
    } catch (error) {
      if (attempt >= 2 || (error as { code?: string })?.code !== 'P2034') throw error;
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}
function snapshot(row: ContestSubmission & { candidateKey?: string; problem: { order: number; hydroProblemId: string; syncKey?: string | null } }, nodeId: string, problemNumber: string): SyncSnapshot {
  return SnapshotSchema.parse({
    id: row.id, originNodeId: row.syncOriginNodeId || nodeId, writerNodeId: nodeId, revision: row.federationRevision + 1,
    ...(row.candidateKey ? { candidateKey: row.candidateKey } : {}),
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
async function retainSubmissionConflict(tx: Prisma.TransactionClient, examId: string, value: SyncSnapshot) {
  // This is recovery history, not an outgoing transport entry. Replaying the
  // same losing version must neither grow the journal nor resend the result.
  const saved = { examId, snapshot: value };
  const key = `submission-conflict:${digest({ examId, hash: digest(value) })}`;
  await tx.systemSetting.upsert({ where: { key }, create: { key, value: saved as Prisma.InputJsonValue }, update: {} });
}
type SourceRow = ContestSubmission & { problem: { order: number; hydroProblemId: string; syncKey?: string | null }; candidate: { examNumber: string; syncKey: string | null } };
async function materializeRow(tx: Prisma.TransactionClient, config: ExamFederation, row: SourceRow, number: ReturnType<typeof syncProblemNumber>) {
  // An incomplete identity must stay queued. Exporting it would leave an
  // immutable original that the receiving node can never map to a candidate.
  if (config.managedGlobally && !row.candidate.syncKey) throw new FederationError('提交对应的考生映射尚未同步，将自动重试');
  const value = snapshot({ ...row, candidateKey: row.candidate.syncKey || undefined, candidateExamNumber: row.candidate.examNumber }, config.nodeId, number(row.problem));
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
    data: { syncOriginNodeId: value.originNodeId, federationDirty: false, federationAttemptAt: null, federationError: null, updatedAt: row.updatedAt } });
}
/** Both original submissions and locally rejudged replicas can produce a newer result snapshot. */
export async function materializeSubmission(tx: Prisma.TransactionClient, config: ExamFederation, id: string) {
  // One independent transaction per row; a poisoned result must not roll back
  // healthy records or leave a whole page of large code/case bodies in memory.
  await tx.$queryRaw`SELECT id FROM ContestSubmission WHERE id = ${id} AND examId = ${config.examId} FOR UPDATE`;
  const row = await tx.contestSubmission.findFirst({ where: { id, examId: config.examId, federationDirty: true },
    include: { problem: { select: { order: true, hydroProblemId: true, syncKey: true } }, candidate: { select: { examNumber: true, syncKey: true } } } });
  if (row) await materializeRow(tx, config, row, syncProblemNumber(config));
}
/** Called only while holding the Exam lock. New imports never acquire a local Hydro record or enter its judge queue. */
export async function mergeSnapshots(tx: Prisma.TransactionClient, config: ExamFederation, entries: SyncSnapshot[], sourceNodeId?: string) {
  const number = syncProblemNumber(config);
  for (const value of entries) {
    if (sourceNodeId && value.writerNodeId !== sourceNodeId) throw new FederationError('提交更新的操作节点不一致');
    // Serialize a remote import with result writers. Flush any newer local result
    // before comparing versions, including a result not yet picked up by the timer.
    await tx.$queryRaw`SELECT id FROM ContestSubmission WHERE id = ${value.id} FOR UPDATE`;
    const occupied = await tx.contestSubmission.findUnique({ where: { id: value.id },
      include: { problem: { select: { order: true, hydroProblemId: true, syncKey: true } }, candidate: { select: { examNumber: true, syncKey: true } } } });
    const occupiedOrigin = occupied?.syncOriginNodeId || (occupied && !occupied.syncImported ? config.nodeId : null);
    if (occupied && (occupied.id !== value.id || occupied.examId !== config.examId || occupiedOrigin !== value.originNodeId)) throw new FederationError('提交编号与本地记录来源冲突');
    const hadLocalChanges = Boolean(occupied?.federationDirty);
    if (occupied?.federationDirty) await materializeRow(tx, config, occupied, number);
    const existing = await tx.examFederationEntry.findUnique({ where: { submissionId: value.id } });
    if (existing) {
      if (existing.submissionId !== value.id || existing.examId !== config.examId || existing.originNodeId !== value.originNodeId) throw new FederationError('提交编号已被其他来源使用');
      const prior = SnapshotSchema.parse(existing.snapshot);
      const version = compareSnapshotVersion(prior, value);
      // Independent grading/rejudging can race on both nodes. The stable
      // winner still drives both boards; retain the losing concurrent result,
      // including manual grades, before it is overwritten or acknowledged.
      if (prior.writerNodeId !== value.writerNodeId && (hadLocalChanges || prior.revision === value.revision)) {
        await retainSubmissionConflict(tx, config.examId, version > 0 ? value : prior);
      }
      if (version > 0) continue;
      if (version === 0) {
        if (existing.payloadHash !== digest(value)) throw new FederationError('同一提交版本包含不同内容');
        continue;
      }
      if ((config.managedGlobally ? prior.candidateKey !== value.candidateKey || prior.problemNumber !== value.problemNumber : prior.examNumber !== value.examNumber || prior.problemOrder !== value.problemOrder || prior.problemNumber !== value.problemNumber)
        || prior.createdAt !== value.createdAt || prior.code !== value.code) throw new FederationError('原始提交身份、时间和代码不允许在重测时修改');
    }
    if (!existing && sourceNodeId && value.originNodeId !== sourceNodeId) throw new FederationError('远端重测必须对应已经同步的原始提交');
    if (!occupied && value.originNodeId === config.nodeId) throw new FederationError('本机原始提交缺失，请检查是否恢复了不完整备份');
    const candidate = config.managedGlobally ? await tx.candidate.findFirst({ where: { examId: config.examId, syncKey: value.candidateKey || '__missing' } }) : await tx.candidate.findUnique({ where: { examId_examNumber: { examId: config.examId, examNumber: value.examNumber } } });
    const problem = config.managedGlobally ? await tx.examProblem.findFirst({ where: { examId: config.examId, syncKey: value.problemNumber } }) : await tx.examProblem.findUnique({ where: { examId_order: { examId: config.examId, order: value.problemOrder } } });
    const exam = await tx.exam.findUniqueOrThrow({ where: { id: config.examId }, select: { examCode: true } });
    if (!candidate || (!config.managedGlobally && candidate.examNumber !== value.examNumber) || !problem || number(problem) !== value.problemNumber) throw new FederationError('提交对应的考号或题号映射不一致，同步已暂停');
    // Points and results travel in independent streams. Preserve an already
    // valid historical grade even if a points edit arrived before/after it.
    // New manual grades are bounded by the grading endpoint at the writer.
    // A peer can change just the manual grade. Keep this node's Hydro record
    // and queued/claimed task when the underlying judgement is unchanged.
    // Actual remote rejudges/cancellations invalidate those local handles.
    const hasLocalJudge = occupied && (occupied.hydroRecordId || occupied.deferredJudge || occupied.judgeClaimedAt || occupied.judgeError || occupied.judgeForced);
    const localJudge = hasLocalJudge && sameJudgement(occupied, value) ? {
      hydroRecordId: occupied.hydroRecordId, deferredJudge: occupied.deferredJudge,
      judgeClaimedAt: occupied.judgeClaimedAt, judgeError: occupied.judgeError, judgeForced: occupied.judgeForced,
    } : { hydroRecordId: null, deferredJudge: false, judgeClaimedAt: null, judgeError: null, judgeForced: false };
    const data = {
      examId: config.examId, candidateId: candidate.id, problemId: problem.id, candidateExamNumber: candidate.examNumber,
      candidateName: candidate.name, teamName: candidate.teamName, teamMembers: candidate.teamMembers, teamMemberStudentIds: candidate.teamMemberStudentIds,
      actorKey: `${exam.examCode}:${candidate.examNumber}`, ...localJudge,
      lang: value.lang, code: value.code, status: value.status, statusText: value.statusText, score: value.score, manualScore: value.manualScore,
      manualScoreUpdatedAt: value.manualScoreUpdatedAt ? new Date(value.manualScoreUpdatedAt) : null,
      totalTestCases: value.totalTestCases, passedTestCases: value.passedTestCases, time: value.time, memory: value.memory,
      testCases: (value.testCases ?? Prisma.JsonNull) as Prisma.InputJsonValue, subtasks: (value.subtasks ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      judgeAt: value.judgeAt ? new Date(value.judgeAt) : null, createdAt: new Date(value.createdAt),
      syncImported: occupied?.syncImported ?? true, syncOriginNodeId: value.originNodeId, federationDirty: false, federationAttemptAt: null, federationError: null, federationRevision: value.revision - 1, federationWriteToken: randomUUID(),
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
    select: { submissionId: true, sequence: true }, orderBy: { sequence: 'asc' }, take: SYNC_BATCH });
  const entries: SyncSnapshot[] = []; let cursor = after, size = 1024, consumed = 0;
  for (const row of rows) {
    const stored = await tx.examFederationEntry.findUniqueOrThrow({ where: { submissionId: row.submissionId }, select: { snapshot: true } });
    const value = SnapshotSchema.parse(stored.snapshot), bytes = Buffer.byteLength(JSON.stringify(value));
    if (size + bytes > SYNC_BYTES - 512 * 1024 && entries.length) break;
    size += bytes; entries.push(value); consumed++; cursor = row.sequence;
  }
  // Rows belonging to other writers can be skipped: a later modification gets
  // a new sequence and can never appear behind the committed cursor.
  if (consumed === rows.length && rows.length < SYNC_BATCH) cursor = config.sequence;
  return { entries, after: cursor.toString() };
}
