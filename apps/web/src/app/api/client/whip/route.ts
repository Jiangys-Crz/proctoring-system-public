import { prisma } from '@/lib/db';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { createMediaPublishToken } from '@/lib/media-publish-token';
import type { LiveChannel } from '@/lib/media-read-token';
import { options, fail, toErrorMessage } from '@/lib/http';
import { browserIceAnswer } from '@/lib/browser-ice';

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
    resource: url.searchParams.get('resource') || ''
  };
}

function streamName(sessionId: string, channel: string) {
  return `${sessionId}_${channel}`;
}

function publishPath(sessionId: string, channel: string) {
  return `/live/${encodeURIComponent(streamName(sessionId, channel))}/whip`;
}

function safeResourcePath(value: string, sessionId: string, channel: string) {
  if (!value) return '';
  let pathname = value;
  try {
    const parsed = new URL(value, mediaBase());
    pathname = parsed.pathname;
  } catch {
    return '';
  }
  const expected = `${publishPath(sessionId, channel)}/`;
  return pathname.startsWith(expected) ? pathname : '';
}

async function authenticate(request: Request, sessionId: string, channel: string) {
  if (!sessionId) return { ok: false as const, response: fail('缺少 sessionId', 400) };
  if (!['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'].includes(channel)) {
    return { ok: false as const, response: fail('不支持的 WHIP 画面通道', 400) };
  }
  const session = await prisma.clientSession.findUnique({
    where: { id: sessionId },
    include: { exam: { select: { endAt: true, requireFrontCamera: true, requireMiniProgram: true } } }
  });
  if (!session) return { ok: false as const, response: fail('客户端会话不存在', 404) };
  const side = channel === 'MOBILE_CAMERA' ? 'MINIPROGRAM' : 'DESKTOP';
  if (!verifyClientTokenForSession(request, session, side)) {
    return { ok: false as const, response: fail('客户端会话令牌无效或已过期', 401) };
  }
  if (request.method !== 'DELETE' && (session.status === 'FINISHED' || session.exam.endAt <= new Date())) {
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
  try {
    const { sessionId, channel } = requestParams(request);
    const auth = await authenticate(request, sessionId, channel);
    if (!auth.ok) return auth.response;
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/sdp')) return fail('WHIP 请求体必须是 application/sdp', 415);
    const offer = await request.text();
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
      signal: AbortSignal.timeout(15_000)
    });
    const body = await upstream.text();
    const headers = upstreamHeaders(upstream);
    const location = upstream.headers.get('location');
    if (upstream.ok && location) {
      const resource = safeResourcePath(location, sessionId, channel);
      if (resource) {
        const local = new URL(request.url);
        local.searchParams.set('resource', resource);
        headers.set('location', `${local.pathname}${local.search}`);
      }
    }
    return new Response(upstream.ok ? browserIceAnswer(body) : body, { status: upstream.status, headers });
  } catch (error) {
    const message = toErrorMessage(error);
    return fail(message.includes('fetch') || message.includes('connect') ? 'WHIP 媒体服务不可用，请确认 MediaMTX 已启动' : message, 502);
  }
}

export async function DELETE(request: Request) {
  try {
    const { sessionId, channel, resource } = requestParams(request);
    const auth = await authenticate(request, sessionId, channel);
    if (!auth.ok) return auth.response;
    const path = safeResourcePath(resource, sessionId, channel);
    if (!path) return fail('WHIP 资源地址无效或已过期', 400);
    const { token } = createMediaPublishToken(auth.session, channel as LiveChannel);
    const upstream = await fetch(`${mediaBase()}${path}?token=${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
        ...(request.headers.get('if-match') ? { 'if-match': request.headers.get('if-match')! } : {})
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000)
    });
    return new Response(await upstream.text(), { status: upstream.status, headers: upstreamHeaders(upstream) });
  } catch (error) {
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
