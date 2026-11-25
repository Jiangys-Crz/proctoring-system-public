import type { Prisma } from '@prisma/client';
import { AuthError } from './auth';
import { prisma } from './db';
import { deleteLiveWebRtcResource } from './live-webrtc';
import { canPublishChannel } from './media-publish-access';
import { publicContestLiveAccess } from './contest-live-access';
import { isContestLiveSupported } from './contest-live-contract';
import { readContestLiveRoster } from './contest-live-data';
import { verifyContestLiveMediaToken } from './contest-live-media-token';
import { contestLiveTeamSlotCount, readContestLiveConfig, type ContestLiveSettings } from './contest-live-settings';

export function contestLiveActiveTeams(settings: ContestLiveSettings) {
  return new Set([
    ...settings.selectedTeamIds.slice(0, contestLiveTeamSlotCount[settings.teamMode]),
    ...(settings.spotlight.visible ? settings.spotlight.teamIds : []),
  ]);
}

export function contestLiveTeamChannelAllowed(settings: ContestLiveSettings, teamId: string, channel: string) {
  if (channel !== 'DESKTOP_SCREEN' && channel !== 'DESKTOP_CAMERA') return false;
  const media = channel === 'DESKTOP_SCREEN' ? 'screen' : 'camera';
  const legacy = settings.mediaMode === 'auto' || settings.mediaMode === 'both' || settings.mediaMode === media;
  if (settings.spotlight.visible && settings.spotlight.teamIds.includes(teamId) && legacy) return true;
  if (!settings.teamSlots) return legacy && contestLiveActiveTeams(settings).has(teamId);
  return settings.teamSlots.some(slot => slot?.teamId === teamId
    && (slot.primary === 'auto' || slot.primary === media || slot.secondary === media));
}

export function canUseContestLiveMedia({ settings, obsKeyHash }: ReturnType<typeof readContestLiveConfig>, access: string, teamId: string, channel: string) {
  const enabled = access === publicContestLiveAccess ? settings.publicEnabled && settings.publicMediaEnabled : obsKeyHash === access;
  return !!settings.freeze.at && enabled && contestLiveTeamChannelAllowed(settings, teamId, channel);
}

export const contestLiveSessionStatuses = ['APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'] as const;

export async function allowContestLiveMediaSession(examId: string, teamId: string, sessionId: string, channel: string,
  db: Pick<Prisma.TransactionClient, 'clientSession' | 'exam' | 'examRoom'> = prisma) {
  const session = await db.clientSession.findFirst({
    where: { id: sessionId, examId, revokedAt: null, desktopDeviceId: { not: null }, status: { in: [...contestLiveSessionStatuses] } },
    select: { examId: true, candidateId: true, startedAt: true, status: true, revokedAt: true },
  });
  if (!session) return false;
  const source = await readContestLiveRoster(examId, db);
  return source?.roster.byCandidate.get(session.candidateId) === teamId && await canPublishChannel(session, channel, db);
}

export async function allowContestLiveMediaGrant(examId: string, access: string, teamId: string, channel: string,
  db: Pick<Prisma.TransactionClient, 'contestLiveSettings'> = prisma) {
  const settings = await db.contestLiveSettings.findUnique({ where: { examId },
    select: { settings: true, obsKeyHash: true, exam: { select: { platform: true, contestRule: true, startAt: true, endAt: true } } } });
  return Boolean(settings && isContestLiveSupported(settings.exam.platform, settings.exam.contestRule)
    && canUseContestLiveMedia(readContestLiveConfig(settings, settings.exam), access, teamId, channel));
}

export async function authorizeContestLiveMediaToken(token: string, sessionId: string, channel: string) {
  const claims = verifyContestLiveMediaToken(token, sessionId, channel);
  if (!claims) return false;
  const allowed = () => allowContestLiveMediaGrant(claims.examId, claims.access, claims.teamId, channel);
  return await allowed() && await allowContestLiveMediaSession(claims.examId, claims.teamId, sessionId, channel) && await allowed();
}

export async function pruneContestLiveRosterConnections(examId: string) {
  const connections = await prisma.contestLiveConnection.findMany({
    where: { examId }, select: { id: true, sessionId: true, teamId: true, channel: true },
  });
  if (!connections.length) return;
  const [source, sessions] = await Promise.all([
    readContestLiveRoster(examId),
    prisma.clientSession.findMany({
      where: { examId, id: { in: [...new Set(connections.map(connection => connection.sessionId))] },
        revokedAt: null, status: { in: [...contestLiveSessionStatuses] } },
      select: { id: true, candidateId: true },
    }),
  ]);
  const teamBySession = new Map(sessions.map(session => [session.id, source?.roster.byCandidate.get(session.candidateId)]));
  await removeContestLiveConnections(connections.filter(connection => teamBySession.get(connection.sessionId) !== connection.teamId),
    '考生名单已更新，部分直播观看连接暂未断开，请重试');
}

export async function removeContestLiveConnections(stale: { id: string; sessionId: string; channel: string }[],
  failureMessage = '设置已更新，部分观看连接暂未断开，请重试') {
  let failed = false;
  for (let offset = 0; offset < stale.length; offset += 8) {
    const results = await Promise.allSettled(stale.slice(offset, offset + 8).map(async connection => {
      await deleteLiveWebRtcResource(connection.id, connection.sessionId, connection.channel);
      await prisma.contestLiveConnection.deleteMany({ where: { id: connection.id } });
    }));
    failed ||= results.some(result => result.status === 'rejected');
  }
  if (failed) throw new AuthError(failureMessage, 502);
}
