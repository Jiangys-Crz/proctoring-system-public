import { prisma } from '@/lib/db';
import { objectHash } from '@/lib/file-deletion';
import { options } from '@/lib/http';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { getStorageSettings } from '@/lib/settings';
import { verifySignedLocalObjectUrl } from '@/lib/storage';
import { nodeReadableBody } from '@/lib/node-readable-body';
import { createRequestAdmission, isRequestAdmissionError } from '@/lib/request-admission';
import { holdAttachment } from '@/lib/attachment-admission';

const shared = globalThis as typeof globalThis & {
  mediaFileImageAdmission?: ReturnType<typeof createRequestAdmission>;
  mediaFileAdmission?: ReturnType<typeof createRequestAdmission>;
};
const acquireImage = shared.mediaFileImageAdmission ??= createRequestAdmission(8, 128, 3000);
const acquireMedia = shared.mediaFileAdmission ??= createRequestAdmission(4, 64, 3000);

function contentType(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.webm') && lower.includes('voice')) return 'audio/webm';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

async function downloadFile(request: Request, key: string[]) {
  const { searchParams } = new URL(request.url);
  const objectKey = key.join('/');
  if (key[0] === 'reactions') return new Response('Use the authenticated Reaction download endpoint', {status:403});
  if (!verifySignedLocalObjectUrl(objectKey, searchParams.get('exp'), searchParams.get('sig'))) {
    return new Response('Forbidden', { status: 403 });
  }
  if (await prisma.fileDeletionJob.findFirst({ where: { kind: 'MEDIA', objectHash: objectHash(objectKey) }, select: { id: true } })) return new Response('Not found', { status: 404 });
  const settings = await getStorageSettings();
  const root = path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads');
  try {
    const fullPath = await realpath(path.resolve(root, ...key));
    const realRoot = await realpath(root);
    if (!fullPath.startsWith(`${realRoot}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    const info = await stat(fullPath);
    if (!info.isFile()) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'content-type': contentType(key[key.length - 1] || ''),
      'cache-control': 'private, max-age=60',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff'
    });
    const range = request.method === 'HEAD' ? null : request.headers.get('range');
    let start = 0;
    let end = info.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}` } });
      if ((match[1] && !Number.isSafeInteger(Number(match[1]))) || (match[2] && !Number.isSafeInteger(Number(match[2])))) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}` } });
      }
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else start = Math.max(0, info.size - Number(match[2]));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}` } });
      headers.set('content-range', `bytes ${start}-${end}/${info.size}`);
    }
    headers.set('content-length', String(Math.max(0, end - start + 1)));
    if (request.method === 'HEAD') return new Response(null, { headers });
    const body = info.size ? nodeReadableBody(createReadStream(fullPath, { start, end, highWaterMark: 64 * 1024, signal: request.signal })) : null;
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return new Response('Not found', { status: 404 });
    throw error;
  }
}

export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }) {
  let release: (() => void) | undefined;
  try {
    const { key } = await context.params;
    const image = contentType(key.at(-1) || '').startsWith('image/');
    release = await (image ? acquireImage : acquireMedia)(request.signal);
    if (request.signal.aborted) return new Response(null, { status: 408 });
    const response = await downloadFile(request, key);
    if (!response.ok || !response.body) return response;
    const streamed = holdAttachment(response, request.signal, release, image ? 60_000 : 5 * 60_000);
    release = undefined;
    return streamed;
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    return new Response('Downloads busy', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' } });
  } finally { release?.(); }
}

export async function HEAD(request: Request, context: { params: Promise<{ key: string[] }> }) { return GET(request, context); }
export const OPTIONS = options;
