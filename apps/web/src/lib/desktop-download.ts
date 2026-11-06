import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';

const state = globalThis as typeof globalThis & { desktopDownloads?: { active: number } };
const downloads = state.desktopDownloads ??= { active: 0 };

/** Stream with backpressure; HEAD/range probes never read a whole installer. */
export async function desktopDownload(request: Request, asset: { path: string; size: number; name: string; sha512?: string }, privateDownload = false) {
  if (request.signal.aborted) return new Response(null, { status: 408 });
  if (downloads.active >= 64) return new Response('Downloads busy', { status: 503, headers: { 'Retry-After': '2' } });
  downloads.active++;
  let handedOff = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(asset.path, 'r').catch(() => undefined);
    const info = await handle?.stat();
    if (!info?.isFile() || info.size !== asset.size || !Number.isSafeInteger(asset.size) || asset.size < 1) {
      return new Response('Release unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const etag = asset.sha512 ? `"${asset.sha512}"` : `"${asset.size}-${info.mtimeMs}"`;
    const headers = new Headers({
      'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: etag,
      'Content-Disposition': `attachment; filename="${asset.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': privateDownload ? 'private, no-store' : 'public, max-age=31536000, immutable',
    });
    if (!privateDownload && request.headers.get('if-none-match')?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
      return new Response(null, { status: 304, headers });
    }
    let start = 0, end = asset.size - 1, partial = false;
    // Range is defined for GET. A stale If-Range restarts with the full file.
    const ifRange = request.headers.get('if-range');
    const range = request.method === 'HEAD' || ifRange && ifRange !== etag ? null : request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const invalid = () => new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${asset.size}`, 'Accept-Ranges': 'bytes' } });
      if (!match || (!match[1] && !match[2])) return invalid();
      const first = match[1] ? Number(match[1]) : undefined;
      const last = match[2] ? Number(match[2]) : undefined;
      if (first !== undefined && !Number.isSafeInteger(first) || last !== undefined && !Number.isSafeInteger(last)) return invalid();
      if (first === undefined) { if (!last) return invalid(); start = Math.max(0, asset.size - last); }
      else { start = first; if (last !== undefined) end = Math.min(end, last); }
      if (start > end || start >= asset.size) return invalid();
      partial = true;
    }
    headers.set('Content-Length', String(end - start + 1));
    if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${asset.size}`);
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    const stream = handle!.createReadStream({ start, end, autoClose: true, highWaterMark: 64 * 1024 });
    const abort = () => stream.destroy();
    stream.once('close', () => { request.signal.removeEventListener('abort', abort); downloads.active--; });
    request.signal.addEventListener('abort', abort, { once: true });
    handedOff = true;
    if (request.signal.aborted) abort();
    // Count bytes, not chunks: otherwise a slow downloader can fill a Web
    // stream queue with thousands of 64 KiB chunks before backpressure applies.
    return new Response(Readable.toWeb(stream, { strategy: {
      highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength,
    } }) as ReadableStream<Uint8Array>, { status: partial ? 206 : 200, headers });
  } finally {
    if (!handedOff) { await handle?.close().catch(() => {}); downloads.active--; }
  }
}
