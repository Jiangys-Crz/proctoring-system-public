import { createHmac, timingSafeEqual } from 'node:crypto';

export type VoiceSide = 'ADMIN' | 'DESKTOP';
export type VoiceMode = 'publish' | 'read';
type Claims = { purpose: 'voice-call'; callId: string; side: VoiceSide; mode: VoiceMode; credential: string; expiresAt: number };
const id = /^[A-Za-z0-9_-]{1,128}$/;
function signature(payload: string) {
  const secret = process.env.MEDIA_PUBLISH_SECRET || process.env.SESSION_SECRET || 'dev-session-secret-change-me';
  if (process.env.NODE_ENV === 'production' && secret === 'dev-session-secret-change-me') throw new Error('语音媒体签名密钥未配置');
  return createHmac('sha256', secret).update(`voice-call:${payload}`).digest('base64url');
}
export function voiceStreamPath(callId: string, side: VoiceSide, mode: VoiceMode) {
  if (!id.test(callId)) throw new Error('语音通话编号无效');
  const source = mode === 'publish' ? side : side === 'ADMIN' ? 'DESKTOP' : 'ADMIN';
  return `/voice/${callId}_${source}`;
}
export function createVoiceMediaToken(callId: string, side: VoiceSide, mode: VoiceMode, credential: string, now = Date.now()) {
  const claims: Claims = { purpose: 'voice-call', callId, side, mode, credential, expiresAt: Math.floor(now / 1000) + 60 };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
export function verifyVoiceMediaToken(token: string, path: string, mode: string, now = Date.now()): Claims | null {
  if (token.length > 2048 || !['read', 'publish'].includes(mode)) return null;
  const [payload, provided, extra] = token.split('.');
  if (!payload || !provided || extra !== undefined) return null;
  const expected = signature(payload), left = Buffer.from(provided), right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
    if (claims.purpose !== 'voice-call' || !id.test(claims.callId) || !['ADMIN', 'DESKTOP'].includes(claims.side)
      || claims.mode !== mode || typeof claims.credential !== 'string' || !claims.credential
      || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= Math.floor(now / 1000)
      || voiceStreamPath(claims.callId, claims.side, claims.mode) !== `/${path.replace(/^\/+/, '')}`) return null;
    return claims;
  } catch { return null; }
}
