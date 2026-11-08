import type { Prisma } from '@prisma/client';
import { FederationError } from './exam-federation-protocol';

/** Candidate cascades would also erase codes, discussions and the other node's live sessions. */
export async function assertCandidateCanDelete(tx: Prisma.TransactionClient, examId: string, ids: string[]) {
  const used = await tx.candidate.findFirst({ where: { examId, id: { in: ids }, OR: [
    { submissions: { some: {} } }, { questions: { some: {} } }, { announcements: { some: {} } },
    { announcementReceipts: { some: {} } }, { sessions: { some: {} } }, { loginRequests: { some: {} } },
    { mediaSegments: { some: {} } }, { printJobs: { some: {} } }, { cheatingRecords: { some: {} } }, { alerts: { some: {} } },
  ] }, select: { id: true } });
  const report = await tx.codeCheckSource.findFirst({ where: { candidateId: { in: ids }, job: { examId } }, select: { id: true } });
  if (used || report) throw new FederationError('考生已有考试记录，不能删除；请保留账号及历史资料', 409);
}
