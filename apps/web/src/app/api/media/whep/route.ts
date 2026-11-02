import { AuthError, requireUser } from '@/lib/auth';
import { fail, options, toErrorMessage } from '@/lib/http';
import { authorizeMediaRead } from '@/lib/media-read-access';
import { createMediaReadToken, type LiveChannel } from '@/lib/media-read-token';
import { browserIceAnswer } from '@/lib/browser-ice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const channels = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'] as const;

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

function readPath(sessionId: string, channel: string) {
  return `/live/${encodeURIComponent(`${sessionId}_${channel}`)}/whep`;
}

function safeResourcePath(value: string, sessionId: string, channel: string) {
  if (!value) return '';
  try {
    const pathname = new URL(value, mediaBase()).pathname;
    return pathname.startsWith(`${readPath(sessionId, channel)}/`) ? pathname : '';
  } catch {
    return '';
  }
}

async function authorize(request: Request) {
  const { sessionId, channel, resource } = requestParams(request);
  if (!sessionId || !channels.includes(channel as (typeof channels)[number])) {
    return { ok: false as const, response: fail('直播参数不正确', 400) };
  }
  const user = await requireUser(request);
  await authorizeMediaRead(user, sessionId, channel, request.method === 'POST');
  return { ok: true as const, sessionId, channel, resource, token: createMediaReadToken(user.id, sessionId, channel as LiveChannel) };
}

function responseHeaders(upstream: Response) {
  const headers = new Headers();
  headers.set('cache-control', 'private, no-store');
  headers.set('content-type', upstream.headers.get('content-type') || 'application/sdp');
  const etag = upstream.headers.get('etag');
  if (etag) headers.set('etag', etag);
  return headers;
}

export async function POST(request: Request) {
  try {
    const auth = await authorize(request);
    if (!auth.ok) return auth.response;
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/sdp')) return fail('WHEP 请求体必须是 application/sdp', 415);
    const offer = await request.text();
    if (!offer.trim().startsWith('v=0')) return fail('WHEP SDP offer 无效', 400);

    const upstream = await fetch(`${mediaBase()}${readPath(auth.sessionId, auth.channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp', accept: 'application/sdp', authorization: `Bearer ${auth.token}` },
      body: offer,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000)
    });
    const headers = responseHeaders(upstream);
    const location = upstream.headers.get('location');
    if (upstream.ok && location) {
      const resource = safeResourcePath(location, auth.sessionId, auth.channel);
      if (resource) {
        const local = new URL(request.url);
        local.searchParams.set('resource', resource);
        headers.set('location', `${local.pathname}${local.search}`);
      }
    }
    const body = await upstream.text();
    return new Response(upstream.ok ? browserIceAnswer(body) : body, { status: upstream.status, headers });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await authorize(request);
    if (!auth.ok) return auth.response;
    const path = safeResourcePath(auth.resource, auth.sessionId, auth.channel);
    if (!path) return fail('WHEP 资源地址无效或已过期', 400);
    const upstream = await fetch(`${mediaBase()}${path}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${auth.token}`, ...(request.headers.get('if-match') ? { 'if-match': request.headers.get('if-match')! } : {}) },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000)
    });
    return new Response(upstream.status === 204 ? null : await upstream.text(), { status: upstream.status, headers: responseHeaders(upstream) });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await authorize(request);
    if (!auth.ok) return auth.response;
    const path = safeResourcePath(auth.resource, auth.sessionId, auth.channel);
    if (!path) return fail('WHEP 资源地址无效或已过期', 400);
    if (!request.headers.get('content-type')?.startsWith('application/trickle-ice-sdpfrag')) return fail('候选地址格式不正确', 415);
    const body = await request.text();
    if (body.length > 65536) return fail('候选地址请求过大', 413);
    const upstream = await fetch(`${mediaBase()}${path}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/trickle-ice-sdpfrag', 'if-match': '*' },
      body, cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    return new Response(upstream.status === 204 ? null : await upstream.text(), { status: upstream.status, headers: responseHeaders(upstream) });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
