import { prisma } from './db';

const worker = globalThis as typeof globalThis & {
  rateLimitCleanupTimer?: ReturnType<typeof setInterval>;
  rateLimitCleanupBusy?: boolean;
};

/** Keep authentication/upload counters bounded without adding work to requests. */
export async function cleanupExpiredRateBuckets(now = new Date()) {
  const rows = await prisma.requestRateBucket.findMany({
    where: { expiresAt: { lt: now } }, orderBy: { expiresAt: 'asc' },
    select: { id: true }, take: 1000,
  });
  if (!rows.length) return 0;
  // Recheck expiry so a concurrently renewed row is never removed.
  return (await prisma.requestRateBucket.deleteMany({
    where: { id: { in: rows.map(row => row.id) }, expiresAt: { lt: now } },
  })).count;
}

export function startRateLimitCleanup() {
  if (worker.rateLimitCleanupTimer) return;
  const run = async () => {
    if (worker.rateLimitCleanupBusy) return;
    worker.rateLimitCleanupBusy = true;
    try {
      // Drain bursts from thousands of concurrent sessions while keeping each
      // transaction small and each worker turn capped at ten batches.
      for (let batch = 0; batch < 10; batch++) {
        if (await cleanupExpiredRateBuckets() < 1000) break;
      }
    }
    catch (error) { console.error('Expired rate limit cleanup failed', error); }
    finally { worker.rateLimitCleanupBusy = false; }
  };
  worker.rateLimitCleanupTimer = setInterval(() => void run(), 60_000);
  worker.rateLimitCleanupTimer.unref();
  void run();
}
