import path from 'node:path';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '@/lib/db';
import { options } from '@/lib/http';
import { getStorageSettings } from '@/lib/settings';
import { withS3Client } from '@/lib/s3-client-pool';
import { isReactionSubmissionId } from '@/lib/reaction-submission-id';
import { reactionRouteError, requireReactionAdmin } from '../../../_shared';

const fileFields = { camera: 'cameraPath', desktop: 'desktopPath', reaction: 'reactionPath', metadata: 'metadataPath' } as const;
type FileKind = keyof typeof fileFields;

/** Support single byte ranges without loading a video into application memory. */
function byteRange(header: string | null, size: number) {
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { start, end };
}

export async function GET(request: Request, context: { params: Promise<{ id: string; reactionId: string; kind: string }> }) {
  try {
    const { id, reactionId, kind } = await context.params;
    await requireReactionAdmin(id);
    if (!Object.prototype.hasOwnProperty.call(fileFields, kind)) return new Response('Not found', { status: 404 });
    const item = await prisma.reaction.findFirst({ where: { id: reactionId, examId: id } });
    if (!item || item.status === 'EXPIRED') return new Response('Not found', { status: 404 });
    const objectPath = item[fileFields[kind as FileKind]];
    if (!objectPath) return new Response('Not found', { status: 404 });
    // The database chooses the object. A URL can never supply a storage key.
    if (!objectPath.startsWith('reactions/') || objectPath.includes('\\') || objectPath.includes('\0') || objectPath.split('/').some(part => !part || part === '.' || part === '..')) return new Response('Forbidden', { status: 403 });
    const settings = await getStorageSettings();
    let size: number;
    let localPath: string | undefined;
    if (settings.provider === 'S3') {
      if (!settings.s3.bucket || !settings.s3.accessKeyId || !settings.s3.secretAccessKey) return new Response('Storage unavailable', { status: 503 });
      const info = await withS3Client(settings, client => client.send(new HeadObjectCommand({ Bucket: settings.s3.bucket, Key: objectPath }), { abortSignal: request.signal }));
      size = Number(info.ContentLength);
    } else {
      const root = await realpath(path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads'));
      localPath = await realpath(path.join(root, objectPath));
      if (!localPath.startsWith(`${root}${path.sep}`)) return new Response('Forbidden', { status: 403 });
      const info = await stat(localPath);
      if (!info.isFile()) return new Response('Not found', { status: 404 });
      size = info.size;
    }
    if (!Number.isSafeInteger(size) || size < 0) return new Response('Invalid object', { status: 502 });
    const requestedRange = request.headers.get('range');
    const range = byteRange(requestedRange, size);
    if (!range) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'cache-control': 'private, no-store' } });
    const download = new URL(request.url).searchParams.get('download') === '1';
    const filename = kind === 'reaction' && isReactionSubmissionId(item.submissionId) ? `${item.submissionId}.mp4` : `${kind}.${kind === 'metadata' ? 'json' : 'mp4'}`;
    const headers = new Headers({
      'content-type': kind === 'metadata' ? 'application/json; charset=utf-8' : 'video/mp4',
      'content-length': String(Math.max(0, range.end - range.start + 1)),
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      'cache-control': 'private, no-store', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff',
    });
    if (requestedRange) headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
    let body: ReadableStream<Uint8Array> | null = null;
    if (size) {
      if (localPath) body = Readable.toWeb(createReadStream(localPath, { start: range.start, end: range.end, signal: request.signal })) as ReadableStream<Uint8Array>;
      else {
        const result = await withS3Client(settings, client => client.send(new GetObjectCommand({ Bucket: settings.s3.bucket, Key: objectPath, Range: `bytes=${range.start}-${range.end}` }), { abortSignal: request.signal }));
        if (!result.Body) return new Response('Not found', { status: 404 });
        body = result.Body.transformToWebStream();
      }
    }
    return new Response(body, { status: requestedRange ? 206 : 200, headers });
  } catch (error) {
    if (error && typeof error === 'object' && ('code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code)) || '$metadata' in error && (error.$metadata as { httpStatusCode?: number })?.httpStatusCode === 404)) return new Response('Not found', { status: 404 });
    return reactionRouteError(error);
  }
}

export const OPTIONS = options;
