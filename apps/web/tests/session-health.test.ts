import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { staleHeartbeatSides, markStaleSessionsOffline } from '../src/lib/session-health';
import { prisma } from '../src/lib/db';

const cutoff = new Date('2026-09-26T06:00:20.000Z');
const old = new Date('2026-09-26T06:00:00.000Z');
const fresh = new Date('2026-09-26T06:00:21.000Z');

test('desktop and second-camera heartbeat loss are evaluated independently', () => {
  assert.deepEqual(
    staleHeartbeatSides({ lastDesktopSeenAt: old, lastMiniProgramSeenAt: fresh, approvedAt: old }, true, cutoff),
    { desktop: true, secondCamera: false }
  );
  assert.deepEqual(
    staleHeartbeatSides({ lastDesktopSeenAt: fresh, lastMiniProgramSeenAt: old, approvedAt: old }, true, cutoff),
    { desktop: false, secondCamera: true }
  );
});

test('rooms without a second camera never report second-camera heartbeat loss', () => {
  assert.deepEqual(
    staleHeartbeatSides({ lastDesktopSeenAt: fresh, lastMiniProgramSeenAt: null, approvedAt: old }, false, cutoff),
    { desktop: false, secondCamera: false }
  );
});

test('unapproved sessions without heartbeats are not treated as disconnected', () => {
  assert.deepEqual(
    staleHeartbeatSides({ lastDesktopSeenAt: null, lastMiniProgramSeenAt: null, approvedAt: null }, true, cutoff),
    { desktop: false, secondCamera: false }
  );
});

function observedSession(requireSecondCamera: boolean) {
  const now = Date.now();
  return {
    id: 'session', examId: 'exam', createdAt: new Date(now - 600_000), approvedAt: new Date(now - 600_000), startedAt: null,
    lastDesktopSeenAt: new Date(now), lastMiniProgramSeenAt: null, desktopOfflineAt: null, miniProgramOfflineAt: null,
    candidate: { startedAt: null, rooms: [{ room: { examId: 'exam', requireSecondCamera } }] },
    exam: { startAt: new Date(now - 600_000), latestStartAt: new Date(now + 60_000), endAt: new Date(now + 3_600_000), durationMinutes: 60, contestRule: 'XCPC', requireMiniProgram: true }
  };
}

test('a healthy classroom without second cameras takes no write locks during health scans', async () => {
  const findMany = prisma.clientSession.findMany;
  const queryRaw = prisma.$queryRaw;
  prisma.$queryRaw = (async () => [{ id: 'session' }]) as typeof queryRaw;
  const transaction = prisma.$transaction;
  let scans = 0, locks = 0;
  prisma.clientSession.findMany = (async () => {
    scans++;
    return Array.from({ length: 30 }, (_, index) => ({ ...observedSession(false), id: `session-${index}` }));
  }) as unknown as typeof findMany;
  prisma.$transaction = (async () => { locks++; throw new Error('healthy session must not take a write lock'); }) as typeof transaction;
  try {
    assert.deepEqual(await Promise.all([markStaleSessionsOffline('exam'), markStaleSessionsOffline('exam')]), [0, 0]);
    assert.equal(scans, 1, 'simultaneous admin polls share one scan and there is no second expiry scan');
    assert.equal(locks, 0);
  } finally { prisma.clientSession.findMany = findMany; prisma.$transaction = transaction; prisma.$queryRaw = queryRaw; }
});

test('an already reported single-side outage takes no write lock while the required phone is online', async () => {
  const findMany = prisma.clientSession.findMany;
  const queryRaw = prisma.$queryRaw;
  prisma.$queryRaw = (async () => [{ id: 'session' }]) as typeof queryRaw;
  const transaction = prisma.$transaction;
  const session = { ...observedSession(true), lastDesktopSeenAt: new Date(Date.now() - 600_000), lastMiniProgramSeenAt: new Date(), desktopOfflineAt: new Date() };
  prisma.clientSession.findMany = (async () => [session]) as unknown as typeof findMany;
  prisma.$transaction = (async () => { throw new Error('reported outage must not take a write lock'); }) as typeof transaction;
  try {
    assert.equal(await markStaleSessionsOffline('exam'), 0);
  } finally { prisma.clientSession.findMany = findMany; prisma.$transaction = transaction; prisma.$queryRaw = queryRaw; }
});

test('health transitions re-read clocks under the lock so a racing heartbeat prevents an obsolete offline alert', async () => {
  const findMany = prisma.clientSession.findMany;
  const queryRaw = prisma.$queryRaw;
  prisma.$queryRaw = (async () => [{ id: 'session' }]) as typeof queryRaw;
  const transaction = prisma.$transaction;
  const observed = { ...observedSession(false), lastDesktopSeenAt: new Date(Date.now() - 60_000) };
  let locked = false;
  prisma.clientSession.findMany = (async () => [observed]) as unknown as typeof findMany;
  prisma.$transaction = (async (operation: (tx: unknown) => Promise<unknown>) => operation({
    $queryRaw: async () => { locked = true; return [{ id: observed.id }]; },
    clientSession: { findUnique: async () => {
      assert.equal(locked, true);
      return { ...observed, status: 'IN_EXAM', lastDesktopSeenAt: new Date() };
    }, update: async () => { throw new Error('new heartbeat must prevent an offline write'); } }
  })) as typeof transaction;
  try { assert.equal(await markStaleSessionsOffline('exam'), 0); assert.equal(locked, true); }
  finally { prisma.clientSession.findMany = findMany; prisma.$transaction = transaction; prisma.$queryRaw = queryRaw; }
});

test('empty candidate scans do not hydrate healthy sessions and different bundles share scans', async context => {
  const url = new URL('../src/lib/session-health.ts?bundle=health-test', import.meta.url);
  const other: typeof import('../src/lib/session-health') = await import(url.href);
  assert.notEqual(other.markStaleSessionsOffline, markStaleSessionsOffline);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let queries = 0;
  replaceMethod(context, prisma, '$queryRaw', async () => { queries++; await gate; return []; });
  replaceMethod(context, prisma.clientSession, 'findMany', async () => assert.fail('healthy sessions must stay in MySQL'));
  const scans = [markStaleSessionsOffline('exam'), other.markStaleSessionsOffline('exam')];
  assert.equal(queries, 1);
  release();
  assert.deepEqual(await Promise.all(scans), [0, 0]);
  assert.equal((globalThis as { sessionHealthChecks?: Map<string, unknown> }).sessionHealthChecks?.size, 0);
});

test('an all-exam scan waits for existing scoped scans and absorbs new scopes', async context => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let queries = 0;
  replaceMethod(context, prisma, '$queryRaw', async () => { queries++; if (queries === 1) await gate; return []; });
  const scoped = markStaleSessionsOffline('exam');
  const all = markStaleSessionsOffline();
  const another = markStaleSessionsOffline('other-exam');
  assert.equal(queries, 1, 'global scan must not run alongside the scoped scan');
  release();
  assert.deepEqual(await Promise.all([scoped, all, another]), [0, 0, 0]);
  assert.equal(queries, 2);
  await markStaleSessionsOffline('exam');
  assert.equal(queries, 3, 'completed scans are never reused');
});

// Prisma delegates are dynamic proxies; Node's descriptor-based mock.method
// cannot replace them. Restore explicit assignments after each test instead.
function replaceMethod(context: TestContext, object: object, key: string, method: unknown) {
  const target = object as Record<string, unknown>;
  const original = target[key];
  target[key] = method;
  context.after(() => { target[key] = original; });
}
