import { createHash } from 'node:crypto';
import type { ContestSummarySession } from './client-contest';
import { canCandidateSubmit, canViewTeamSubmissions } from './contest-format';
import { canReadContestAttachments } from './contest-attachment-policy';
import { candidateStartDeadline, effectiveEnd, flexibleExam, isScoreboardFrozen } from './contest-rules';
import { isLocalContest } from './local-contest';

/** Shared by the full contest response and its inexpensive state poll. Never
 * include heartbeat timestamps: those change even when the contest is unchanged. */
export function serializeContestState(session: ContestSummarySession, now = new Date()) {
  const { exam, candidate } = session;
  const startedAt = candidate.startedAt || session.startedAt;
  const endAt = effectiveEnd(exam, startedAt);
  const latestStartAt = candidateStartDeadline(exam, candidate.lateStartAllowedAt);
  const allowTeamSubmissionView = canViewTeamSubmissions(exam);
  const state = {
    id: session.id,
    status: session.status,
    startedAt,
    lockdown: session.lockdown,
    lockdownReason: session.lockdownReason,
    latestStartAt,
    flexible: flexibleExam(exam),
    effectiveEndAt: endAt.toISOString(),
    canSubmit: canCandidateSubmit(exam, candidate),
    canViewSubmissions: true,
    allowTeamSubmissionView,
  };
  const revision = createHash('sha256').update(JSON.stringify([
    'contest-state-v1', exam.id, exam.updatedAt, candidate.id, candidate.updatedAt,
    exam.problems.map(problem => [problem.id, problem.order, problem.updatedAt]),
    startedAt, allowTeamSubmissionView,
    // Local statements/files and judge visibility also change at clock
    // boundaries without any database write. Include phases, never the clock.
    canReadContestAttachments({ startedAt, candidate, exam }, now),
    now >= exam.startAt, now >= latestStartAt, now >= endAt, now >= exam.endAt,
    isScoreboardFrozen(exam, now),
  ])).digest('base64url');
  return {
    session: state,
    revision,
    // Legacy contests can end earlier in Hydro than the local exam deadline.
    // Only the full route knows that remote boundary. Tell the caller to use
    // that response before replacing its session, without fetching Hydro here.
    ...(!isLocalContest(exam) ? { requiresFullRefresh: true as const } : {}),
  };
}
