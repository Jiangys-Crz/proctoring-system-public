import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from './auth';

export const relayIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export function relayStreamLimit() {
  const value = Number(process.env.LIVE_RELAY_MAX_STREAMS || 8);
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(64, value)) : 8;
}
export const relayKeyPattern = /^relay_[A-Za-z0-9_-]{43}$/;
export const relayReadKeyPattern = /^relay_read_[A-Za-z0-9_-]{43}$/;
export const relayHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const newRelayKey = (read = false) => (read ? 'relay_read_' : 'relay_') + randomBytes(32).toString('base64url');
export function relayEnabled() { return process.env.LIVE_RELAY_ENABLED === '1'; }
export function requireRelayEnabled() { if (!relayEnabled()) throw new AuthError('直播转发服务尚未启用，请先按文档完成独立媒体服务配置', 503); }
function secret() {
  const value = process.env.LIVE_RELAY_AUTH_SECRET || '';
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value) || /CHANGE_ME/i.test(value)) throw new AuthError('直播转发内部鉴权尚未配置', 503);
  return value;
}
export function equalRelaySecret(provided: string) { return timingSafeEqual(Buffer.from(relayHash(provided)), Buffer.from(relayHash(secret()))); }
export function relayControlToken() { return createHmac('sha256', secret()).update('live-relay-control-v1').digest('base64url'); }
export function validRelayControlToken(value: string) { return timingSafeEqual(Buffer.from(relayHash(value)), Buffer.from(relayHash(relayControlToken()))); }
export type RelayClaims = { purpose: 'live-relay-read'; id: string; keyId: string; adminId?: string; exp: number };
function sign(value: string) { return createHmac('sha256', secret()).update('live-relay-read-v1:' + value).digest('base64url'); }
export function createRelayTicket(id: string, keyId: string, adminId?: string) {
  const claims: RelayClaims = { purpose: 'live-relay-read', id, keyId, ...(adminId ? { adminId } : {}), exp: Math.floor(Date.now() / 1000) + (adminId ? 900 : 86400) };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return payload + '.' + sign(payload);
}
export function verifyRelayTicket(ticket: string, id: string): RelayClaims | null {
  if (ticket.length > 1024 || !relayIdPattern.test(id)) return null;
  const [payload, signature, extra] = ticket.split('.');
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  if (!timingSafeEqual(Buffer.from(relayHash(signature)), Buffer.from(relayHash(sign(payload))))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RelayClaims;
    if (value.purpose !== 'live-relay-read' || value.id !== id || !/^[A-Za-z0-9_-]{1,128}$/.test(value.keyId)
      || !Number.isSafeInteger(value.exp) || value.exp <= Math.floor(Date.now() / 1000)
      || (value.adminId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(value.adminId))) return null;
    return value;
  } catch { return null; }
}
export function relayPlaybackUrl(ticket: string, id: string) {
  const base = new URL(process.env.LIVE_RELAY_PUBLIC_BASE || process.env.APP_BASE_URL || 'http://localhost:4031');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new AuthError('直播播放域名配置无效', 503);
  return `${base.origin}/api/live/${encodeURIComponent(id)}?ticket=${encodeURIComponent(ticket)}`;
}

export const relayUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type SignalClaims = { purpose: 'relay-webrtc'; connectionId: string; id: string; mode: 'publish' | 'read'; exp: number };
export function relaySignalToken(connectionId: string, id: string, mode: SignalClaims['mode']) {
  const payload = Buffer.from(JSON.stringify({ purpose: 'relay-webrtc', connectionId, id, mode, exp: Math.floor(Date.now() / 1000) + 60 } satisfies SignalClaims)).toString('base64url');
  return payload + '.' + sign(payload);
}
export function verifyRelaySignalToken(token: string): SignalClaims | null {
  if (token.length > 1024) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  if (!timingSafeEqual(Buffer.from(relayHash(signature)), Buffer.from(relayHash(sign(payload))))) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignalClaims;
    if (c.purpose !== 'relay-webrtc' || !relayUuid.test(c.connectionId) || !relayIdPattern.test(c.id) || !['publish', 'read'].includes(c.mode)
      || !Number.isSafeInteger(c.exp) || c.exp <= Date.now() / 1000) return null;
    return c;
  } catch { return null; }
}
