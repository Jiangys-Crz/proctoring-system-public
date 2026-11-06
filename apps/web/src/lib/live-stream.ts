import { randomBytes } from 'node:crypto';
import { AuthError } from './auth';
import { authorizeLiveApiKey } from './live-api-key';
import { createLiveApiReadToken } from './live-api-token';
import { prisma } from './db';
import { canPublishChannel } from './media-publish-access';
import { mediaStreamPath, type LiveChannel } from './media-read-token';
import { fail, toErrorMessage } from './http';
import { deleteLiveWebRtcResource, liveWebRtcResource } from './live-webrtc';
import { browserIceAnswer } from './browser-ice';

export type LiveStreamParams = { examCode: string; examNumber: string; camera: string; stream?: string[] };
const channels: Record<string, LiveChannel> = { '1': 'DESKTOP_SCREEN', '2': 'DESKTOP_CAMERA', '3': 'MOBILE_CAMERA' };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function parseLiveStreamRequest(request: Request, params: LiveStreamParams) {
  if (!Object.hasOwn(channels, params.camera) || !/^\d{10}$/.test(params.examCode) || !params.examNumber || params.examNumber.length > 200
    || /[/\\\x00-\x1f\x7f]/.test(params.examNumber) || ['.', '..'].includes(params.examNumber)) throw new AuthError('直播地址参数不正确', 400);
  const credential = params.stream?.[0];
  if ((params.stream?.length || 0) > 1 || credential !== undefined && !credential.startsWith('apikey=')) throw new AuthError('直播资源地址无效', 400);
  const url = new URL(request.url), resource = url.searchParams.get('resource');
  if (resource && !uuid.test(resource)) throw new AuthError('直播资源地址无效', 400);
  return { key: credential === undefined ? url.searchParams.get('apikey') || '' : credential.slice(7), channel: channels[params.camera], resource };
}
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'access-control-allow-origin': '*', 'access-control-expose-headers': 'location,etag' };
function playerPage() {
  const nonce = randomBytes(18).toString('base64');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实时直播</title><style nonce="${nonce}">html,body{margin:0;width:100%;height:100%;background:#000;color:#fff}video{width:100%;height:100%;object-fit:contain}#status{position:fixed;bottom:16px;left:0;right:0;text-align:center;font:16px sans-serif}</style><video autoplay muted playsinline></video><div id="status">正在连接直播…</div><script type="module" nonce="${nonce}">import {createProctorWebRtcReader,isProctorWebRtcPlaying} from '/live-webrtc.js';const video=document.querySelector('video'),status=document.getElementById('status');const reader=createProctorWebRtcReader({url:location.pathname+location.search,onTrack:e=>{if(e.track.kind!=='video')return;video.srcObject=e.streams[0]||new MediaStream([e.track]);video.play().catch(()=>{});},onReset:()=>{video.srcObject=null;status.hidden=false;},onError:()=>{status.hidden=false;status.textContent='连接中断，正在重试…';}});video.onplaying=()=>{if(isProctorWebRtcPlaying(reader,video))status.hidden=true;};video.onwaiting=()=>{status.hidden=false;status.textContent='等待实时画面…';};const checkUrl=new URL(location.href);checkUrl.searchParams.set('check','1');const check=setInterval(()=>fetch(checkUrl).then(r=>{if(!r.ok){reader.close();clearInterval(check);status.hidden=false;status.textContent='直播授权已失效';}}).catch(()=>{}),5000);addEventListener('pagehide',()=>{clearInterval(check);reader.close();});</script></html>`;
  return new Response(html, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src blob:; base-uri 'none'; form-action 'none'` } });
}
export async function serveLiveStream(request: Request, params: LiveStreamParams) {
  let created: string | undefined;
  let createdTarget: { sessionId: string; channel: LiveChannel } | undefined;
  try {
    const parsed = parseLiveStreamRequest(request, params), keyId = await authorizeLiveApiKey(parsed.key);
    const session = await prisma.clientSession.findFirst({ where: { exam: { examCode: params.examCode }, candidate: { examNumber: params.examNumber, exam: { examCode: params.examCode } }, revokedAt: null,
      status: { in: ['APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, examId: true, candidateId: true, status: true, revokedAt: true } });
    if (!session || !await canPublishChannel(session, parsed.channel)) throw new AuthError('该机位暂无可用直播', 404);
    if (request.method === 'GET') return new URL(request.url).searchParams.has('check') ? new Response(null, { status: 204, headers }) : playerPage();
    const base = (process.env.MEDIA_WHIP_INTERNAL_BASE || 'http://127.0.0.1:8889').replace(/\/+$/, ''), streamPath = mediaStreamPath(session.id, parsed.channel);
    const token = createLiveApiReadToken(keyId, session.id, parsed.channel);
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/sdp')) throw new AuthError('直播协商必须使用 application/sdp', 415);
      const body = await request.text(); if (body.length > 65536) throw new AuthError('直播协商请求过大', 413);
      if (!body.trim().startsWith('v=0')) throw new AuthError('直播协商数据无效', 400);
      const response = await fetch(`${base}${streamPath}/whep`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/sdp' }, body, cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) return new Response(null, { status: response.status, headers });
      created = liveWebRtcResource(response.headers.get('location') || '', base, streamPath);
      createdTarget = { sessionId: session.id, channel: parsed.channel };
      const answer = browserIceAnswer(await response.text());
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM LiveApiKey WHERE id = ${keyId} FOR UPDATE`;
        const key = await tx.liveApiKey.findUnique({ where: { id: keyId }, select: { enabled: true } });
        const fresh = await tx.clientSession.findUnique({ where: { id: session.id }, select: { status: true, revokedAt: true } });
        if (!key?.enabled || !fresh || fresh.revokedAt || fresh.status === 'FINISHED') throw new AuthError('直播授权已失效', 401);
        await tx.liveWebRtcConnection.create({ data: { id: created!, keyId, sessionId: session.id, channel: parsed.channel } });
      });
      const url = new URL(request.url); url.searchParams.set('resource', created);
      return new Response(answer, { status: 201, headers: { ...headers, 'content-type': 'application/sdp', location: url.pathname + url.search, etag: response.headers.get('etag') || '*' } });
    }
    if (!parsed.resource) throw new AuthError('缺少直播连接资源', 400);
    const connection = await prisma.liveWebRtcConnection.findUnique({ where: { id: parsed.resource } });
    if (!connection || connection.keyId !== keyId || connection.sessionId !== session.id || connection.channel !== parsed.channel) throw new AuthError('无权访问该直播连接', 403);
    if (request.method !== 'PATCH' && request.method !== 'DELETE') throw new AuthError('请求方法不支持', 405);
    let body: string | undefined;
    if (request.method === 'PATCH') {
      if (!request.headers.get('content-type')?.startsWith('application/trickle-ice-sdpfrag')) throw new AuthError('候选地址格式不正确', 415);
      body = await request.text(); if (body.length > 65536) throw new AuthError('候选地址请求过大', 413);
    }
    const response = await fetch(`${base}${streamPath}/whep/${parsed.resource}`, { method: request.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/trickle-ice-sdpfrag', 'if-match': '*' }, body, cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (request.method === 'DELETE' && (response.ok || response.status === 404)) await prisma.liveWebRtcConnection.deleteMany({ where: { id: parsed.resource, keyId } });
    return new Response(response.status === 204 ? null : await response.text(), { status: response.status, headers });
  } catch (error) {
    if (created && createdTarget) {
      try { await deleteLiveWebRtcResource(created, createdTarget.sessionId, createdTarget.channel); await prisma.liveWebRtcConnection.deleteMany({ where: { id: created } }); } catch {}
    }
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}
