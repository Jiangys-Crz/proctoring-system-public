// Requires a disposable local database; never reads the application's .env URL.
// PERFORMANCE_TEST_DATABASE_URL=mysql://.../proctor_concurrency_qa tsx tests/heartbeat-performance-integration.ts
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

if (!process.env.PERFORMANCE_TEST_DATABASE_URL) throw new Error('Set PERFORMANCE_TEST_DATABASE_URL to a disposable test database');
const database = new URL(process.env.PERFORMANCE_TEST_DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/proctor_[a-z_]*qa(?:_[a-z_]+)?$/, 'requires an isolated QA database');
const db = new PrismaClient({ datasourceUrl: database.href, log: [{ level: 'query', emit: 'event' }] });
(globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma = db;
const { POST: heartbeat } = await import('../src/app/api/client/heartbeat/route');
const { hashClientSessionToken, publicClientSession } = await import('../src/lib/client-auth');
const { withSessionWrite } = await import('../src/lib/session-write');
const prefix = `heartbeat-perf-${randomUUID()}`;
const token = randomUUID(), tokenHash = hashClientSessionToken(token);
const baseline = `usb-v5:${'a'.repeat(64)}`;
let examId = '', queries: string[] = [];
db.$on('query', event => { queries.push(event.query); });
const request = (id: string, side: 'DESKTOP' | 'MINIPROGRAM' = 'DESKTOP', system: Record<string, unknown> = { peripheralScanOk: true, peripheralsFingerprint: baseline }) => new Request('http://localhost/api/client/heartbeat', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ sessionId: id, deviceId: id, side, capture: { screenOk: true, desktopCameraOk: true, mobileCameraOk: true }, system }),
});

try {
  const now = new Date(), startedAt = new Date(now.getTime() - 60_000);
  const exam = await db.exam.create({ data: {
    examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: prefix,
    startAt: startedAt, latestStartAt: new Date(now.getTime() + 3_600_000), endAt: new Date(now.getTime() + 7_200_000),
    durationMinutes: 120, platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: prefix,
    contestType: 'INDIVIDUAL', rules: 'Disposable heartbeat concurrency fixture',
    requireMiniProgram: true, requireFrontCamera: true, saveIncidentRecording: false,
  } });
  examId = exam.id;
  const candidates = Array.from({ length: 300 }, (_, index) => ({
    id: `${prefix}-${index}`, examId, examNumber: `${prefix}-${index}`, password: prefix,
    seatNo: String(index), startedAt, status: 'ONLINE_NORMAL' as const,
  }));
  await db.candidate.createMany({ data: candidates });
  const sessions = candidates.map(candidate => ({
    id: `${candidate.id}-session`, examId, candidateId: candidate.id, status: 'IN_EXAM' as const,
    desktopDeviceId: `${candidate.id}-session`, miniProgramDeviceId: `${candidate.id}-session`,
    desktopTokenHash: tokenHash, miniProgramTokenHash: tokenHash, approvedAt: startedAt, startedAt,
    lastDesktopSeenAt: now, lastMiniProgramSeenAt: now,
    peripheralsBaselineFingerprint: baseline, lastPeripheralsFingerprint: baseline,
  }));
  await db.clientSession.createMany({ data: sessions });

  // Read the persisted row after the response to verify that omitting the
  // redundant SQL read preserves every public scalar, including timestamps.
  queries = [];
  const warm = await heartbeat(request(sessions[0].id));
  assert.equal(warm.status, 200, await warm.clone().text());
  const warmData = (await warm.json()).data;
  const singleHeartbeatQueries = queries.length;
  const row = await db.clientSession.findUniqueOrThrow({ where: { id: sessions[0].id } });
  const { effectiveEndAt: _effectiveEndAt, ...returnedRow } = warmData.session;
  assert.deepEqual(returnedRow, JSON.parse(JSON.stringify(publicClientSession(row))));
  for (const forbidden of ['candidate', 'exam', 'desktopTokenHash', 'miniProgramTokenHash', 'monitoringAlertState']) {
    assert.equal(forbidden in returnedRow, false);
  }

  // Compare MySQL's actual query count for the old returned-row mutation and
  // the write-only mutation while using the same session write lock.
  const mutationCounts = {} as Record<string, number>;
  for (const mode of ['returnedRow', 'writeOnly']) {
    queries = [];
    await withSessionWrite(sessions[0].id, async tx => {
      const args = { where: { id: sessions[0].id }, data: { lastDesktopSeenAt: new Date() } };
      if (mode === 'returnedRow') await tx.clientSession.update(args);
      else await tx.clientSession.updateMany(args);
    });
    mutationCounts[mode] = queries.length;
  }
  assert.ok(mutationCounts.writeOnly < mutationCounts.returnedRow);

  queries = [];
  const began = performance.now();
  const latencies = await Promise.all(sessions.flatMap(session => (['DESKTOP', 'MINIPROGRAM'] as const).map(async side => {
    const start = performance.now();
    const response = await heartbeat(request(session.id, side));
    assert.equal(response.status, 200, await response.clone().text());
    const data = (await response.json()).data;
    assert.equal(data.session.status, 'IN_EXAM');
    assert.equal(data.alertsCreated, 0);
    return performance.now() - start;
  })));
  const durationMs = Math.round(performance.now() - began), loadQueries = queries.length;
  latencies.sort((a, b) => a - b);
  assert.equal(await db.alert.count({ where: { examId } }), 0);
  assert.equal(await db.clientSession.count({ where: { examId, lastDesktopSeenAt: { gt: now }, lastMiniProgramSeenAt: { gt: now }, status: 'IN_EXAM' } }), sessions.length);
  console.log(JSON.stringify({ scenario: '300 candidates / 600 simultaneous desktop and phone heartbeats',
    connectionLimit: database.searchParams.get('connection_limit'), durationMs,
    p95Ms: Math.round(latencies[Math.ceil(latencies.length * 0.95) - 1]),
    requestsPerSecond: Math.round(latencies.length * 1000 / durationMs),
    totalQueries: loadQueries, singleHeartbeatQueries, mutationQueries: mutationCounts,
  }));

  // A slow or duplicated request for one candidate must not occupy the whole
  // pool with row-lock waiters. Keep one request deliberately pending while a
  // different candidate completes, then drain every queued request.
  if (Number(database.searchParams.get('connection_limit') || 8) > 1) {
    let unlock!: () => void, started!: () => void;
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = withSessionWrite(sessions[0].id, async () => { started(); await released; });
    await entered;
    const burst = Array.from({ length: 100 }, () => heartbeat(request(sessions[0].id)));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const unaffected = await Promise.race([
        heartbeat(request(sessions[1].id)),
        new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('unrelated candidate blocked by session lock waiters')), 2000); }),
      ]);
      assert.equal(unaffected.status, 200);
    } finally { if (watchdog) clearTimeout(watchdog); unlock(); }
    await held;
    assert.ok((await Promise.all(burst)).every(response => response.status === 200));
    console.log('PASS: 100 requests queued on one held session do not block another candidate.');
  }

  // Persistent scanner failures create one episode under real concurrent DB
  // writes; successful scans must leave the proctor-controlled lock in place.
  const failures = await Promise.all(Array.from({ length: 30 }, () => heartbeat(request(sessions[0].id, 'DESKTOP', { peripheralScanOk: false, peripheralsFingerprint: 'stale-value' }))));
  assert.ok(failures.every(response => response.status === 200));
  assert.equal(await db.alert.count({ where: { sessionId: sessions[0].id, type: 'PERIPHERAL_CHANGED' } }), 1);
  const failedRow = await db.clientSession.findUniqueOrThrow({ where: { id: sessions[0].id } });
  assert.equal(failedRow.lockdown, true);
  assert.equal(failedRow.lastPeripheralsFingerprint, baseline);
  const recovered = await heartbeat(request(sessions[0].id));
  assert.equal((await recovered.json()).data.session.lockdown, true);
  console.log('PASS: exact public response, both-side clocks, one USB failure episode, stale fingerprint rejection, persistent proctor lock.');
} finally {
  if (examId) await db.exam.delete({ where: { id: examId } });
  await db.$disconnect();
}
