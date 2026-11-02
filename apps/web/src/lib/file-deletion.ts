import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { deleteStoredObject } from './storage';
import { StorageSettingsSchema, type StorageSettings } from './settings';

export const objectHash = (key: string) => createHash('sha256').update(key).digest('hex');
export function deletionStorage(settings: StorageSettings): Prisma.InputJsonValue {
  return { ...settings, localUploadDir: path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir) };
}
export function fileDeletionId(kind: string, key: string, storage: Prisma.InputJsonValue) {
  const settings = StorageSettingsSchema.parse(storage);
  const destination = settings.provider === 'LOCAL' ? settings.localUploadDir : `${settings.s3.endpoint || ''}:${settings.s3.bucket}`;
  return objectHash(`${kind}:${settings.provider}:${destination}:${key}`);
}
export async function queueFileDeletion(tx: Prisma.TransactionClient, data: {
  kind: 'MEDIA' | 'INSTALLER'; examId?: string; objectPath: string; storage: Prisma.InputJsonValue; requestedById: string;
}, reactivate = false) {
  const id = fileDeletionId(data.kind, data.objectPath, data.storage);
  await tx.fileDeletionJob.upsert({ where: { id }, create: { ...data, id, objectHash: objectHash(data.objectPath) }, update: reactivate ? { completedAt: null, claimUntil: null, lastError: null, nextAttemptAt: new Date(), storage: data.storage } : {} });
}
export async function mediaHasReferences(tx: Prisma.TransactionClient, key: string) {
  return Boolean(await tx.mediaSegment.count({ where: { objectPath: key, deletedAt: null } })
    || await tx.alert.count({ where: { evidencePath: key, evidenceDeletedAt: null } })
    || await tx.loginRequest.count({ where: { OR: [{ identityPhotoPath: key }, { roomVideoPath: key }] } })
    || await tx.voiceMessage.count({ where: { objectPath: key } })
    || await tx.liveFrame.count({ where: { objectPath: key } })
    || await tx.screenControlImage.count({ where: { objectPath: key } }));
}

/** DB state and outbox commit together; physical deletion is idempotent and retried.
 * No filesystem operation occurs in a business transaction that might roll back.
 */
export async function processFileDeletions(filter: Prisma.FileDeletionJobWhereInput = {}, limit = 20) {
  const now = new Date();
  const jobs = await prisma.fileDeletionJob.findMany({ where: {
    AND: [filter, { completedAt: null, nextAttemptAt: { lte: now }, OR: [{ claimUntil: null }, { claimUntil: { lt: now } }] }]
  }, orderBy: { createdAt: 'asc' }, take: limit });
  for (const job of jobs) {
    const claimUntil = new Date(Date.now() + 60_000);
    const claimed = await prisma.fileDeletionJob.updateMany({ where: { id: job.id, completedAt: null,
      OR: [{ claimUntil: null }, { claimUntil: { lt: now } }] }, data: { claimUntil, attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    try {
      if (job.kind === 'MEDIA' && await mediaHasReferences(prisma, job.objectPath)) throw new Error('文件仍被其他记录引用，等待后续清理');
      await deleteStoredObject(job.objectPath, StorageSettingsSchema.parse(job.storage));
      await prisma.fileDeletionJob.updateMany({ where: { id: job.id, claimUntil }, data: {
        completedAt: new Date(), claimUntil: null, lastError: null
      } });
    } catch (error) {
      await prisma.fileDeletionJob.updateMany({ where: { id: job.id, claimUntil }, data: {
        claimUntil: null, lastError: (error instanceof Error ? error.message : '文件清理失败').slice(0, 2000),
        nextAttemptAt: new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(job.attempts, 7)))
      } });
    }
  }
  return jobs.length;
}
const state = globalThis as typeof globalThis & { deletionTimer?: ReturnType<typeof setInterval>; deletionBusy?: boolean };
export function startFileDeletionWorker() {
  if (state.deletionTimer) return;
  const run = async () => {
    if (state.deletionBusy) return;
    state.deletionBusy = true;
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && await processFileDeletions() === 20) { /* drain ready batches within the worker time budget */ }
    }
    catch (error) { console.error('File deletion worker failed', error); }
    finally { state.deletionBusy = false; }
  };
  state.deletionTimer = setInterval(() => void run(), 30_000);
  state.deletionTimer.unref();
  void run();
}
