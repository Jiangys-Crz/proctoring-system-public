import type { ClientSession, Prisma } from '@prisma/client';

export const ACTIVE_CLIENT_SESSION_STATUSES = ['WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'] as const;

/** Only a successful, authenticated replacement login revokes old sessions.
 * Caller holds the candidate and session locks in the same transaction. */
export async function revokeSupersededSession(
  tx: Prisma.TransactionClient,
  session: ClientSession,
  now = new Date(),
) {
  if (session.status === 'FINISHED' || session.revokedAt) return false;
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
    data: { status: 'REJECTED', rejectReason: '同一账号已重新登录，旧会话已注销，原考试计时保持不变' },
  });
  return true;
}
