import { stopSessionLiveMedia } from './session-live-media';
import { prisma } from './db';

const shared = globalThis as typeof globalThis & {
  terminalMediaJobs?: Map<string, Promise<void>>;
  retryDeletedSessionMedia?: Set<string>;
};
const pending = shared.terminalMediaJobs ??= new Map<string, Promise<void>>();
// Public test reset deletes session rows. Keep failed paths eligible for
// retry locally even after the database row no longer exists.
const retry = shared.retryDeletedSessionMedia ??= new Set<string>();
const batchSize = 200;
// A protocol handshake authorized just before finish may still be attaching
// to its MediaMTX path. Reconcile once more after its read timeout has passed.
const lateHandshakeWindowMs = 15_000;
const terminal = { OR: [{ status: 'FINISHED' as const }, { revokedAt: { not: null } }] };

/** Call after committing the final session state. A media service failure does
 * not roll it back and leaves unfinished cleanup eligible for the next scan. */
export async function stopTerminalSessionMedia(sessionIds: readonly string[], recheck = false) {
  const ids = [...new Set(sessionIds)];
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const fresh = batch.filter(id => !pending.has(id));
    if (fresh.length) {
      const work = (async () => {
        try {
          // Missing rows belong to deleted test sessions. A surviving row must
          // still be terminal before this operation can touch its media.
          const rows = await prisma.clientSession.findMany({
            where: { id: { in: fresh } },
            select: { id: true, status: true, revokedAt: true, liveMediaStoppedAt: true, liveMediaRechecked: true },
          });
          const skip = new Set(rows.filter(row => row.status !== 'FINISHED' && !row.revokedAt
            || (recheck ? row.liveMediaRechecked : Boolean(row.liveMediaStoppedAt))).map(row => row.id));
          for (const id of skip) retry.delete(id);
          const active = fresh.filter(id => !skip.has(id));
          if (!active.length) return;
          await stopSessionLiveMedia(active);
          await prisma.clientSession.updateMany({
            where: { ...terminal, id: { in: active }, liveMediaStoppedAt: recheck ? { not: null } : null },
            data: { liveMediaStoppedAt: new Date(), ...(recheck ? { liveMediaRechecked: true } : {}) },
          });
          active.forEach(id => retry.delete(id));
        } catch (error) {
          fresh.forEach(id => { if (retry.size < 2000) retry.add(id); });
          console.error('Failed to close finished monitoring streams', error);
        }
      })().finally(() => fresh.forEach(id => pending.delete(id)));
      fresh.forEach(id => pending.set(id, work));
    }
    await Promise.all(new Set(batch.map(id => pending.get(id))));
  }
}

export async function reconcileTerminalSessionMedia() {
  const initial = await prisma.clientSession.findMany({
    where: { ...terminal, liveMediaStoppedAt: null, syncImported: false },
    orderBy: [{ endedAt: 'desc' }, { id: 'asc' }], take: batchSize, select: { id: true },
  });
  await stopTerminalSessionMedia([...initial.map(row => row.id), ...[...retry].slice(0, batchSize)]);
  const recheck = await prisma.clientSession.findMany({
    where: { ...terminal, liveMediaRechecked: false, syncImported: false,
      liveMediaStoppedAt: { lt: new Date(Date.now() - lateHandshakeWindowMs) } },
    orderBy: [{ liveMediaStoppedAt: 'asc' }, { id: 'asc' }], take: batchSize, select: { id: true },
  });
  await stopTerminalSessionMedia(recheck.map(row => row.id), true);
}
