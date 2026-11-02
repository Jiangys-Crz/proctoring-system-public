import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
export async function desktopDownload(request: Request, asset: { path: string; size: number; name: string }, privateDownload = false) {
  const info = await stat(asset.path).catch(() => null);
  if (!info?.isFile() || info.size !== asset.size) return new Response('Release unavailable', { status: 503 });
  let start = 0, end = asset.size - 1, partial = false;
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${asset.size}` } });
    if (!match[1]) start = Math.max(0, asset.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= asset.size || (match[2] && !match[1] && Number(match[2]) === 0)) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${asset.size}` } });
    partial = true;
  }
  const stream = createReadStream(asset.path, { start, end });
  request.signal.addEventListener('abort', () => stream.destroy(), { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: partial ? 206 : 200,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${asset.name}"`, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': privateDownload ? 'private, no-store' : 'public, max-age=31536000, immutable', ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${asset.size}` } : {}) },
  });
}
