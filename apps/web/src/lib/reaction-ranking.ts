import type { Prisma, PrismaClient } from '@prisma/client';
import { ccsContestTimeMs, eventHash, finalVerdict, type CcsEvent } from './reaction-domain';

const baselineKey = { type: 'reaction-ranking', remoteId: 'baseline-v1' };
export const rankingEventTypes = ['contests', 'teams', 'problems', 'submissions', 'judgements'] as const;
type JsonObject = Record<string, unknown>;
export type RankingEvent = { type: string; remoteId: string; payload: unknown; observedAt: Date };
export type ReactionRankContext = {
  version: 1;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  beforeRank: number | null;
  afterRank: number | null;
  source: 'CCS_OBSERVED_ORDER' | 'HISTORICAL_CCS_RECONSTRUCTION';
  observedAt: string;
  provenance: JsonObject;
  reason?: string;
};
export type RankingScore = { teamId: string; rank: number; solved: number; penaltyMinutes: number };
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const live = (row: RankingEvent) => object(row.payload).__reactionDeleted !== true;
const active = (rows: RankingEvent[], type: string) => rows.filter(row => row.type === type && live(row));
const date = (value: unknown) => typeof value === 'string' ? new Date(value).getTime() : NaN;

/** Validated presentation boundary: unavailable or mismatched context never becomes a numeric rank. */
export function parseReactionRankContext(value: unknown, expected?: { contestId: string; teamId: string; submissionId: string; verdict?: string | null }): ReactionRankContext | null {
  const context = object(value);
  if (context.version !== 1 || !['AVAILABLE', 'UNAVAILABLE'].includes(String(context.status)) ||
      !['CCS_OBSERVED_ORDER', 'HISTORICAL_CCS_RECONSTRUCTION'].includes(String(context.source)) || !Number.isFinite(date(context.observedAt))) return null;
  const provenance = object(context.provenance);
  if (expected && (provenance.contestId !== expected.contestId || provenance.teamId !== expected.teamId || provenance.submissionId !== expected.submissionId ||
      (expected.verdict && provenance.verdict !== expected.verdict))) return null;
  if (context.status === 'AVAILABLE' && (![context.beforeRank, context.afterRank].every(rank => Number.isSafeInteger(rank) && Number(rank) > 0))) return null;
  return context as ReactionRankContext;
}

/** NovaJudge's unfiltered, unfrozen TEAM standings. This is not a fetched historical scoreboard.
 * Audited against NovaJudge rank/page.tsx: minute-floor AC time + 20 per earlier
 * non-CE/non-SE attempt, solved descending, penalty ascending, competition ties.
 * Pending attempts preceding an AC count in the current NovaJudge implementation.
 */
export function computeNovaJudgeStandings(rows: RankingEvent[], contestId: string): RankingScore[] {
  const contestRows = active(rows, 'contests');
  if (contestRows.length !== 1 || text(object(contestRows[0].payload).id) !== contestId) throw new Error('CONTEST_BASELINE_MISSING_OR_MISMATCHED');
  const contest = object(contestRows[0].payload);
  const start = date(contest.start_time), end = date(contest.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || Number(contest.penalty_time) !== 20) throw new Error('UNSUPPORTED_CONTEST_RULES');
  const teams = active(rows, 'teams').map(row => object(row.payload));
  if (!teams.length || new Set(teams.map(team => text(team.id))).size !== teams.length || teams.some(team => !text(team.id))) throw new Error('TEAM_BASELINE_MISSING');
  // NovaJudge mixes '*' display and numeric ranks in its combined table. Its
  // stable order is not included in CCS, so do not invent numeric star ranks.
  if (teams.some(team => Array.isArray(team.group_ids) && team.group_ids.includes('1'))) throw new Error('STAR_TEAM_RANK_ORDER_UNAVAILABLE');
  const problems = new Set(active(rows, 'problems').map(row => text(object(row.payload).id)));
  if (!problems.size) throw new Error('PROBLEM_BASELINE_MISSING');
  const teamIds = new Set(teams.map(team => text(team.id)));
  const submissions = active(rows, 'submissions').map(row => object(row.payload));
  const submissionIds = new Set(submissions.map(submission => text(submission.id)));
  const deletedSubmissionIds = new Set(rows.filter(row => row.type === 'submissions' && !live(row)).map(row => row.remoteId));
  const judgements = new Map<string, { verdict: string | null; at: number; id: string }>();
  for (const row of active(rows, 'judgements')) {
    const data = object(row.payload), submissionId = text(data.submission_id), verdict = finalVerdict(data);
    if (!submissionId) throw new Error('JUDGEMENT_SUBMISSION_MISSING');
    if (!submissionIds.has(submissionId)) {
      if (deletedSubmissionIds.has(submissionId)) continue;
      throw new Error('SNAPSHOT_HAS_ORPHAN_JUDGEMENT');
    }
    if (data.judgement_type_id && !verdict) throw new Error('UNSUPPORTED_JUDGEMENT');
    const previous = judgements.get(submissionId);
    if (!previous || +row.observedAt > previous.at || (+row.observedAt === previous.at && row.remoteId > previous.id)) {
      judgements.set(submissionId, { verdict, at: +row.observedAt, id: row.remoteId });
    }
  }
  const perTeam = new Map<string, Map<string, { id: string; time: number; verdict: string | null }[]>>();
  for (const submission of submissions) {
    const id = text(submission.id), teamId = text(submission.team_id), problemId = text(submission.problem_id);
    // CCS also exports global/virtual submissions. Only exact TEAM usernames in
    // the authoritative roster belong to the default TEAM standings.
    if (!teamIds.has(teamId)) {
      if (teamId) throw new Error('TEAM_ROSTER_OUT_OF_DATE');
      continue;
    }
    if (!problems.has(problemId)) throw new Error('PROBLEM_SET_OUT_OF_DATE');
    const time = date(submission.time), relative = ccsContestTimeMs(submission.contest_time);
    if (!id || !Number.isFinite(time) || relative === null || Math.abs(time - start - relative) > 2) throw new Error('SUBMISSION_CLOCK_INCONSISTENT');
    if (time < start) throw new Error('PRESTART_SUBMISSION_UNSUPPORTED');
    if (time > end) continue; // post-contest upsolving is not ranked
    const verdict = judgements.get(id)?.verdict ?? null;
    if (verdict === 'CE' || verdict === 'SE' || verdict === 'JE') continue;
    const byProblem = perTeam.get(teamId) || new Map();
    const entries = byProblem.get(problemId) || [];
    entries.push({ id, time, verdict }); byProblem.set(problemId, entries); perTeam.set(teamId, byProblem);
  }
  const scores: RankingScore[] = teams.map(team => {
    const teamId = text(team.id); let solved = 0, penaltyMinutes = 0;
    for (const submissions of perTeam.get(teamId)?.values() || []) {
      submissions.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
      // CCS omits NovaJudge's stable DB order for exact timestamp ties. An AC
      // mixed with another attempt at that timestamp can alter penalty.
      for (let i = 1; i < submissions.length; i++) if (submissions[i].time === submissions[i - 1].time && (submissions[i].verdict === 'AC' || submissions[i - 1].verdict === 'AC')) throw new Error('SIMULTANEOUS_ATTEMPT_ORDER_UNAVAILABLE');
      let attempts = 0;
      for (const submission of submissions) {
        if (submission.verdict === 'AC') { solved++; penaltyMinutes += Math.floor((submission.time - start) / 60000) + attempts * 20; break; }
        attempts++;
      }
    }
    return { teamId, rank: 0, solved, penaltyMinutes };
  });
  scores.sort((a, b) => b.solved - a.solved || a.penaltyMinutes - b.penaltyMinutes || a.teamId.localeCompare(b.teamId));
  for (let i = 0; i < scores.length; i++) scores[i].rank = i > 0 && scores[i].solved === scores[i - 1].solved && scores[i].penaltyMinutes === scores[i - 1].penaltyMinutes ? scores[i - 1].rank : i + 1;
  return scores;
}

const stateHash = (rows: RankingEvent[]) => eventHash([...rows].sort((a, b) => a.type.localeCompare(b.type) || a.remoteId.localeCompare(b.remoteId)).map(row => ({ type: row.type, remoteId: row.remoteId, data: row.payload })));

export function buildReactionRankContext(input: {
  before: RankingEvent[]; after: RankingEvent[]; contestId: string; teamId: string; submissionId: string;
  judgementId: string; verdict: string; observedAt: Date; baseline: JsonObject;
  source?: ReactionRankContext['source']; provenance?: JsonObject;
}): ReactionRankContext {
  const provenance: JsonObject = {
    contestId: input.contestId, teamId: input.teamId, submissionId: input.submissionId,
    judgementId: input.judgementId, verdict: input.verdict, rules: 'NOVAJUDGE_ICPC_V1', visibility: 'UNFROZEN_ADMIN',
    ordering: 'LOCAL_CCS_EVENT_OBSERVATION_ORDER', baselineObservedAt: input.baseline.observedAt ?? null,
    rosterObservedAt: input.baseline.rosterObservedAt ?? input.baseline.observedAt ?? null,
    beforeStateHash: stateHash(input.before), afterStateHash: stateHash(input.after),
    caveat: 'CCS polls every two seconds; this is the rank before/after applying the observed event, not an assertion of the original database transaction order or a historical scoreboard HTTP snapshot.',
    ...input.provenance,
  };
  const context: ReactionRankContext = { version: 1, status: 'UNAVAILABLE', beforeRank: null, afterRank: null, source: input.source || 'CCS_OBSERVED_ORDER', observedAt: input.observedAt.toISOString(), provenance };
  try {
    if (input.baseline.ready !== true) throw new Error('COMPLETE_CCS_BASELINE_NOT_OBSERVED');
    const before = computeNovaJudgeStandings(input.before, input.contestId), after = computeNovaJudgeStandings(input.after, input.contestId);
    const a = before.find(row => row.teamId === input.teamId), b = after.find(row => row.teamId === input.teamId);
    if (!a || !b) throw new Error('TEAM_USERNAME_NOT_IN_ROSTER');
    Object.assign(provenance, { teamCount: after.length, submissionCount: active(input.after, 'submissions').length, beforeScore: a, afterScore: b });
    return { ...context, status: 'AVAILABLE', beforeRank: a.rank, afterRank: b.rank };
  } catch (error) {
    return { ...context, reason: error instanceof Error ? error.message : 'RANKING_INPUT_UNAVAILABLE' };
  }
}

/** Called before reconnect snapshot processing, so catch-up events cannot impersonate live ranks. */
export async function beginReactionRankingSnapshot(db: PrismaClient, examId: string) {
  const payload = { ready: false, observedAt: new Date().toISOString() };
  await db.reactionEvent.upsert({ where: { examId_type_remoteId: { examId, ...baselineKey } }, create: { examId, ...baselineKey, payload, payloadHash: eventHash(payload) }, update: { payload, payloadHash: eventHash(payload) } });
}

/** Static snapshot is authoritative for current membership; remove vanished/deleted checkpoint entities. */
export async function completeReactionRankingSnapshot(db: PrismaClient, examId: string, events: CcsEvent[], observedAt = new Date()) {
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
    for (const type of rankingEventTypes) {
      const ids = events.filter(event => event.type === type && event.op !== 'delete').map(event => text(event.data?.id || event.id)).filter(Boolean);
      await tx.reactionEvent.deleteMany({ where: { examId, type, remoteId: { notIn: ids } } });
    }
    const payload = { ready: true, observedAt: observedAt.toISOString(), rosterObservedAt: observedAt.toISOString(), snapshotHash: eventHash(events.filter(event => (rankingEventTypes as readonly string[]).includes(event.type))), source: 'AUTHENTICATED_CCS_COMPLETE_STATIC_FEED' };
    await tx.reactionEvent.update({ where: { examId_type_remoteId: { examId, ...baselineKey } }, data: { payload, payloadHash: eventHash(payload), observedAt } });
  }, { timeout: 15000 });
}

/** Invoke inside the event's transaction after checkpoint upsert, supplying its previous payload. */
export async function observedReactionRankContext(tx: Prisma.TransactionClient, input: {
  examId: string; contestId: string; teamId: string; submissionId: string; judgementId: string;
  verdict: string; observedAt: Date; previous: RankingEvent | null;
}) {
  const [rows, baseline] = await Promise.all([
    tx.reactionEvent.findMany({ where: { examId: input.examId, type: { in: [...rankingEventTypes] } }, select: { type: true, remoteId: true, payload: true, observedAt: true } }),
    tx.reactionEvent.findUnique({ where: { examId_type_remoteId: { examId: input.examId, ...baselineKey } } }),
  ]);
  const before = rows.filter(row => row.type !== 'judgements' || row.remoteId !== input.judgementId);
  if (input.previous) before.push(input.previous as typeof rows[number]);
  return buildReactionRankContext({ ...input, before, after: rows, baseline: object(baseline?.payload) });
}

export type NovaJudgeHistoricalRankProof = {
  observedAt: string; source: 'LOCAL_NOVAJUDGE_READ_ONLY_DATABASE';
  contest: { id: number; startTime: string; endTime: string; createdAt: string };
  teams: { id: string; username: string; category: string | null; createdAt: string }[];
  submissions: { id: string; userId: string | null; problemId: number; submittedAt: string; verdict: string }[];
  problems: { problemId: number; displayId: string }[];
};
export type HistoricalReactionObservation = {
  submissionId: string; teamId: string; problemId: string; sourceSubmittedAt: Date;
  judgementObservedAt: Date | null; originalVerdict: string | null; verdictHistory: unknown;
};

/** Explicit administrative backfill, never silently run from generation. Current
 * verdicts are only a cross-check; each historical result comes from the saved
 * CCS observation history. Roster creation dates corroborate membership, and
 * the lack of a deleted-account audit is disclosed in the persisted provenance.
 */
export function reconstructHistoricalReactionRankContext(proof: NovaJudgeHistoricalRankProof, histories: HistoricalReactionObservation[], target: HistoricalReactionObservation): ReactionRankContext {
  const observedAt = target.judgementObservedAt || new Date(proof.observedAt);
  const contestId = String(proof.contest.id);
  const provenance: JsonObject = {
    reconstructedAt: proof.observedAt, proofHash: eventHash(proof),
    historyHash: eventHash(histories.map(history => ({ submissionId: history.submissionId, teamId: history.teamId, problemId: history.problemId, originalVerdict: history.originalVerdict, verdictHistory: history.verdictHistory, sourceSubmittedAt: history.sourceSubmittedAt.toISOString(), judgementObservedAt: history.judgementObservedAt?.toISOString() || null }))),
    snapshotKind: 'RECONSTRUCTION_NOT_HISTORICAL_SCOREBOARD_SNAPSHOT',
    rosterReconstruction: 'SURVIVING_NOVAJUDGE_TEAM_ROWS_CREATED_BEFORE_EVENT',
    rosterCreationEvidence: proof.teams.map(team => ({ teamId: team.username, createdAt: team.createdAt })),
    rosterLimitation: 'Current authenticated local database roster and account creation times corroborate membership; NovaJudge has no deleted-account audit to independently exclude an earlier deleted team.',
    currentVerdictsUsedAsHistory: false,
  };
  const baseline = { ready: true, observedAt: proof.observedAt, rosterObservedAt: proof.observedAt };
  const before: RankingEvent[] = [], after: RankingEvent[] = [];
  let judgementId = target.submissionId;
  try {
    if (proof.source !== 'LOCAL_NOVAJUDGE_READ_ONLY_DATABASE' || !Number.isFinite(date(proof.observedAt)) || !target.judgementObservedAt || !target.originalVerdict) throw new Error('HISTORICAL_SOURCE_UNAVAILABLE');
    if (date(proof.observedAt) < +observedAt || date(proof.contest.createdAt) > +observedAt) throw new Error('HISTORICAL_PROOF_TIME_MISMATCH');
    const row = (type: string, id: string, payload: JsonObject, at = observedAt): RankingEvent => ({ type, remoteId: id, payload, observedAt: at });
    const stable = [row('contests', contestId, { id: contestId, start_time: proof.contest.startTime, end_time: proof.contest.endTime, penalty_time: 20 }),
      ...proof.teams.filter(team => date(team.createdAt) <= +observedAt).map(team => row('teams', team.username, { id: team.username, group_ids: team.category ? [team.category] : [] })),
      ...proof.problems.map(problem => row('problems', String(problem.problemId), { id: String(problem.problemId), label: problem.displayId }))];
    before.push(...stable); after.push(...stable);
    const currentVerdict: Record<string, string | null> = { ACCEPTED: 'AC', WRONG_ANSWER: 'WA', TIME_LIMIT_EXCEEDED: 'TLE', MEMORY_LIMIT_EXCEEDED: 'MLE', RUNTIME_ERROR: 'RTE', COMPILE_ERROR: 'CE', PRESENTATION_ERROR: 'PE', SYSTEM_ERROR: 'SE', PENDING: null, JUDGING: null };
    for (const submission of proof.submissions) {
      if (date(submission.submittedAt) > +observedAt) continue;
      const team = proof.teams.find(value => value.id === submission.userId);
      if (!team) continue; // non-TEAM global/virtual submissions
      if (date(team.createdAt) > date(submission.submittedAt)) throw new Error('HISTORICAL_TEAM_MEMBERSHIP_MISMATCH');
      const history = histories.find(value => value.submissionId === submission.id);
      if (!history || history.teamId !== team.username || history.problemId !== String(submission.problemId) || Math.abs(+history.sourceSubmittedAt - date(submission.submittedAt)) > 2) throw new Error('HISTORICAL_SUBMISSION_OBSERVATION_MISSING');
      const entries = (Array.isArray(history.verdictHistory) ? history.verdictHistory : []).map(object).filter(entry => Number.isFinite(date(entry.observedAt))).sort((a, b) => date(a.observedAt) - date(b.observedAt));
      const latest = entries.at(-1);
      if (!latest || !(submission.verdict in currentVerdict) || (latest.verdict || null) !== currentVerdict[submission.verdict]) throw new Error('CURRENT_VERDICT_NOT_CORROBORATED_BY_EVENT_HISTORY');
      const elapsed = date(submission.submittedAt) - date(proof.contest.startTime);
      if (elapsed < 0) throw new Error('PRESTART_SUBMISSION_UNSUPPORTED');
      const contestTime = `${Math.floor(elapsed / 3600000)}:${String(Math.floor(elapsed / 60000) % 60).padStart(2, '0')}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}.${String(elapsed % 1000).padStart(3, '0')}`;
      const source = row('submissions', submission.id, { id: submission.id, team_id: team.username, problem_id: String(submission.problemId), time: submission.submittedAt, contest_time: contestTime });
      before.push(source); after.push(source);
      if (submission.id !== target.submissionId && entries.some(entry => date(entry.observedAt) === +observedAt)) throw new Error('HISTORICAL_SIMULTANEOUS_EVENT_ORDER_UNAVAILABLE');
      for (const [destination, inclusive] of [[before, false], [after, true]] as const) {
        const eligible = entries.filter(entry => inclusive ? date(entry.observedAt) <= +observedAt : date(entry.observedAt) < +observedAt);
        const last = eligible.at(-1);
        if (last) destination.push(row('judgements', text(last.judgementId), { id: text(last.judgementId), submission_id: submission.id, judgement_type_id: last.verdict || null, ...(last.op === 'delete' ? { __reactionDeleted: true } : {}) }, new Date(text(last.observedAt))));
      }
      if (submission.id === target.submissionId) {
        const original = entries.find(entry => date(entry.observedAt) === +observedAt && entry.verdict === target.originalVerdict && entry.op !== 'delete');
        if (!original) throw new Error('ORIGINAL_JUDGEMENT_OBSERVATION_MISSING');
        judgementId = text(original.judgementId);
      }
    }
    if (!after.some(value => value.type === 'submissions' && value.remoteId === target.submissionId)) throw new Error('TARGET_SUBMISSION_NOT_IN_PROOF');
    return buildReactionRankContext({ before, after, contestId, teamId: target.teamId, submissionId: target.submissionId, judgementId, verdict: target.originalVerdict, observedAt, baseline, source: 'HISTORICAL_CCS_RECONSTRUCTION', provenance });
  } catch (error) {
    return { version: 1, status: 'UNAVAILABLE', beforeRank: null, afterRank: null, source: 'HISTORICAL_CCS_RECONSTRUCTION', observedAt: observedAt.toISOString(), provenance: { ...provenance, contestId, teamId: target.teamId, submissionId: target.submissionId, judgementId, verdict: target.originalVerdict }, reason: error instanceof Error ? error.message : 'HISTORICAL_INPUT_UNAVAILABLE' };
  }
}
