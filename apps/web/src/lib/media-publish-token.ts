import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ClientSession } from '@prisma/client';
import { requiredEnv, appBaseUrl } from './env';
import { liveChannels, type LiveChannel } from './media-read-token';

type Session = Pick<ClientSession, 'id' | 'desktopTokenHash' | 'miniProgramTokenHash' | 'revokedAt'>;
type Claims = { purpose: 'media-publish'; sessionId: string; channel: LiveChannel; binding: string; expiresAt: number; origin: string };
const sign = (value: string) => createHmac('sha256', process.env.MEDIA_PUBLISH_SECRET || requiredEnv('SESSION_SECRET')).update(value).digest('base64url');
function binding(session: Session, channel: LiveChannel) {
  const hash = channel === 'MOBILE_CAMERA' ? session.miniProgramTokenHash : session.desktopTokenHash;
  return hash && !session.revokedAt ? sign(`media-session:${session.id}:${channel}:${hash}`) : null;
}
export function createMediaPublishToken(session: Session, channel: LiveChannel, now = Date.now()) {
  const current = binding(session, channel);
  if (!current) throw new Error('客户端会话已注销');
  const claims: Claims = { purpose: 'media-publish', sessionId: session.id, channel, binding: current, expiresAt: now + 5 * 60_000, origin: new URL(appBaseUrl()).origin };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { token: `${payload}.${sign(`media-publish:${payload}`)}`, expiresAt: new Date(claims.expiresAt).toISOString() };
}
export function verifyMediaPublishToken(value: string, session: Session, channel: string, now = Date.now()) {
  if (!value || value.length > 2048 || !liveChannels.includes(channel as LiveChannel)) return false;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return false;
  const left = Buffer.from(signature), right = Buffer.from(sign(`media-publish:${payload}`));
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Claims;
    return claims.purpose === 'media-publish' && claims.sessionId === session.id && claims.channel === channel &&
      claims.origin === new URL(appBaseUrl()).origin && Number.isSafeInteger(claims.expiresAt) && claims.expiresAt > now &&
      claims.expiresAt <= now + 5 * 60_000 && claims.binding === binding(session, channel as LiveChannel);
  } catch { return false; }
}
