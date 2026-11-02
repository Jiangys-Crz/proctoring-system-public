import type { Alert, CandidateStatus, Prisma } from '@prisma/client';
import { prisma } from './db';

type AlertIdentity = Pick<Alert, 'id' | 'candidateId'>;

// Shared across route bundles, bounded even when old sessions never return.
const reconciliationState = globalThis as typeof globalThis & { candidateStatusRechecks?: Map<string, number> };
const rechecks = reconciliationState.candidateStatusRechecks ??= new Map<string, number>();
const RECHECK_INTERVAL_MS = 30_000;
const RECHECK_LIMIT = 10_000;
export function claimCandidateStatusRecheck(sessionId: string, now: Date): boolean {
  const time = now.getTime();
  const previous = rechecks.get(sessionId);
  if (previous !== undefined && time >= previous && time - previous < RECHECK_INTERVAL_MS) return false;
  rechecks.delete(sessionId);
  if (rechecks.size >= RECHECK_LIMIT) rechecks.delete(rechecks.keys().next().value!);
  rechecks.set(sessionId, time);
  return true;
}

/** Call while holding the current session lock. The candidate lock serializes
 * status changes with other sessions and alert writers. Recompute only on ack,
 * recovery/unlock, or a bounded repair of historical sticky abnormal flags. */
export async function refreshCandidateAlertStatus(tx: Prisma.TransactionClient, candidateId: string, now = new Date(), candidateLocked = false) {
  if (!candidateLocked) await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${candidateId} FOR UPDATE`;
  const candidate = await tx.candidate.findUniqueOrThrow({ where: { id: candidateId }, select: {
    status: true, abnormal: true, startedAt: true, examId: true,
    exam: { select: { requireMiniProgram: true } },
    rooms: { select: { room: { select: { examId: true, requireSecondCamera: true } } } }
  } });
  const [remainingAlerts, cheatingRecords, sessions] = await Promise.all([
    tx.alert.count({ where: { candidateId, acknowledgedAt: null } }),
    tx.cheatingRecord.count({ where: { candidateId, canceledAt: null } }),
    tx.clientSession.findMany({ where: { candidateId }, orderBy: { createdAt: 'desc' }, select: {
      status: true, lockdown: true, revokedAt: true, approvedAt: true, startedAt: true,
      lastDesktopSeenAt: true, lastMiniProgramSeenAt: true, desktopOfflineAt: true, miniProgramOfflineAt: true
    } })
  ]);
  const active = sessions.filter(session => session.status !== 'FINISHED' && !session.revokedAt);
  const requireSecondCamera = candidate.rooms.find(({ room }) => room.examId === candidate.examId)?.room.requireSecondCamera
    ?? candidate.exam.requireMiniProgram;
  const cutoff = now.getTime() - 20_000;
  const stale = (seen: Date | null, approved: Date | null) => Boolean((seen || approved) && +(seen || approved)! < cutoff);
  const desktopOffline = active.some(session => session.status === 'OFFLINE' || session.desktopOfflineAt
    || stale(session.lastDesktopSeenAt, session.approvedAt))
    || !active.length && candidate.status === 'OFFLINE';
  const mobileOffline = requireSecondCamera && active.some(session => session.miniProgramOfflineAt
    || stale(session.lastMiniProgramSeenAt, session.approvedAt));
  const locked = active.some(session => session.lockdown || session.status === 'LOCKED');
  const abnormal = Boolean(remainingAlerts || cheatingRecords || desktopOffline || mobileOffline || locked);
  let status: CandidateStatus = candidate.status;
  if (candidate.status !== 'FINISHED') {
    if (desktopOffline) status = 'OFFLINE';
    else if (abnormal) {
      if (active.length || candidate.status === 'ONLINE_NORMAL') status = 'ONLINE_ABNORMAL';
    } else if (active.length) {
      const current = active[0];
      status = current.status === 'WAITING_REVIEW' ? 'REQUESTING'
        : candidate.startedAt || current.startedAt || current.status === 'IN_EXAM' ? 'ONLINE_NORMAL' : 'APPROVED';
    } else if (sessions[0]?.status === 'FINISHED') status = 'FINISHED';
  }
  if (abnormal !== candidate.abnormal || status !== candidate.status) {
    await tx.candidate.update({ where: { id: candidateId }, data: { abnormal, status } });
  }
  return { abnormal, status };
}

/** Lock all sessions before the candidate so acknowledging an old session
 * cannot clear a new session's concurrently-created alert. */
export async function acknowledgeAlertInTransaction(tx: Prisma.TransactionClient, alert: AlertIdentity, now = new Date()) {
  if (!alert.candidateId) return tx.alert.update({ where: { id: alert.id }, data: { acknowledgedAt: now } });
  const candidateId = alert.candidateId;
  await tx.$queryRaw`SELECT id FROM ClientSession WHERE candidateId = ${candidateId} ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${candidateId} FOR UPDATE`;
  const item = await tx.alert.update({ where: { id: alert.id }, data: { acknowledgedAt: now } });
  // This never unlocks USB/cheating protection or resumes a finished session.
  await refreshCandidateAlertStatus(tx, candidateId, now, true);
  return item;
}

export async function withAlertStatusWrite<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  // Login and existing administrative writers may acquire candidate/session
  // locks in a different order. Retry only MySQL's rolled-back deadlock victim.
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000
      });
    } catch (error) {
      if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2034') throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}


export function acknowledgeAlert(alert: AlertIdentity) {
  return withAlertStatusWrite(tx => acknowledgeAlertInTransaction(tx, alert));
}
