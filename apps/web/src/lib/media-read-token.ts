import { createHmac, timingSafeEqual } from 'node:crypto';

export const liveChannels = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'] as const;
export type LiveChannel = (typeof liveChannels)[number];
type ReadClaims = { purpose: 'media-read'; userId: string; sessionId: string; channel: LiveChannel; expiresAt: number };

function secret() {
  const value = process.env.MEDIA_URL_SECRET || process.env.SESSION_SECRET || 'dev-session-secret-change-me';
  if (process.env.NODE_ENV === 'production' && value === 'dev-session-secret-change-me') throw new Error('媒体访问签名密钥未配置');
  return value;
}

function signature(payload: string) { return createHmac('sha256', secret()).update(`media-read:${payload}`).digest('base64url'); }

export function createMediaReadToken(userId: string, sessionId: string, channel: LiveChannel, now = Date.now()) {
  const claims: ReadClaims = { purpose: 'media-read', userId, sessionId, channel, expiresAt: Math.floor(now / 1000) + 60 };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifyMediaReadToken(token: string, sessionId: string, channel: string, now = Date.now()): ReadClaims | null {
  if (!token || token.length > 2048) return null;
  const [payload, provided, extra] = token.split('.');
  if (!payload || !provided || extra !== undefined) return null;
  const expected = signature(payload);
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ReadClaims;
    if (claims.purpose !== 'media-read' || typeof claims.userId !== 'string' || !claims.userId ||
      claims.sessionId !== sessionId || claims.channel !== channel || !liveChannels.includes(claims.channel) ||
      !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= Math.floor(now / 1000)) return null;
    return claims;
  } catch { return null; }
}

export function mediaStreamPath(sessionId: string, channel: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !liveChannels.includes(channel as LiveChannel)) throw new Error('直播参数不正确');
  return `/live/${sessionId}_${channel}`;
}

/** Keep every HLS playlist, init segment and low-latency part inside the authenticated proxy. */
export function rewriteHlsPlaylist(playlist: string, upstreamUrl: URL, proxyPrefix: string, streamPath: string) {
  const rewrite = (value: string) => {
    const target = new URL(value, upstreamUrl);
    if (target.origin !== upstreamUrl.origin || !target.pathname.startsWith(`${streamPath}/`)) throw new Error('直播播放列表包含无效的媒体地址');
    target.searchParams.delete('token');
    return `${proxyPrefix}/${target.pathname.slice(streamPath.length + 1)}${target.search}`;
  };
  return playlist.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (!line.startsWith('#')) return rewrite(line.trim());
    return line.replace(/URI="([^"]*)"/g, (_match, uri: string) => `URI="${rewrite(uri)}"`);
  }).join('\n');
}
