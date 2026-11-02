import { prisma } from '@/lib/db';
import { objectHash } from '@/lib/file-deletion';
import { options } from '@/lib/http';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { getStorageSettings } from '@/lib/settings';
import { verifySignedLocalObjectUrl } from '@/lib/storage';

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

export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }) {
  const { key } = await context.params;
  const { searchParams } = new URL(request.url);
  const objectKey = key.join('/');
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
    const range = request.headers.get('range');
    let start = 0;
    let end = info.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}` } });
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else start = Math.max(0, info.size - Number(match[2]));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}` } });
      headers.set('content-range', `bytes ${start}-${end}/${info.size}`);
    }
    headers.set('content-length', String(Math.max(0, end - start + 1)));
    const body = info.size ? Readable.toWeb(createReadStream(fullPath, { start, end })) as ReadableStream<Uint8Array> : null;
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return new Response('Not found', { status: 404 });
    throw error;
  }
}

export const OPTIONS = options;
