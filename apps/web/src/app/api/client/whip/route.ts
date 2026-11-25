import { prisma } from '@/lib/db';
import { clientSessionTokenFromRequest, verifyClientTokenForSession } from '@/lib/client-auth';
import { createMediaPublishToken } from '@/lib/media-publish-token';
import type { LiveChannel } from '@/lib/media-read-token';
import { options, fail, toErrorMessage } from '@/lib/http';
import { browserIceAnswer } from '@/lib/browser-ice';
import { AuthError } from '@/lib/auth';
import { readContestLiveBody } from '@/lib/contest-live-body';
import { liveWebRtcResource, liveWebRtcResourceProof, verifyLiveWebRtcResourceProof } from '@/lib/live-webrtc';
import { liveChannels, mediaStreamPath } from '@/lib/media-read-token';
import { effectiveEnd } from '@/lib/contest-rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-proctor-client,x-proctor-session-token,authorization',
  'Access-Control-Expose-Headers': 'Location,Link,ETag'
};

function mediaBase() {
  return (process.env.MEDIA_WHIP_INTERNAL_BASE || 'http://127.0.0.1:8889').replace(/\/+$/, '');
}

function requestParams(request: Request) {
  const url = new URL(request.url);
  return {
    sessionId: url.searchParams.get('sessionId') || '',
    channel: url.searchParams.get('channel') || '',
    resource: url.searchParams.get('resource') || '',
    proof: url.searchParams.get('proof') || ''
  };
}

function publishPath(sessionId: string, channel: string) {
  return `${mediaStreamPath(sessionId, channel)}/whip`;
}

function safeResourcePath(value: string, sessionId: string, channel: string, upstreamToken?: string) {
  if (!value) return '';
  try {
    const base = mediaBase();
    const location = new URL(value, base);
    // MediaMTX echoes the initiating query in Location. Strip only our
    // expected token and never return that upstream credential to a client.
    if (upstreamToken && location.search === `?token=${encodeURIComponent(upstreamToken)}`) location.search = '';
    const id = liveWebRtcResource(location.href, base, mediaStreamPath(sessionId, channel), 'whip');
    return `${publishPath(sessionId, channel)}/${id}`;
  } catch {
    return '';
  }
}

async function authenticate(request: Request, sessionId: string, channel: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { ok: false as const, response: fail('客户端会话参数不正确', 400) };
  if (!liveChannels.includes(channel as LiveChannel)) {
    return { ok: false as const, response: fail('不支持的 WHIP 画面通道', 400) };
  }
  const session = await prisma.clientSession.findUnique({
    where: { id: sessionId },
    include: {
      exam: { select: { startAt: true, endAt: true, latestStartAt: true, durationMinutes: true, contestRule: true,
        flexible: true, requireFrontCamera: true, requireMiniProgram: true } },
      candidate: { select: { startedAt: true } },
    }
  });
  if (!session) return { ok: false as const, response: fail('客户端会话不存在', 404) };
  const side = channel === 'MOBILE_CAMERA' ? 'MINIPROGRAM' : 'DESKTOP';
  if (!verifyClientTokenForSession(request, session, side)) {
    return { ok: false as const, response: fail('客户端会话令牌无效或已过期', 401) };
  }
  if (request.method !== 'DELETE' && (session.status === 'FINISHED' || effectiveEnd(session.exam, session.candidate?.startedAt || session.startedAt) <= new Date())) {
    return { ok: false as const, response: fail('考试会话已结束，不能继续推流', 409) };
  }
  if (request.method === 'POST' && channel !== 'DESKTOP_SCREEN') {
    const room = await prisma.examRoom.findFirst({
      where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } },
      select: { requireFrontCamera: true, requireSecondCamera: true }
    });
    const required = channel === 'DESKTOP_CAMERA'
      ? room?.requireFrontCamera ?? session.exam.requireFrontCamera
      : room?.requireSecondCamera ?? session.exam.requireMiniProgram;
    if (!required) return { ok: false as const, response: fail(channel === 'DESKTOP_CAMERA' ? '所在考室不要求前置摄像头推流' : '所在考室不要求第二机位推流', 409) };
  }
  return { ok: true as const, session };
}

function upstreamHeaders(response: Response) {
  const headers = new Headers(corsHeaders);
  headers.set('content-type', response.headers.get('content-type') || 'application/sdp');
  const link = response.headers.get('link');
  const etag = response.headers.get('etag');
  if (link) headers.set('link', link);
  if (etag) headers.set('etag', etag);
  return headers;
}

export async function POST(request: Request) {
  let created: { path: string; token: string } | undefined;
  try {
    const { sessionId, channel } = requestParams(request);
    const auth = await authenticate(request, sessionId, channel);
    if (!auth.ok) return auth.response;
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/sdp')) return fail('WHIP 请求体必须是 application/sdp', 415);
    const offer = (await readContestLiveBody(request, 65536)).toString('utf8');
    if (!offer.trim().startsWith('v=0')) return fail('WHIP SDP offer 无效', 400);
    const { token } = createMediaPublishToken(auth.session, channel as LiveChannel);

    const upstream = await fetch(`${mediaBase()}${publishPath(sessionId, channel)}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/sdp',
        accept: 'application/sdp',
        // MediaMTX extracts WebRTC credentials from the Bearer header and
        // forwards them as the `token` field to the HTTP auth endpoint.
        authorization: `Bearer ${token}`
      },
      body: offer,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
    });
    const body = await upstream.text();
    const headers = upstreamHeaders(upstream);
    const location = upstream.headers.get('location');
    if (upstream.ok && location) {
      const resource = safeResourcePath(location, sessionId, channel, token);
      if (resource) {
        created = { path: resource, token };
        const current = await authenticate(request, sessionId, channel);
        if (!current.ok) {
          await closeUnissuedPublisher(created);
          created = undefined;
          return current.response;
        }
        const local = new URL(request.url);
        local.searchParams.set('resource', resource);
        local.searchParams.set('proof', liveWebRtcResourceProof(resource, clientSessionTokenFromRequest(request)));
        headers.set('location', `${local.pathname}${local.search}`);
      }
    }
    return new Response(upstream.ok ? browserIceAnswer(body) : body, { status: upstream.status, headers });
  } catch (error) {
    if (created) await closeUnissuedPublisher(created);
    if (error instanceof AuthError) return fail(error.message, error.status);
    const message = toErrorMessage(error);
    return fail(message.includes('fetch') || message.includes('connect') ? 'WHIP 媒体服务不可用，请确认 MediaMTX 已启动' : message, 502);
  }
}

async function closeUnissuedPublisher({ path, token }: { path: string; token: string }) {
  try {
    const response = await fetch(`${mediaBase()}${path}?token=${encodeURIComponent(token)}`, {
      method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${token}`, 'if-match': '*' },
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw new Error('媒体服务拒绝关闭未签发的推流');
  } catch (error) {
    console.error('Failed to close unissued WHIP publisher', error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { sessionId, channel, resource, proof } = requestParams(request);
    const auth = await authenticate(request, sessionId, channel);
    if (!auth.ok) return auth.response;
    const path = safeResourcePath(resource, sessionId, channel);
    if (!path) return fail('WHIP 资源地址无效或已过期', 400);
    if (!verifyLiveWebRtcResourceProof(proof, path, clientSessionTokenFromRequest(request))) return fail('无权操作该推流连接', 403);
    const { token } = createMediaPublishToken(auth.session, channel as LiveChannel);
    const upstream = await fetch(`${mediaBase()}${path}?token=${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
        ...(request.headers.get('if-match') ? { 'if-match': request.headers.get('if-match')! } : {})
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000)
    });
    return new Response(upstream.status === 204 ? null : await upstream.text(), { status: upstream.status, headers: upstreamHeaders(upstream) });
  } catch (error) {
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
