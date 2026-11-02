export const SESSION_RELOGIN_OFFLINE_GRACE_MS = 120_000;

export type ReloginSessionHeartbeat = {
  createdAt: Date;
  lastDesktopSeenAt: Date | null;
  lastMiniProgramSeenAt: Date | null;
};

export function sessionFullyOfflineForRelogin(
  session: ReloginSessionHeartbeat,
  now: Date,
  requireSecondCamera: boolean
) {
  const cutoff = now.getTime() - SESSION_RELOGIN_OFFLINE_GRACE_MS;
  const desktopLastSeen = (session.lastDesktopSeenAt || session.createdAt).getTime();
  const miniProgramLastSeen = (session.lastMiniProgramSeenAt || session.createdAt).getTime();
  return desktopLastSeen <= cutoff && (!requireSecondCamera || miniProgramLastSeen <= cutoff);
}

export function allSessionsFullyOfflineForRelogin(
  sessions: ReloginSessionHeartbeat[],
  now: Date,
  requireSecondCamera: boolean
) {
  return sessions.length > 0 && sessions.every((session) => sessionFullyOfflineForRelogin(session, now, requireSecondCamera));
}
