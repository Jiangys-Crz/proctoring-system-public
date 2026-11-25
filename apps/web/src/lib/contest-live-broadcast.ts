import type { ContestLiveData } from './contest-live-contract';
import type { contestLiveViewer } from './contest-live-access';
import { digestContestLiveValue, normalizeContestLiveAccount } from './contest-live-access';
import { contestLiveOrganizationLogos } from './contest-live-branding';
import { prisma } from './db';
import { monitorLiveStatus } from './monitor-live-status';
import { contestLiveActiveTeams, contestLiveSessionStatuses, contestLiveTeamChannelAllowed } from './contest-live-media';
import { signContestLivePhotoTarget, signContestLiveTarget, type ContestLiveChannel } from './contest-live-media-token';
import type { ContestLiveResponse } from './contest-live-settings';
import { normalizeReactionOrganizationName } from './reaction-branding-contract';

export function contestLivePhotoAccountHash(account: string) {
  return digestContestLiveValue(normalizeContestLiveAccount(account));
}

export function contestLiveApiPath(examId: string) {
  return `/api/exams/${encodeURIComponent(examId)}/contest-live`;
}

export async function contestLiveBroadcast(data: ContestLiveData, viewer: Awaited<ReturnType<typeof contestLiveViewer>>): Promise<ContestLiveResponse> {
  const { settings, manage, mediaAllowed, key, access, obsKeyActive } = viewer;
  const examId = data.exam.id;
  const base = contestLiveApiPath(examId);
  const active = contestLiveActiveTeams(settings);
  const visible = mediaAllowed ? data.teams.filter(team => manage || active.has(team.id)) : [];
  const candidateIds = Array.from(new Set(visible.filter(team => manage ||
    contestLiveTeamChannelAllowed(settings, team.id, 'DESKTOP_SCREEN') || contestLiveTeamChannelAllowed(settings, team.id, 'DESKTOP_CAMERA'))
    .flatMap(team => team.candidateIds)));
  const photoHashes = Array.from(new Set(visible.flatMap(team => [team.account, ...team.accounts]).filter(Boolean).map(contestLivePhotoAccountHash)));
  const [sessions, photos, logos] = await Promise.all([
    candidateIds.length ? prisma.clientSession.findMany({
      where: {
        examId, candidateId: { in: candidateIds }, revokedAt: null, desktopDeviceId: { not: null },
        status: { in: [...contestLiveSessionStatuses] }, exam: { endAt: { gt: new Date() } },
      },
      orderBy: [{ lastDesktopSeenAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, candidateId: true, status: true },
    }) : [],
    photoHashes.length ? prisma.contestLivePhoto.findMany({
      where: { examId, accountHash: { in: photoHashes } },
      select: { id: true, accountHash: true, updatedAt: true },
    }) : [],
    contestLiveOrganizationLogos(data.teams.map(team => team.organization)),
  ]);
  const { bySession } = await monitorLiveStatus.readyChannels(sessions);
  type Session = typeof sessions[number];
  const byCandidate = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!bySession.has(session.id)) continue;
    const list = byCandidate.get(session.candidateId) || [];
    list.push(session);
    byCandidate.set(session.candidateId, list);
  }
  const photoByAccount = new Map(photos.map(photo => [photo.accountHash, photo]));
  return {
    settings: { ...settings, obsKeyActive },
    contest: {
      ...data,
      sourceError: manage ? data.sourceError : null,
      teams: data.teams.map(team => {
        const candidateSessions = team.candidateIds.flatMap(id => byCandidate.get(id) || []);
        const findChannel = (channel: ContestLiveChannel) => candidateSessions.find(session => bySession.get(session.id)?.includes(channel));
        const primary = settings.mediaMode === 'camera' ? 'DESKTOP_CAMERA' : 'DESKTOP_SCREEN';
        const source = findChannel(primary) || findChannel(primary === 'DESKTOP_CAMERA' ? 'DESKTOP_SCREEN' : 'DESKTOP_CAMERA');
        const stream = (channel: ContestLiveChannel) => {
          const ready = settings.teamSlots ? findChannel(channel) : source;
          if (!ready || !bySession.get(ready.id)?.includes(channel)) return null;
          const params = new URLSearchParams({ sessionId: ready.id, channel });
          if (manage) return `/api/media/whep?${params}`;
          if (!access || !contestLiveTeamChannelAllowed(settings, team.id, channel)) return null;
          params.set('teamId', team.id);
          params.set('target', signContestLiveTarget(examId, team.id, ready.id, channel, access));
          if (key) params.set('key', key);
          return `${base}/whep?${params}`;
        };
        const photo = [team.account, ...team.accounts].map(account => photoByAccount.get(contestLivePhotoAccountHash(account))).find(Boolean);
        const photoQuery = new URLSearchParams(photo ? { v: photo.updatedAt.getTime().toString() } : {});
        if (key) photoQuery.set('key', key);
        if (photo && access) {
          photoQuery.set('teamId', team.id);
          photoQuery.set('target', signContestLivePhotoTarget(examId, team.id, photo.id, access));
        }
        const school = normalizeReactionOrganizationName(team.organization);
        const logo = logos.get(school);
        const logoQuery = new URLSearchParams({ school });
        if (key) logoQuery.set('key', key);
        return {
          ...team,
          ...(manage ? {} : { account: '', accounts: [], candidateIds: [] }),
          photoUrl: photo ? `${base}/photos/${encodeURIComponent(photo.id)}?${photoQuery}` : null,
          organizationLogoUrl: logo ? `${base}/logos/${encodeURIComponent(logo.id)}?${logoQuery}` : null,
          media: { screenUrl: stream('DESKTOP_SCREEN'), cameraUrl: stream('DESKTOP_CAMERA') },
        };
      }),
    },
  };
}
