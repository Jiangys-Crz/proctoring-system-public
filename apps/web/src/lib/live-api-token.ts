import { createHmac, timingSafeEqual } from 'node:crypto';
import { liveChannels, type LiveChannel } from './media-read-token';

type Claims = { purpose: 'live-api-read'; keyId: string; sessionId: string; channel: LiveChannel; expiresAt: number };
function signature(payload: string) {
  const secret = process.env.MEDIA_URL_SECRET || process.env.SESSION_SECRET || 'dev-session-secret-change-me';
  if (process.env.NODE_ENV === 'production' && secret === 'dev-session-secret-change-me') throw new Error('媒体访问签名密钥未配置');
  return createHmac('sha256', secret).update('live-api-read:' + payload).digest('base64url');
}
export function createLiveApiReadToken(keyId: string, sessionId: string, channel: LiveChannel, now = Date.now()) {
  const claims: Claims = { purpose: 'live-api-read', keyId, sessionId, channel, expiresAt: Math.floor(now / 1000) + 60 };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
export function verifyLiveApiReadToken(token: string, sessionId: string, channel: string, now = Date.now()): Claims | null {
  if (!token || token.length > 2048) return null;
  const [payload, provided, extra] = token.split('.');
  if (!payload || !provided || extra !== undefined) return null;
  const left = Buffer.from(provided), right = Buffer.from(signature(payload));
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
    if (value.purpose !== 'live-api-read' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.keyId)
      || value.sessionId !== sessionId || value.channel !== channel || !liveChannels.includes(value.channel)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Math.floor(now / 1000)) return null;
    return value;
  } catch { return null; }
}
