import { contestSubmissionWhere, type ContestSession } from './client-contest';
import { prisma } from './db';
import { serializeLocalSubmissions, submissionDetailSelect, submissionSummarySelect } from './local-contest';

type HistorySession = Pick<ContestSession, 'candidate'> & {
  exam: Parameters<typeof contestSubmissionWhere>[0]['exam'] & Parameters<typeof serializeLocalSubmissions>[0];
};

/** Fresh authentication precedes this read; no completed authorization/result cache. */
export async function readClientSubmissionHistory(session: HistorySession, summaryOnly = false, submissionId?: string) {
  const scope = await contestSubmissionWhere(session);
  const where = submissionId ? { ...scope, id: submissionId } : scope;
  const records = submissionId
    ? await prisma.contestSubmission.findFirst({ where, select: submissionDetailSelect }).then(row => row ? [row] : [])
    : await prisma.contestSubmission.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: summaryOnly ? submissionSummarySelect : submissionDetailSelect,
      });
  const detailsLoaded = Boolean(submissionId) || !summaryOnly;
  const rows = records.map(record => detailsLoaded
    ? { code: '', testCases: [], subtasks: {}, ...record }
    : { ...record, code: '', testCases: [], subtasks: {} });
  const ownById = new Map(rows.map(row => [row.id, row.candidateId === session.candidate.id]));
  // These identities are trusted only after the database query enforced the
  // current exam/team scope. No caller-supplied actorKey or teamName is used.
  const authorizedIds = new Set(rows.map(row => row.candidateId));
  return serializeLocalSubmissions(session.exam, rows, authorizedIds).map(row => ({
    ...row, canViewDetail: true, detailsLoaded, isOwn: ownById.get(row.id) === true,
  }));
}
