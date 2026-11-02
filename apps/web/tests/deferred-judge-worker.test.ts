import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/lib/db';
import { triggerDeferredJudge, triggerJudgeStatusSync } from '../src/lib/deferred-judge';

test('50 submission triggers share one queue scan and a later trigger can drain newly saved submissions', async () => {
  const original = prisma.contestSubmission.findMany;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let scans = 0;
  prisma.contestSubmission.findMany = (async () => {
    scans++;
    await held;
    return [];
  }) as unknown as typeof original;
  try {
    const submissions = Array.from({ length: 50 }, () => triggerDeferredJudge());
    assert.equal(scans, 1, 'a submit burst must not scan the same durable queue 50 times');
    release();
    await Promise.all(submissions);
    assert.equal(scans, 1, 'status synchronization has its own independent worker');
    await triggerDeferredJudge();
    assert.equal(scans, 2, 'new submissions can be processed after the first worker finishes');
  } finally {
    release();
    await triggerDeferredJudge();
    prisma.contestSubmission.findMany = original;
  }
});

test('status synchronization continues while the submission dispatch queue is blocked', async () => {
  const original = prisma.contestSubmission.findMany;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let statusScans = 0;
  prisma.contestSubmission.findMany = (async ({ where }: any) => {
    if (where.deferredJudge) { await held; return []; }
    statusScans++;
    return [];
  }) as unknown as typeof original;
  try {
    const dispatch = triggerDeferredJudge();
    await triggerJudgeStatusSync();
    await triggerJudgeStatusSync();
    assert.equal(statusScans, 2, 'both status ticks finish before the dispatcher is released');
    release();
    await dispatch;
  } finally {
    release();
    await triggerDeferredJudge();
    await triggerJudgeStatusSync();
    prisma.contestSubmission.findMany = original;
  }
});

test('status worker cycles beyond 200 stuck rows and then revisits the first page', async () => {
  const originalFind = prisma.contestSubmission.findMany;
  const originalSettings = prisma.systemSetting.findUnique;
  const originalFetch = globalThis.fetch;
  const stamp = new Date();
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: String(index).padStart(3, '0'),
    createdAt: stamp, status: 22, hydroRecordId: `remote-${index}`, judgeAt: null,
    exam: { platformBaseUrl: 'https://judge.example.org' } }));
  const queries: any[] = [];
  prisma.contestSubmission.findMany = (async (query: any) => {
    queries.push(query);
    return queries.length === 1 ? rows : [];
  }) as unknown as typeof originalFind;
  prisma.systemSetting.findUnique = (async () => ({ value: {
    baseUrl: 'https://judge.example.org', apiKey: 'test-only', problemDomainId: 'Problems',
  } })) as unknown as typeof originalSettings;
  globalThis.fetch = async () => Response.json({ ok: true, data: [] });
  try {
    await triggerJudgeStatusSync();
    await triggerJudgeStatusSync();
    await triggerJudgeStatusSync();
    assert.equal(queries[0].where.OR, undefined);
    assert.deepEqual(queries[1].where.OR, [{ createdAt: { gt: stamp } }, { createdAt: stamp, id: { gt: '199' } }]);
    assert.equal(queries[2].where.OR, undefined, 'end of sweep returns to older unfinished rows');
    assert.equal(queries[0].select.code, undefined);
  } finally {
    prisma.contestSubmission.findMany = originalFind;
    prisma.systemSetting.findUnique = originalSettings;
    globalThis.fetch = originalFetch;
  }
});
