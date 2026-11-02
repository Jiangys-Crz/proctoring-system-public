import { prisma } from './db';
import { deleteStoredObject } from './storage';

const UNUSED_MATERIAL_GRACE_MS = 24 * 60 * 60_000;
const worker = globalThis as typeof globalThis & {
  materialCleanupTimer?: ReturnType<typeof setInterval>;
  materialCleanupBusy?: boolean;
};

/** Expired, never-submitted login material is disposable. Exam footage is not. */
export async function cleanupUnusedLoginMaterials(now = new Date()) {
  const cutoff = new Date(now.getTime() - UNUSED_MATERIAL_GRACE_MS);
  let removed = 0;
  let after: { id: string; expiresAt: Date } | undefined;
  const failures: unknown[] = [];
  for (;;) {
    const grants = await prisma.materialUploadGrant.findMany({
      where: { consumedAt: null, loginRequestId: null, expiresAt: { lt: cutoff }, ...(after ? { OR: [
        { expiresAt: { gt: after.expiresAt } }, { expiresAt: after.expiresAt, id: { gt: after.id } }
      ] } : {}) },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: 100
    });
    if (!grants.length) break;
    after = grants.at(-1)!;
    for (const observed of grants) {
      try {
        removed += await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM MaterialUploadGrant WHERE id = ${observed.id} FOR UPDATE`;
          const grant = await tx.materialUploadGrant.findUnique({ where: { id: observed.id } });
          if (!grant || grant.consumedAt || grant.loginRequestId || grant.expiresAt >= cutoff) return 0;
          const segments = await tx.mediaSegment.findMany({ where: {
            uploadGrantId: grant.id, sessionId: null, channel: { in: ['IDENTITY_PHOTO', 'ROOM_VIDEO'] }
          } });
          let count = 0;
          for (const segment of segments) {
            // Also protect legacy references that predate upload-grant consumption.
            if (await tx.loginRequest.count({ where: { OR: [
              { identityPhotoPath: segment.objectPath }, { roomVideoPath: segment.objectPath }
            ] } })) continue;
            if (await tx.mediaSegment.count({ where: { objectPath: segment.objectPath, id: { not: segment.id } } })) continue;
            if (await tx.alert.count({ where: { evidencePath: segment.objectPath } })) continue;
            await deleteStoredObject(segment.objectPath);
            await tx.mediaSegment.delete({ where: { id: segment.id } });
            count++;
          }
          if (!await tx.mediaSegment.count({ where: { uploadGrantId: grant.id } })) {
            await tx.materialUploadGrant.delete({ where: { id: grant.id } });
          }
          return count;
        }, { isolationLevel: 'ReadCommitted', timeout: 60_000 });
      } catch (error) { failures.push(error); }
    }
    if (grants.length < 100) break;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, '部分未使用登录材料清理失败，将在下次重试');
  return removed;
}

export function startMaterialCleanup() {
  if (worker.materialCleanupTimer) return;
  const run = async () => {
    if (worker.materialCleanupBusy) return;
    worker.materialCleanupBusy = true;
    try { await cleanupUnusedLoginMaterials(); }
    catch (error) { console.error('Unused login material cleanup failed', error); }
    finally { worker.materialCleanupBusy = false; }
  };
  worker.materialCleanupTimer = setInterval(() => void run(), 60 * 60_000);
  worker.materialCleanupTimer.unref();
  void run();
}
