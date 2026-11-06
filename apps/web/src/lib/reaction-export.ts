import path from 'node:path';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { getStorageSettings, type StorageSettings } from './settings';
import { withS3Client } from './s3-client-pool';
import { UploadSecurityError } from './upload-security';
import type { ReactionZipEntry } from './reaction-export-zip';
import { isReactionSubmissionId } from './reaction-submission-id';

export function reactionExportWhere(examId: string): Prisma.ReactionWhereInput {
  return { examId, status: { in: ['COMPLETE', 'PARTIAL'] }, generationStatus: 'COMPLETE', reactionPath: { not: null }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
}

export async function getReactionExportSummary(examId: string) {
  const where = reactionExportWhere(examId);
  const rows = await prisma.reaction.findMany({ where, select: { submissionId: true } });
  return { generatedCount: rows.length, invalidSubmissionIds: rows.filter(row => !isReactionSubmissionId(row.submissionId)).length };
}

/** A GetObject send resolves at headers; hold the pooled client until its body
 * finishes too, so credential/destination churn cannot evict a live download. */
export function openReactionExportS3Object(settings: StorageSettings, key: string, signal: AbortSignal): Promise<Readable> {
  return new Promise((resolve, reject) => {
    void withS3Client(settings, async client => {
      signal.throwIfAborted();
      const result = await client.send(new GetObjectCommand({ Bucket: settings.s3.bucket, Key: key }), { abortSignal: signal });
      const body = result.Body;
      if (!(body instanceof Readable)) throw new Error('Invalid body');
      await new Promise<void>(release => {
        let released = false;
        const done = () => {
          if (released) return;
          released = true;
          signal.removeEventListener('abort', abort);
          body.removeListener('end', done);
          body.removeListener('close', done);
          // Keep a harmless error listener until close: the caller may not
          // have attached yet when abort happens just after the headers.
          release();
        };
        const abort = () => body.destroy(new Error('Reaction export cancelled'));
        body.once('end', done);
        body.once('close', done);
        body.on('error', done);
        body.once('close', () => body.removeListener('error', done));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); reject(new Error('Reaction export cancelled')); }
        else resolve(body);
        if (body.destroyed || body.readableEnded) done();
      });
    }).catch(() => reject(new Error('Reaction export source could not be read')));
  });
}

/** Check every generated video in this exam, independent of UI pagination. */
export async function prepareReactionExport(examId: string, signal: AbortSignal): Promise<ReactionZipEntry[]> {
  const rows = await prisma.reaction.findMany({ where: reactionExportWhere(examId), select: { submissionId: true, reactionPath: true, updatedAt: true }, orderBy: { submissionId: 'asc' } });
  if (!rows.length) throw new UploadSecurityError('暂无已生成的竖屏视频，请先生成视频', 409);
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isReactionSubmissionId(row.submissionId)) throw new UploadSecurityError('部分视频的 Submission UUID 无效，请检查原始提交记录', 409);
    if (seen.has(row.submissionId.toLowerCase())) throw new UploadSecurityError('Submission UUID 重复，无法安全导出', 409);
    seen.add(row.submissionId.toLowerCase());
    const key = row.reactionPath!;
    if (!key.startsWith('reactions/') || key.includes('\\') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new UploadSecurityError('录像存储路径无效', 409);
  }
  const settings = await getStorageSettings();
  if (settings.provider === 'S3' && (!settings.s3.bucket || !settings.s3.accessKeyId || !settings.s3.secretAccessKey)) throw new UploadSecurityError('录像存储未配置', 503);
  try {
    const root = settings.provider === 'S3' ? null : await realpath(path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads'));
    const entries: ReactionZipEntry[] = [];
    // Bound HEAD/stat concurrency without opening video streams during preflight.
    for (let i = 0; i < rows.length; i += 8) {
      signal.throwIfAborted();
      entries.push(...await Promise.all(rows.slice(i, i + 8).map(async row => {
        const key = row.reactionPath!;
        let size: number;
        let local: string | null = null;
        if (root) {
          local = await realpath(path.join(root, key));
          const relative = path.relative(root, local);
          if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Invalid path');
          const info = await stat(local);
          if (!info.isFile()) throw new Error('Not a file');
          size = info.size;
        } else {
          const info = await withS3Client(settings, client => client.send(new HeadObjectCommand({ Bucket: settings.s3.bucket, Key: key }), { abortSignal: signal }));
          size = Number(info.ContentLength);
        }
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid size');
        return { submissionId: row.submissionId, size, modifiedAt: row.updatedAt, open: async (abortSignal: AbortSignal) => {
          if (local) return createReadStream(local, { signal: abortSignal });
          return openReactionExportS3Object(settings, key, abortSignal);
        } };
      })));
    }
    return entries;
  } catch {
    throw new UploadSecurityError('部分竖屏文件缺失或存储暂不可用，导出未开始，请重新生成或检查存储', 409);
  }
}
