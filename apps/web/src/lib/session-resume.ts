import type { SessionStatus } from '@prisma/client';

/** Recover transport state without granting approval or clearing a lock.
 * A candidate can have an earlier exam clock but a newly pending login. */
export function resumedSessionStatus(session: {
  lockdown: boolean; approvedAt: Date | null; startedAt: Date | null;
}, candidateStartedAt?: Date | null): SessionStatus {
  if (session.lockdown) return 'LOCKED';
  if (!session.approvedAt) return 'WAITING_REVIEW';
  return candidateStartedAt || session.startedAt ? 'IN_EXAM' : 'APPROVED';
}
