import { randomBytes } from 'node:crypto';
import { AuthError } from './auth';
import { prisma } from './db';
import { admittedRelaySignal, relayHeaders } from './live-relay-http';
import { authorizeRelayTicket, relayStreamForKey } from './live-relay';
import { closeRelayConnection, relayConnectionAllowed, reserveRelayConnection, type RelayOwner } from './live-relay-connections';
import { createRelayTicket, relayHash, relayIdPattern, relayPlaybackUrl, relaySignalToken, relayUuid, requireRelayEnabled } from './live-relay-token';

const headers = { ...relayHeaders, 'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Location,ETag,Accept-Patch', 'Access-Control-Allow-Methods': 'GET,HEAD,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,If-Match', 'Access-Control-Max-Age': '600' };
function mediaBase() {
  const url = new URL(process.env.LIVE_RELAY_WHIP_INTERNAL_BASE || 'http://relay-media:8889');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new AuthError('WebRTC 内部服务配置无效', 503);
  return url.origin;
}
async function ownerFor(request: Request, id: string, mode: 'publish' | 'read'): Promise<RelayOwner> {
  const url = new URL(request.url), keys = url.searchParams.getAll('apikey'), tickets = url.searchParams.getAll('ticket'), bearer = request.headers.get('authorization');
  if (keys.length > 1 || tickets.length > 1 || Number(keys.length > 0) + Number(tickets.length > 0) + Number(Boolean(bearer)) !== 1) throw new AuthError('请提供唯一的系统直播密钥或播放授权', 401);
  if (bearer && !/^Bearer \S+$/.test(bearer)) throw new AuthError('直播密钥格式不正确', 401);
  const key = bearer ? bearer.slice(7) : keys[0];
  if (mode === 'publish' && !key) throw new AuthError('推流需要系统直播密钥', 401);
  if (key) {
    const stream = await relayStreamForKey(id, key);
    return { keyId: stream.keyId, credential: key, expiresAt: new Date(Date.now() + 24 * 3600_000) };
  }
  const claims = await authorizeRelayTicket(id, tickets[0] || '');
  return { keyId: claims.keyId, credential: tickets[0], adminId: claims.adminId, expiresAt: new Date(claims.exp * 1000) };
}
async function boundedSdp(body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  if (!body) throw new AuthError('缺少 WebRTC 协商内容', 400);
  const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0, interrupted = false;
  const cancel = () => { interrupted = true; void reader.cancel().catch(() => {}); };
  const timeout = setTimeout(cancel, 10_000);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (interrupted) throw new AuthError('WebRTC 协商读取超时或请求已取消', 408);
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new AuthError('WebRTC 协商内容过大', 413); }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
function resourceSecret(location: string, base: string, path: string) {
  const url = new URL(location, base), prefix = path + '/', secret = url.pathname.slice(prefix.length);
  if (url.origin !== base || !url.pathname.startsWith(prefix) || !relayUuid.test(secret) || url.search || url.hash || url.username || url.password) throw new AuthError('媒体服务返回无效 WebRTC 资源', 502);
  return secret;
}
function playerPage() {
  const nonce = randomBytes(18).toString('base64');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实时直播</title><style nonce="${nonce}">html,body{margin:0;width:100%;height:100%;background:#000;color:#fff}video{width:100%;height:100%;object-fit:contain}#status{position:fixed;bottom:48px;left:0;right:0;text-align:center;font:16px sans-serif}</style><video autoplay muted controls playsinline></video><div id="status">正在连接实时直播…</div><script type="module" nonce="${nonce}">import{createRelayWebRtcReader}from'/live-relay-webrtc.js';const video=document.querySelector('video'),status=document.getElementById('status');const reader=createRelayWebRtcReader({url:location.pathname+location.search,video,onStatus:text=>{status.textContent=text;status.hidden=!text;}});const checkUrl=new URL(location.href);checkUrl.searchParams.set('check','1');const timer=setInterval(()=>fetch(checkUrl,{cache:'no-store'}).then(r=>{if([401,403].includes(r.status)){clearInterval(timer);reader.close();status.hidden=false;status.textContent='直播授权已失效';}}).catch(()=>{}),10000);addEventListener('pagehide',()=>{clearInterval(timer);reader.close();});</script></html>`;
  return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src blob:; base-uri 'none'; form-action 'none'` } });
}
export function relayWebRtcOptions() { return new Response(null, { status: 204, headers: { ...headers, 'Accept-Post': 'application/sdp' } }); }
export async function serveRelayWebRtc(request: Request, id: string, mode: 'publish' | 'read') {
  const result = await admittedRelaySignal(request, async () => {
    requireRelayEnabled();
    if (!relayIdPattern.test(id)) throw new AuthError('直播编号无效', 400);
    const url = new URL(request.url);
    if (url.searchParams.getAll('resource').length > 1) throw new AuthError('连接资源参数重复', 400);
    if (request.method === 'POST' && url.searchParams.has('resource')) throw new AuthError('新建连接不能携带旧资源', 400);
    const owner = await ownerFor(request, id, mode);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (mode !== 'read') throw new AuthError('推流请使用 WHIP POST 接口', 405);
      if (url.searchParams.has('check')) return new Response(null, { status: 204 });
      if (!url.searchParams.has('ticket')) {
        const playback = relayPlaybackUrl(createRelayTicket(id, owner.keyId), id);
        if (url.searchParams.get('format') === 'json') return Response.json({ ok: true, data: { id, url: playback, protocol: 'webrtc', signaling: 'whep', expiresIn: 86400 } });
        return new Response(null, { status: 302, headers: { Location: playback } });
      }
      return playerPage();
    }
    const path = `/relay/${id}/${mode === 'publish' ? 'whip' : 'whep'}`, base = mediaBase();
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/sdp')) throw new AuthError('协商需要 application/sdp', 415);
      const body = await boundedSdp(request.body, request.signal);
      if (!body.trim().startsWith('v=0')) throw new AuthError('SDP offer 无效', 400);
      const row = await reserveRelayConnection(id, mode, owner);
      try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
        const upstream = await fetch(base + path, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
          headers: { authorization: `Bearer ${relaySignalToken(row.id, id, mode)}`, 'content-type': 'application/sdp' }, body });
        if (upstream.status !== 201) { await upstream.body?.cancel(); throw new AuthError('直播尚未推流、连接已占用或媒体服务暂不可用', upstream.status === 404 ? 404 : 502); }
        const secret = resourceSecret(upstream.headers.get('location') || '', base, path), mediaId = upstream.headers.get('id') || '';
        if (!relayUuid.test(mediaId)) throw new AuthError('媒体服务未返回连接编号', 502);
        const answer = await boundedSdp(upstream.body, signal);
        if (!answer.trim().startsWith('v=0')) throw new AuthError('SDP answer 无效', 502);
        const fresh = await prisma.liveRelayWebRtcConnection.findUnique({ where: { id: row.id } });
        if (!fresh || fresh.mediaId !== mediaId || !await relayConnectionAllowed(fresh) || request.signal.aborted) throw new AuthError('直播授权已失效', 401);
        const updated = await prisma.liveRelayWebRtcConnection.updateMany({ where: { id: row.id, mediaId, expiresAt: { gt: new Date() } }, data: { resourceSecret: secret, expiresAt: owner.expiresAt } });
        if (!updated.count) throw new AuthError('直播连接已回收', 409);
        url.searchParams.set('resource', row.id);
        return new Response(answer, { status: 201, headers: { 'Content-Type': 'application/sdp', Location: url.pathname + url.search, ETag: '*' } });
      } catch (error) { await closeRelayConnection(row.id).catch(() => {}); throw error; }
    }
    const resource = url.searchParams.get('resource') || '';
    if (!relayUuid.test(resource)) throw new AuthError('缺少或无效的直播连接资源', 400);
    const row = await prisma.liveRelayWebRtcConnection.findUnique({ where: { id: resource } });
    if (!row || row.streamId !== id || row.mode !== mode || row.keyId !== owner.keyId || row.ownerHash !== relayHash(owner.credential) || !row.resourceSecret || !await relayConnectionAllowed(row)) throw new AuthError('无权访问该直播连接', 403);
    if (request.method === 'DELETE') { await closeRelayConnection(row.id); return new Response(null, { status: 204 }); }
    if (request.method !== 'PATCH') throw new AuthError('请求方法不支持', 405);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/trickle-ice-sdpfrag')) throw new AuthError('候选地址需要 application/trickle-ice-sdpfrag', 415);
    const body = await boundedSdp(request.body, request.signal);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
    const upstream = await fetch(`${base}${path}/${row.resourceSecret}`, { method: 'PATCH', redirect: 'error', cache: 'no-store', body,
      headers: { 'content-type': 'application/trickle-ice-sdpfrag', 'if-match': request.headers.get('if-match') || '*' }, signal });
    if (upstream.status === 404) { await closeRelayConnection(row.id); return new Response(null, { status: 404 }); }
    const text = upstream.status === 204 ? null : await boundedSdp(upstream.body, signal);
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/trickle-ice-sdpfrag', ETag: upstream.headers.get('etag') || '*' } });
  });
  for (const [key, value] of Object.entries(headers)) result.headers.set(key, value);
  return result;
}
