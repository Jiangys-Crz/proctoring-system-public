import { prisma } from './db';

const worker = globalThis as typeof globalThis & {
  pairingCleanupTimer?: ReturnType<typeof setInterval>;
  pairingCleanupBusy?: boolean;
};

/** Only abandoned QR codes are disposable. Keep codes used by login, recovery
 * or material uploads, and allow an extra five minutes for in-flight requests. */
export async function cleanupExpiredPairings(now = new Date()) {
  const cutoff = new Date(now.getTime() - 5 * 60_000);
  // One atomic statement rechecks every guard at deletion time. Both expiry
  // and the grant lookup have indexes; each transaction releases <=1000 codes.
  return prisma.$executeRaw`
    DELETE FROM PairingSession
    WHERE expiresAt < ${cutoff}
      AND claimedAt IS NULL AND loginRequestId IS NULL AND recoverySessionId IS NULL
      AND NOT EXISTS (SELECT 1 FROM MaterialUploadGrant WHERE pairingId = PairingSession.id)
    ORDER BY expiresAt LIMIT 1000
  `;
}

export function startPairingCleanup() {
  if (worker.pairingCleanupTimer) return;
  const run = async () => {
    if (worker.pairingCleanupBusy) return;
    worker.pairingCleanupBusy = true;
    try {
      for (let batch = 0; batch < 10; batch++) {
        if (await cleanupExpiredPairings() < 1000) break;
      }
    } catch (error) { console.error('Expired pairing cleanup failed', error); }
    finally { worker.pairingCleanupBusy = false; }
  };
  worker.pairingCleanupTimer = setInterval(() => void run(), 60_000);
  worker.pairingCleanupTimer.unref();
  void run();
}
