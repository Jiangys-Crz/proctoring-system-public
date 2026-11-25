import type { Exam, Prisma, ReactionConfig } from '@prisma/client';
import { prisma } from './db';
import { eventHash } from './reaction-domain';
import { acceptReactionEvent } from './reaction-events';
import { fetchHydroReactionPage, hydroReactionEvents, type HydroReactionRecord } from './reaction-hydro';
import { reactionSource } from './reaction-source';
import { getHydroSettings } from './settings';

type ConfiguredExam = Exam & { reactionConfig: ReactionConfig | null };
export type HydroReactionPollState = { cutover: number; hashes: Map<string, string>; known: Set<string> };
const localSelect = {
  id: true, problemId: true, candidateExamNumber: true, status: true, createdAt: true, judgeAt: true,
  candidate: { select: { examNumber: true } }, problem: { select: { label: true, order: true } },
} satisfies Prisma.ContestSubmissionSelect;

export async function createHydroReactionPollState(exam: ConfiguredExam): Promise<HydroReactionPollState> {
  const cutover = exam.reactionConfig?.initializedAt;
  if (!cutover) throw new Error('REACTION_HYDRO_NOT_INITIALIZED');
  const existing = await prisma.reaction.findMany({ where: { examId: exam.id, sourceSubmittedAt: { gte: cutover }, status: { not: 'DELETED' } }, select: { submissionId: true } });
  return { cutover: +cutover, hashes: new Map(), known: new Set(existing.map(row => row.submissionId)) };
}

function problemLabel(order: number) {
  let label = '';
  for (let n = order + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}

/** Read every page, including still-pending runs and rejudges. Snapshots contain
 * metadata only; unchanged rows do not acquire an exam lock or write events.
 * Only a complete successful scan may declare a submission deleted. */
export async function pollHydroReactions(exam: ConfiguredExam, signal: AbortSignal, state: HydroReactionPollState) {
  if (+exam.reactionConfig!.initializedAt! !== state.cutover) throw new Error('REACTION_SOURCE_CHANGED');
  const seen = new Set<string>();
  const problemHashes = new Map<string, string>();
  const accept = async (row: HydroReactionRecord) => {
    signal.throwIfAborted();
    // Mongo ObjectIds have one-second precision; the endpoint rounds down its
    // lower bound, while this exact cutover suppresses pre-enable submissions.
    if (Date.parse(row.createdAt) < state.cutover) return;
    seen.add(row.id);
    const hash = eventHash(row);
    if (state.hashes.get(row.id) === hash) return;
    for (const event of hydroReactionEvents(row)) {
      if (event.type === 'problems') {
        if (problemHashes.get(row.problemId) === row.problemLabel) continue;
        problemHashes.set(row.problemId, row.problemLabel);
      }
      await acceptReactionEvent(exam, event, new Date());
    }
    state.hashes.set(row.id, hash);
    state.known.add(row.id);
  };
  let after: string | null = null;
  if (reactionSource(exam) === 'HYDRO_CONTEST') {
    const connection = await getHydroSettings();
    do {
      signal.throwIfAborted();
      const page = await fetchHydroReactionPage(exam, connection, new Date(state.cutover), after, signal);
      for (const row of page.records) await accept(row);
      after = page.nextAfter;
    } while (after);
  } else {
    do {
      signal.throwIfAborted();
      const rows: Prisma.ContestSubmissionGetPayload<{ select: typeof localSelect }>[] = await prisma.contestSubmission.findMany({
        where: { examId: exam.id, createdAt: { gte: new Date(state.cutover) }, syncImported: false, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' }, take: 200,
        select: localSelect,
      });
      for (const row of rows) await accept({ id: row.id, username: row.candidateExamNumber || row.candidate.examNumber,
        problemId: row.problemId, problemLabel: row.problem.label || problemLabel(row.problem.order), status: row.status,
        createdAt: row.createdAt.toISOString(), judgeAt: row.judgeAt?.toISOString() || null });
      after = rows.length === 200 ? rows[rows.length - 1].id : null;
    } while (after);
  }
  for (const id of state.known) {
    if (seen.has(id)) continue;
    signal.throwIfAborted();
    await acceptReactionEvent(exam, { type: 'submissions', op: 'delete', data: { id } });
    state.known.delete(id);
    state.hashes.delete(id);
  }
}
