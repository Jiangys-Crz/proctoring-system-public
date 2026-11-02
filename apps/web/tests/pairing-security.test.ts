import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/lib/db';
import { consumeInitialPairingAttempt } from '../src/lib/pairing-limits';
import { POST } from '../src/app/api/client/pair/route';

test('initial pairing bounds device retries and random-ID buckets without grouping campus peers', async () => {
  const original = prisma.requestRateBucket.upsert;
  const now = Date.now;
  Date.now = () => 1_800_000_000_000;
  const counts = new Map<string, number>();
  prisma.requestRateBucket.upsert = (async ({ where }: { where: { id: string } }) => {
    const count = (counts.get(where.id) || 0) + 1;
    counts.set(where.id, count);
    return { count };
  }) as never;
  try {
    for (let attempt = 0; attempt < 10; attempt++) await consumeInitialPairingAttempt('repeated-device');
    await assert.rejects(consumeInitialPairingAttempt('repeated-device'), { status: 429 });
    await consumeInitialPairingAttempt('other-device-on-the-same-network');
    counts.clear();
    for (let index = 0; index < 6000; index++) await consumeInitialPairingAttempt(`random-device-${index}`);
    assert.equal(counts.size, 6001);
    for (let index = 0; index < 100; index++) await assert.rejects(consumeInitialPairingAttempt(`excess-${index}`), { status: 429 });
    assert.equal(counts.size, 6001, 'rejected random identities cannot allocate more persistent buckets');
  } finally { prisma.requestRateBucket.upsert = original; Date.now = now; }
});

test('public pairing rejects oversized JSON and exhausted budgets before creating any code', async () => {
  const original = prisma.requestRateBucket.upsert;
  const originalCreate = prisma.pairingSession.create;
  let created = 0;
  let counters = 0;
  prisma.pairingSession.create = (async () => { created++; throw new Error('must not create'); }) as never;
  prisma.requestRateBucket.upsert = (async () => { counters++; return { count: 6001 }; }) as never;
  const request = (body: object) => new Request('http://localhost/api/client/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await POST(request({ deviceId: 'fixture-desktop', hostname: 'x'.repeat(17_000) }))).status, 400);
    assert.equal(counters, 0);
    assert.equal((await POST(request({ deviceId: 'fixture-desktop' }))).status, 429);
    assert.equal((await POST(request({ deviceId: 'fixture-desktop', publicTest: true, screenOk: true, desktopCameraOk: true }))).status, 429);
    assert.equal(counters, 2);
    assert.equal(created, 0);
  } finally { prisma.requestRateBucket.upsert = original; prisma.pairingSession.create = originalCreate; }
});
