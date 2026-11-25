import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { digest, FederationError } from './exam-federation-protocol';

const context = new AsyncLocalStorage<{ token: string; settingsHash: string; lost: boolean }>();
/** Fencing happens inside the transaction that mutates data/checkpoints, not just in a timer. */
export async function assertPlatformLease(tx: Prisma.TransactionClient) {
  const lease = context.getStore();
  if (!lease) return; // Ordinary exam operations also use federationTransaction.
  if (lease.lost) throw new FederationError('同步租约已失效，等待重试', 503);
  await tx.$queryRaw`SELECT id FROM PlatformSyncState WHERE id = 'peer' FOR UPDATE`;
  const state = await tx.platformSyncState.findUnique({ where: { id: 'peer' } });
  const settings = await tx.systemSetting.findUnique({ where: { key: 'platformSync' } });
  if (state?.leaseToken !== lease.token || !state.leaseUntil || +state.leaseUntil <= Date.now() || digest(settings?.value ?? null) !== lease.settingsHash) {
    lease.lost = true;
    throw new FederationError('同步租约或设置已改变，等待重试', 503);
  }
}
export async function platformTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async tx => { await assertPlatformLease(tx); const result = await work(tx); await assertPlatformLease(tx); return result; }, { isolationLevel: 'ReadCommitted', timeout: 60_000 });
}
export async function withPlatformLease<T>(work: () => Promise<T>, expectedRevision?: string, waitMs = 0): Promise<T> {
  const active = context.getStore();
  if (active) {
    if (active.lost || (expectedRevision && expectedRevision !== active.settingsHash)) throw new FederationError('同步设置已改变，等待重试', 503);
    return work();
  }
  await prisma.platformSyncState.upsert({ where: { id: 'peer' }, create: { id: 'peer' }, update: {} });
  const token = randomUUID(), deadline = Date.now() + Math.max(0, Math.min(waitMs, 30_000));
  for (;;) {
    const now = new Date();
    const claimed = await prisma.platformSyncState.updateMany({ where: { id: 'peer', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + 90_000) } });
    if (claimed.count) break;
    if (Date.now() >= deadline) throw new FederationError('同步正在进行，请稍后重试', 503);
    // Manual imports wait for a background turn; they never steal or clear
    // another worker's live lease. Scheduled polling remains non-blocking.
    await sleep(Math.min(250, deadline - Date.now()));
  }
  let renew: ReturnType<typeof setInterval> | undefined;
  try {
    const settings = await prisma.systemSetting.findUnique({ where: { key: 'platformSync' } });
    const settingsHash = digest(settings?.value ?? null);
    if (expectedRevision && expectedRevision !== settingsHash) throw new FederationError('同步配置在任务启动前已改变，等待重试', 503);
    const lease = { token, settingsHash, lost: false };
    let renewing = false;
    renew = setInterval(() => {
      if (renewing || lease.lost) return;
      renewing = true;
      void prisma.platformSyncState.updateMany({ where: { id: 'peer', leaseToken: token, leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + 90_000) } })
        .then(result => { if (!result.count) lease.lost = true; }).catch(() => { lease.lost = true; })
        .finally(() => { renewing = false; });
    }, 20_000);
    renew.unref();
    return await context.run(lease, work);
  } finally {
    if (renew) clearInterval(renew);
    await prisma.platformSyncState.updateMany({ where: { id: 'peer', leaseToken: token }, data: { leaseToken: null, leaseUntil: null } });
  }
}
