import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PrismaClient } from '@prisma/client';

// This test exclusively owns its disposable database, including rate counters.
const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_security_qa');
const db = new PrismaClient();
(globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma = db;
const { consumeInitialPairingAttempt } = await import('../src/lib/pairing-limits');
const { cleanupExpiredPairings } = await import('../src/lib/pairing-cleanup');
const { createPairingSession } = await import('../src/lib/pairing-create');
const prefix = `pair-security-${randomUUID()}`;
const now = new Date();
const expired = new Date(now.getTime() - 600_000);
const pairIds: string[] = [];
let grantId = '';
const originalNow = Date.now;

try {
  const variants = [
    { label: 'abandoned', data: {} },
    { label: 'fresh', data: { expiresAt: new Date(now.getTime() + 300_000) } },
    { label: 'in-flight-grace', data: { expiresAt: new Date(now.getTime() - 60_000) } },
    { label: 'claimed', data: { claimedAt: now } },
    { label: 'recovery', data: { recoverySessionId: 'preserved-session' } },
    { label: 'upload', data: {} },
  ];
  for (const variant of variants) {
    const pair = await createPairingSession(db, { desktopDeviceId: prefix, expiresAt: expired, ...variant.data });
    pairIds.push(pair.id);
  }
  const grant = await db.materialUploadGrant.create({ data: {
    tokenHash: prefix, examId: prefix, candidateId: prefix, pairingId: pairIds[5], deviceId: prefix, expiresAt: expired,
  } });
  grantId = grant.id;
  assert.equal(await cleanupExpiredPairings(now), 1);
  assert.equal(await db.pairingSession.findUnique({ where: { id: pairIds[0] } }), null);
  assert.equal(await db.pairingSession.count({ where: { id: { in: pairIds.slice(1) } } }), 5);
  await db.materialUploadGrant.delete({ where: { id: grantId } });
  grantId = '';
  assert.equal(await cleanupExpiredPairings(now), 1, 'unused code is reusable once its material grant has been cleaned');

  // A shared hot counter receives all 6000 simultaneous attempts. Freeze only
  // its bucket clock so crossing a wall-clock minute cannot weaken assertions.
  await db.requestRateBucket.deleteMany();
  const bucketTime = Date.now();
  Date.now = () => bucketTime;
  const started = performance.now();
  const durations: number[] = [];
  const results = await Promise.allSettled(Array.from({ length: 6000 }, async (_, index) => {
    const start = performance.now();
    await consumeInitialPairingAttempt(`${prefix}-${index}`);
    durations.push(performance.now() - start);
  }));
  const elapsed = performance.now() - started;
  const failures = results.filter(result => result.status === 'rejected');
  assert.deepEqual(failures, [], 'all 6000 valid devices fit the shared budget');
  assert.equal(await db.requestRateBucket.count(), 6001);
  await assert.rejects(consumeInitialPairingAttempt(`${prefix}-excess`), { status: 429 });
  assert.equal(await db.requestRateBucket.count(), 6001);
  durations.sort((a, b) => a - b);
  console.log(JSON.stringify({ attempts: 6000, accepted: results.length - failures.length, elapsedMs: Math.round(elapsed),
    attemptsPerSecond: Math.round(6000 / (elapsed / 1000)), p95Ms: Math.round(durations[Math.floor(durations.length * 0.95)]),
    cleanupProtected: ['fresh', 'in-flight-grace', 'claimed', 'recovery', 'upload'] }));
} finally {
  Date.now = originalNow;
  if (grantId) await db.materialUploadGrant.deleteMany({ where: { id: grantId } });
  await db.pairingSession.deleteMany({ where: { id: { in: pairIds } } });
  await db.requestRateBucket.deleteMany();
  await db.$disconnect();
}
