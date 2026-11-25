import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from './auth';

export const contestLiveChannels = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA'] as const;
export type ContestLiveChannel = typeof contestLiveChannels[number];

function sign(purpose: string, value: string) {
  const secret = process.env.MEDIA_URL_SECRET || process.env.SESSION_SECRET || 'dev-session-secret-change-me';
  if (process.env.NODE_ENV === 'production' && secret === 'dev-session-secret-change-me') throw new Error('媒体访问签名密钥未配置');
  return createHmac('sha256', secret).update(purpose).update(value).digest('base64url');
}

function validSignature(provided: string, expected: string) {
  return provided.length === expected.length && /^[A-Za-z0-9_-]+$/.test(provided)
    && timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function signContestLiveTarget(examId: string, teamId: string, sessionId: string, channel: ContestLiveChannel, access: string) {
  return sign('contest-live-target:', JSON.stringify([examId, teamId, sessionId, channel, access]));
}

export function assertContestLiveTarget(provided: string, examId: string, teamId: string, sessionId: string, channel: ContestLiveChannel, access: string) {
  if (!validSignature(provided, signContestLiveTarget(examId, teamId, sessionId, channel, access))) throw new AuthError('无权查看该赛事直播画面', 403);
}

export function signContestLivePhotoTarget(examId: string, teamId: string, photoId: string, access: string) {
  return sign('contest-live-photo-target:', JSON.stringify([examId, teamId, photoId, access]));
}

export function assertContestLivePhotoTarget(provided: string, examId: string, teamId: string, photoId: string, access: string) {
  if (!validSignature(provided, signContestLivePhotoTarget(examId, teamId, photoId, access))) throw new AuthError('无权查看该队伍照片', 403);
}

export function signContestDisplayHistoryLogo(examId: string, archivedExamId: string, revision: number, school: string, assetId: string) {
  return sign('contest-display-history-logo:', JSON.stringify([examId, archivedExamId, revision, school, assetId]));
}

export function matchesContestDisplayHistoryLogo(supplied: string, examId: string, archivedExamId: string, revision: number, school: string, assetId: string) {
  return validSignature(supplied, signContestDisplayHistoryLogo(examId, archivedExamId, revision, school, assetId));
}

type MediaClaims = {
  examId: string;
  teamId: string;
  sessionId: string;
  channel: ContestLiveChannel;
  access: string;
  expiresAt: number;
};

export function createContestLiveMediaToken(claims: Omit<MediaClaims, 'expiresAt'>) {
  const payload = Buffer.from(JSON.stringify({ ...claims, expiresAt: Date.now() + 60_000 })).toString('base64url');
  return `contest-live.${payload}.${sign('contest-live-media:', payload)}`;
}

export function verifyContestLiveMediaToken(token: string, sessionId: string, channel: string): MediaClaims | null {
  if (token.length > 2048) return null;
  const [purpose, payload, supplied, extra] = token.split('.');
  if (purpose !== 'contest-live' || !payload || !supplied || extra !== undefined) return null;
  if (!validSignature(supplied, sign('contest-live-media:', payload))) return null;
  try {
    const value: MediaClaims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof value.examId !== 'string' || typeof value.teamId !== 'string' || typeof value.access !== 'string'
      || value.sessionId !== sessionId || value.channel !== channel || !contestLiveChannels.includes(value.channel)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) return null;
    return value;
  } catch { return null; }
}
