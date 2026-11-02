import type { ClientSession, Prisma } from '@prisma/client';
import { sessionFullyOfflineForRelogin } from './client-session-policy';

export const ACTIVE_CLIENT_SESSION_STATUSES = ['WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'] as const;

/** Called after taking the ClientSession row lock, before accepting a new heartbeat/token. */
export async function revokeFullyOfflineSession(
  tx: Prisma.TransactionClient,
  session: ClientSession,
  requireSecondCamera: boolean,
  now = new Date(),
) {
  if (session.status === 'FINISHED' || !sessionFullyOfflineForRelogin(session, now, requireSecondCamera)) return false;
  await tx.clientSession.update({ where: { id: session.id }, data: {
    status: 'FINISHED', revokedAt: now, endedAt: now,
    desktopTokenHash: null, miniProgramTokenHash: null,
    lockdown: false, lockdownReason: null,
  } });
  await tx.pairingSession.updateMany({
    where: { OR: [
      { recoverySessionId: session.id },
      ...(session.loginRequestId ? [{ loginRequestId: session.loginRequestId }] : []),
    ] },
    data: { pollTokenHash: null, recoveryTokenHash: null, expiresAt: now },
  });
  if (session.loginRequestId) await tx.loginRequest.updateMany({
    where: { id: session.loginRequestId, status: 'REQUESTING' },
    data: { status: 'REJECTED', rejectReason: '客户端所需端均离线满 2 分钟，会话已自动注销，请重新登录' },
  });
  const otherActiveSessions = await tx.clientSession.count({
    where: { candidateId: session.candidateId, id: { not: session.id }, status: { in: [...ACTIVE_CLIENT_SESSION_STATUSES] } },
  });
  // Preserve the personal examination clock, and never change a newer login.
  if (!otherActiveSessions) await tx.candidate.update({
    where: { id: session.candidateId }, data: { status: 'OFFLINE', abnormal: true },
  });
  return true;
}
