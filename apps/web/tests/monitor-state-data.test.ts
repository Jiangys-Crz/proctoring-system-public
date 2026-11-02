import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/db';
import { loadMonitorData, loadMonitorExam } from '../src/lib/monitor-state-data';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Real MySQL verifies row isolation; this controlled gate makes overlap and
// failed reads deterministic without relying on database/network timing.
test('overlapping managers share one read across bundles; completed reads stay fresh', async context => {
  const release = deferred();
  const models = [prisma.loginRequest, prisma.clientSession, prisma.alert,
    prisma.mediaSegment, prisma.examRoom, prisma.cheatingRecord, prisma.printJob, prisma.liveFrame];
  for (const model of models) replaceMethod(context, model, 'findMany', async () => { await release.promise; return []; });
  let candidateReads = 0;
  replaceMethod(context, prisma.candidate, 'findMany', async () => { candidateReads++; await release.promise; return []; });
  const url = new URL('../src/lib/monitor-state-data.ts?bundle=monitor-test', import.meta.url);
  const other: typeof import('../src/lib/monitor-state-data') = await import(url.href);
  assert.notEqual(loadMonitorData, other.loadMonitorData);
  const first = loadMonitorData('exam', 'owner', true);
  const second = other.loadMonitorData('exam', 'manager', true);
  assert.equal(candidateReads, 1);
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], results[1]);
  await loadMonitorData('exam', 'owner', true);
  assert.equal(candidateReads, 2, 'there is no completed snapshot cache after mutations');
});

test('every proctor request reads fresh room permissions even while the same user has a pending read', async context => {
  const release = deferred();
  const models = [prisma.loginRequest, prisma.clientSession, prisma.alert,
    prisma.mediaSegment, prisma.examRoom, prisma.cheatingRecord, prisma.printJob, prisma.liveFrame];
  for (const model of models) replaceMethod(context, model, 'findMany', async () => { await release.promise; return []; });
  let candidateReads = 0;
  replaceMethod(context, prisma.candidate, 'findMany', async () => { candidateReads++; await release.promise; return []; });
  const reads = [loadMonitorData('exam', 'a', false), loadMonitorData('exam', 'a', false),
    loadMonitorData('exam', 'b', false), loadMonitorData('exam', 'a', true), loadMonitorData('other-exam', 'a', false)];
  assert.equal(candidateReads, 5);
  release.resolve();
  await Promise.all(reads);
});

test('failed shared exam reads are evicted and the next request retries', async context => {
  const release = deferred();
  let calls = 0;
  replaceMethod(context, prisma.exam, 'findUnique', async () => { calls++; await release.promise; if (calls === 1) throw new Error('database unavailable'); return null; });
  const failed = Promise.allSettled([loadMonitorExam('exam'), loadMonitorExam('exam')]);
  assert.equal(calls, 1);
  release.resolve();
  assert.ok((await failed).every(result => result.status === 'rejected'));
  assert.equal(await loadMonitorExam('exam'), null);
  assert.equal(calls, 2);
  assert.equal((globalThis as { monitorExamReads?: Map<string, unknown> }).monitorExamReads?.size, 0);
});

test('many independent exams do not grow the pending-read map without bound', async context => {
  const release = deferred();
  let calls = 0;
  replaceMethod(context, prisma.exam, 'findUnique', async () => { calls++; await release.promise; return null; });
  const reads = Array.from({ length: 300 }, (_, index) => loadMonitorExam(`exam-${index}`));
  reads.push(loadMonitorExam('exam-0'), loadMonitorExam('exam-299'));
  assert.equal(calls, 301, 'tracked scopes share while overflow reads still proceed');
  assert.equal((globalThis as { monitorExamReads?: Map<string, unknown> }).monitorExamReads?.size, 256);
  release.resolve();
  await Promise.all(reads);
  assert.equal((globalThis as { monitorExamReads?: Map<string, unknown> }).monitorExamReads?.size, 0);
});

// Prisma delegates are dynamic proxies; Node's descriptor-based mock.method
// cannot replace them. Restore explicit assignments after each test instead.
function replaceMethod(context: TestContext, object: object, key: string, method: unknown) {
  const target = object as Record<string, unknown>;
  const original = target[key];
  target[key] = method;
  context.after(() => { target[key] = original; });
}
