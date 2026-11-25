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

const CHEATING_LOCK_SEPARATOR = '\n\n监考处理：';

export function peripheralLockReason(reason: string | null) {
  return reason?.startsWith('检测到 USB 外设') || reason?.startsWith('检测到外设接入或移除，原始指纹 ')
    ? reason.split(CHEATING_LOCK_SEPARATOR, 1)[0] : null;
}

export function cheatingLockReason(reason: string | null) {
  // Older/manual records already use this wording and can be inherited by a
  // replacement session. Only release that lock on cancellation; a hardware
  // lock needs the proctor's separate decision to accept the USB baseline.
  const manual = peripheralLockReason(reason) ? reason?.split(CHEATING_LOCK_SEPARATOR).slice(1).join(CHEATING_LOCK_SEPARATOR) : reason;
  return manual?.endsWith('标记为作弊') ? manual : null;
}

export function formatLockReason(peripheral: string, cheating: string | null) {
  // The hardware observation contains a device instance ID. Reserve the
  // separator for server-generated text even if that observation has newlines.
  const detail = peripheral.replace(/[\r\n]/g, ' ');
  return cheating ? `${detail}${CHEATING_LOCK_SEPARATOR}${cheating}` : detail;
}
