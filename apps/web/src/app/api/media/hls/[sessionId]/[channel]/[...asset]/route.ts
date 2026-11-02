import { AuthError, requireUser } from '@/lib/auth';
import { authorizeMediaRead } from '@/lib/media-read-access';
import { createMediaReadToken, mediaStreamPath, rewriteHlsPlaylist, type LiveChannel } from '@/lib/media-read-token';
import { fail, toErrorMessage } from '@/lib/http';
import { copyHlsQuery, fetchHlsAsset } from '@/lib/media-hls-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ sessionId: string; channel: string; asset: string[] }> }) {
  try {
    const user = await requireUser();
    const { sessionId, channel, asset } = await context.params;
    await authorizeMediaRead(user, sessionId, channel);
    // Never proxy another stream, arbitrary upstream host, or an encoded traversal.
    if (!asset.length || asset.some((part) => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) || part.includes('..'))) return fail('直播资源地址无效', 400);
    const streamPath = mediaStreamPath(sessionId, channel);
    const base = (process.env.MEDIA_HLS_INTERNAL_BASE || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    const target = new URL(`${base}${streamPath}/${asset.map(encodeURIComponent).join('/')}`);
    const incoming = new URL(request.url);
    copyHlsQuery(incoming, target);
    const token = createMediaReadToken(user.id, sessionId, channel as LiveChannel);
    const headers = new Headers({ authorization: `Bearer ${token}` });
    const range = request.headers.get('range');
    if (range) headers.set('range', range);
    const { response: upstream, url: upstreamUrl } = await fetchHlsAsset(target, streamPath, headers, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
    const responseHeaders = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    for (const key of ['content-type', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(key);
      if (value) responseHeaders.set(key, value);
    }
    if (!upstream.ok) return new Response(null, { status: upstream.status, headers: responseHeaders });
    if (asset.at(-1)?.endsWith('.m3u8')) {
      const prefix = `/api/media/hls/${encodeURIComponent(sessionId)}/${encodeURIComponent(channel)}`;
      responseHeaders.set('content-type', 'application/vnd.apple.mpegurl');
      return new Response(rewriteHlsPlaylist(await upstream.text(), upstreamUrl, prefix, streamPath), { headers: responseHeaders });
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}
