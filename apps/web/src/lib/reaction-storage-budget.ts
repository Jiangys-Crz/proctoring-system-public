import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from './db';
import { reactionChannels } from './reaction-domain';
import { getStorageSettings } from './settings';
import { withS3Client } from './s3-client-pool';

/** Call under the exam row lock when admitting a new upload or output. */
export async function reactionStoredBytes(tx: Prisma.TransactionClient, examId: string): Promise<bigint> {
  const [raw, generated] = await Promise.all([
    tx.mediaSegment.aggregate({ where: { examId, deletedAt: null, channel: { in: [...reactionChannels] } }, _sum: { byteSize: true } }),
    tx.reaction.aggregate({ where: { examId }, _sum: { outputBytes: true, reservedBytes: true } }),
  ]);
  return BigInt(raw._sum.byteSize || 0) + (generated._sum.outputBytes || 0n) + (generated._sum.reservedBytes || 0n);
}

/** Reserve before uploading materialized output; existing results still count. */
export async function reserveReactionOutput(reactionId: string, bytes: bigint): Promise<void> {
  if (bytes < 0n) throw new Error('REACTION_STORAGE_SIZE_INVALID');
  if (bytes === 0n) return;
  const owner = await prisma.reaction.findUniqueOrThrow({ where: { id: reactionId }, select: { examId: true } });
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${owner.examId} FOR UPDATE`;
    const record = await tx.reaction.findUniqueOrThrow({ where: { id: reactionId } });
    if (!['CAPTURING', 'COMPLETE', 'PARTIAL'].includes(record.status)) throw new Error('REACTION_JOB_CANCELLED');
    const config = await tx.reactionConfig.findUnique({ where: { examId: owner.examId } });
    if (!config) throw new Error('REACTION_JOB_CANCELLED');
    if (await reactionStoredBytes(tx, owner.examId) + bytes > config.maxStorageBytes) throw new Error('REACTION_STORAGE_LIMIT');
    await tx.reaction.update({ where: { id: reactionId }, data: { reservedBytes: { increment: bytes } } });
  }, { isolationLevel: 'ReadCommitted', timeout: 15000 });
}

/** Only release this attempt's reservation. A newer worker may own the row. */
export async function releaseReactionOutput(reactionId: string, bytes: bigint): Promise<void> {
  if (bytes <= 0n) return;
  const owner = await prisma.reaction.findUnique({ where: { id: reactionId }, select: { examId: true } });
  if (!owner) return;
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${owner.examId} FOR UPDATE`;
    await tx.reaction.updateMany({ where: { id: reactionId, reservedBytes: { gte: bytes } }, data: { reservedBytes: { decrement: bytes } } });
  }, { isolationLevel: 'ReadCommitted', timeout: 15000 });
}

/** Used only for a replaced old MP4, not an O(n) remote scan on every tick. */
export async function reactionObjectBytes(key: string): Promise<bigint> {
  if (!key || key.includes('\\') || key.includes(':') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('INVALID_STORAGE_KEY');
  const settings = await getStorageSettings();
  if (settings.provider === 'S3') {
    const object = await withS3Client(settings, client => client.send(new HeadObjectCommand({ Bucket: settings.s3.bucket, Key: key }), { abortSignal: AbortSignal.timeout(15000) }));
    if (!Number.isSafeInteger(object.ContentLength) || object.ContentLength! < 0) throw new Error('REACTION_STORAGE_SIZE_INVALID');
    return BigInt(object.ContentLength!);
  }
  const root = await realpath(path.resolve(settings.localUploadDir));
  const file = await realpath(path.join(root, key));
  if (!file.startsWith(root + path.sep)) throw new Error('INVALID_STORAGE_KEY');
  const info = await stat(file, { bigint: true });
  if (!info.isFile()) throw new Error('REACTION_STORAGE_SIZE_INVALID');
  return info.size;
}
