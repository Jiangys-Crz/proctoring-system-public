import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/lib/db';
import { withSessionWrite, SessionWriteQueueError, SESSION_WRITE_QUEUE_LIMIT, SESSION_WRITE_QUEUE_WAIT_MS } from '../src/lib/session-write';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('a reconnect burst occupies one transaction while an unrelated session can progress', async () => {
  const original = prisma.$transaction;
  const started = deferred(), release = deferred();
  const order: number[] = [];
  let transactions = 0, active = 0, peak = 0;
  prisma.$transaction = (async (operation: (tx: unknown) => Promise<unknown>) => {
    transactions++; active++; peak = Math.max(peak, active);
    try { return await operation({ $queryRaw: async () => [{ id: 'locked' }] }); }
    finally { active--; }
  }) as typeof original;
  try {
    const burst = Array.from({ length: 100 }, (_, index) => withSessionWrite('same-session', async () => {
      order.push(index);
      if (!index) { started.resolve(); await release.promise; }
      return index;
    }));
    await started.promise;
    assert.equal(transactions, 1, 'queued same-session writers must not borrow database connections');
    assert.equal(await withSessionWrite('other-session', async () => 'unblocked'), 'unblocked');
    assert.equal(transactions, 2);
    assert.equal(peak, 2);
    release.resolve();
    assert.deepEqual(await Promise.all(burst), Array.from({ length: 100 }, (_, index) => index));
    assert.deepEqual(order, Array.from({ length: 100 }, (_, index) => index));
    assert.equal(transactions, 101);
    assert.equal(active, 0);
    assert.equal((globalThis as { sessionWriteQueues?: Map<string, unknown> }).sessionWriteQueues?.size, 0);
  } finally { release.resolve(); prisma.$transaction = original; }
});

test('failed writes release the local queue and database deadlock retries keep their place', async () => {
  const original = prisma.$transaction;
  const order: string[] = [];
  let deadlocks = 0;
  prisma.$transaction = (async (operation: (tx: unknown) => Promise<unknown>) => operation({
    $queryRaw: async () => [{ id: 'locked' }]
  })) as typeof original;
  try {
    const failed = withSessionWrite('retry-session', async () => { order.push('failed'); throw new Error('denied'); });
    const failedAssertion = assert.rejects(failed, /denied/);
    const retried = withSessionWrite('retry-session', async () => {
      order.push('retry');
      if (deadlocks++ < 2) throw { code: 'P2034' };
      return 'done';
    });
    const next = withSessionWrite('retry-session', async () => { order.push('next'); return 'next'; });
    await failedAssertion;
    assert.deepEqual(await Promise.all([retried, next]), ['done', 'next']);
    assert.deepEqual(order, ['failed', 'retry', 'retry', 'retry', 'next']);
    assert.equal((globalThis as { sessionWriteQueues?: Map<string, unknown> }).sessionWriteQueues?.size, 0);
  } finally { prisma.$transaction = original; }
});

test('expired queue entries reject promptly and never enter a transaction later', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const original = prisma.$transaction;
  const started = deferred(), release = deferred();
  let transactions = 0, obsoleteWrites = 0;
  prisma.$transaction = (async (operation: (tx: unknown) => Promise<unknown>) => {
    transactions++;
    return operation({ $queryRaw: async () => [{ id: 'locked' }] });
  }) as typeof original;
  try {
    const held = withSessionWrite('deadline-session', async () => { started.resolve(); await release.promise; });
    await started.promise;
    const obsolete = withSessionWrite('deadline-session', async () => { obsoleteWrites++; });
    const rejection = assert.rejects(obsolete, error => error instanceof SessionWriteQueueError && error.status === 503);
    context.mock.timers.tick(SESSION_WRITE_QUEUE_WAIT_MS);
    await rejection;
    assert.equal(transactions, 1, 'timed out work must not borrow a connection');
    release.resolve();
    await held;
    assert.equal(await withSessionWrite('deadline-session', async () => 'fresh'), 'fresh');
    assert.equal(obsoleteWrites, 0, 'expired heartbeat must not refresh the last-seen clock after the lock is freed');
    assert.equal(transactions, 2);
    assert.equal((globalThis as { sessionWriteQueues?: Map<string, unknown> }).sessionWriteQueues?.size, 0);
  } finally { release.resolve(); prisma.$transaction = original; }
});

test('the per-session queue caps memory and admits requests again after draining', async () => {
  const original = prisma.$transaction;
  const started = deferred(), release = deferred();
  let transactions = 0;
  prisma.$transaction = (async (operation: (tx: unknown) => Promise<unknown>) => {
    transactions++;
    return operation({ $queryRaw: async () => [{ id: 'locked' }] });
  }) as typeof original;
  try {
    const held = withSessionWrite('capacity-session', async () => { started.resolve(); await release.promise; });
    await started.promise;
    const waiting = Array.from({ length: SESSION_WRITE_QUEUE_LIMIT - 1 }, () => withSessionWrite('capacity-session', async () => 'accepted'));
    await assert.rejects(withSessionWrite('capacity-session', async () => assert.fail('overflow must not execute')), SessionWriteQueueError);
    assert.equal(transactions, 1);
    assert.equal(await withSessionWrite('independent-session', async () => 'independent'), 'independent');
    release.resolve();
    await held;
    assert.equal((await Promise.all(waiting)).length, SESSION_WRITE_QUEUE_LIMIT - 1);
    assert.equal(await withSessionWrite('capacity-session', async () => 'recovered'), 'recovered');
    assert.equal((globalThis as { sessionWriteQueues?: Map<string, unknown> }).sessionWriteQueues?.size, 0);
  } finally { release.resolve(); prisma.$transaction = original; }
});

test('a different route bundle draining expired work preserves the waiting bundle error type', async context => {
  const now = Date.now();
  context.mock.timers.enable({ apis: ['Date'], now });
  const moduleUrl = new URL('../src/lib/session-write.ts', import.meta.url);
  moduleUrl.searchParams.set('bundle', 'a');
  const a: typeof import('../src/lib/session-write') = await import(moduleUrl.href);
  moduleUrl.searchParams.set('bundle', 'b');
  const b: typeof import('../src/lib/session-write') = await import(moduleUrl.href);
  assert.notEqual(a.SessionWriteQueueError, b.SessionWriteQueueError, 'fixture must load separate bundle constructors');
  const original = prisma.$transaction;
  const started = deferred(), release = deferred();
  let writes = 0;
  prisma.$transaction = (async (operation: (tx: unknown) => Promise<unknown>) => operation({
    $queryRaw: async () => [{ id: 'locked' }]
  })) as typeof original;
  try {
    const held = a.withSessionWrite('cross-bundle-session', async () => { started.resolve(); await release.promise; });
    await started.promise;
    const waiting = b.withSessionWrite('cross-bundle-session', async () => { writes++; });
    const rejected = assert.rejects(waiting, error => error instanceof b.SessionWriteQueueError && !(error instanceof a.SessionWriteQueueError));
    // Advance wall time without firing the real timeout: bundle A must notice
    // expiration when its running operation finishes and drains bundle B.
    context.mock.timers.setTime(now + SESSION_WRITE_QUEUE_WAIT_MS);
    release.resolve();
    await held;
    await rejected;
    assert.equal(writes, 0);
    assert.equal((globalThis as { sessionWriteQueues?: Map<string, unknown> }).sessionWriteQueues?.size, 0);
  } finally { release.resolve(); prisma.$transaction = original; }
});

test('the same deadline applies after waiting for a database row lock', async context => {
  const now = Date.now();
  context.mock.timers.enable({ apis: ['Date'], now });
  const original = prisma.$transaction;
  let writes = 0;
  prisma.$transaction = (async (operation: (tx: unknown) => Promise<unknown>, options: { maxWait: number }) => {
    assert.equal(options.maxWait, SESSION_WRITE_QUEUE_WAIT_MS);
    return operation({ $queryRaw: async () => { context.mock.timers.setTime(now + SESSION_WRITE_QUEUE_WAIT_MS); return [{ id: 'locked' }]; } });
  }) as typeof original;
  try {
    await assert.rejects(withSessionWrite('database-wait-session', async () => { writes++; }), SessionWriteQueueError);
    assert.equal(writes, 0, 'stale work must not refresh liveness after a cross-process row-lock wait');
  } finally { prisma.$transaction = original; }
});
