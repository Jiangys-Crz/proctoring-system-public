import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';
import * as asyncHooks from 'node:async_hooks';
import * as crypto from 'node:crypto';
import { FederationError } from '../src/lib/exam-federation-protocol';

function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const module = { exports: {} as any };
  const source = readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), 'utf8');
  const code = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  runInNewContext(code, { module, exports: module.exports, Buffer, Response, AbortSignal, setInterval, clearInterval,
    require: (id: string) => { assert.ok(id in dependencies, id); return dependencies[id]; }, ...globals });
  return module.exports;
}

function clock() {
  let now = 1_000_000;
  class ClockDate extends Date { constructor(value = now) { super(value); } static now() { return now; } }
  return { Date: ClockDate, sleep: async (ms: number) => { now += ms; } };
}

test('manual imports wait for a background lease without releasing or stealing it', async () => {
  const timer = clock();
  let claims = 0, released = 0, worked = 0;
  const state = { upsert: async () => {}, updateMany: async ({ where, data }: any) => {
    if (data.leaseToken === null) { released++; return { count: 1 }; }
    assert.equal(where.leaseToken, undefined);
    return { count: ++claims >= 3 ? 1 : 0 };
  } };
  const lease = load('platform-sync-lock', {
    'node:async_hooks': asyncHooks, 'node:crypto': crypto, 'node:timers/promises': { setTimeout: timer.sleep },
    './db': { prisma: { platformSyncState: state, systemSetting: { findUnique: async () => ({ value: {} }) } } },
    './exam-federation-protocol': { FederationError, digest: () => 'expected' }
  }, { Date: timer.Date });
  assert.equal(await lease.withPlatformLease(async () => { worked++; return 'done'; }, 'expected', 1000), 'done');
  assert.equal(claims, 3); assert.equal(released, 1); assert.equal(worked, 1);
});

test('scheduled sync and exhausted manual waits leave the current lease owner intact', async () => {
  for (const wait of [0, 500]) {
    const timer = clock(); let released = 0;
    const lease = load('platform-sync-lock', {
      'node:async_hooks': asyncHooks, 'node:crypto': crypto, 'node:timers/promises': { setTimeout: timer.sleep },
      './db': { prisma: { platformSyncState: { upsert: async () => {}, updateMany: async ({ data }: any) => {
        if (data.leaseToken === null) released++;
        return { count: 0 };
      } } } }, './exam-federation-protocol': { FederationError }
    }, { Date: timer.Date });
    await assert.rejects(lease.withPlatformLease(async () => assert.fail('busy lease cannot run work'), undefined, wait), /同步正在进行/);
    assert.equal(released, 0);
  }
});

function protocol(fetch: typeof globalThis.fetch, timer = clock()) {
  return load('platform-sync-protocol', {
    zod: { z }, 'node:timers/promises': { setTimeout: timer.sleep },
    './exam-federation-protocol': { FederationError }, './platform-sync-settings': { platformOrigin: (url: string) => new URL(url).origin }
  }, { Date: timer.Date, fetch });
}

test('temporary remote lease/admission contention retries the same import page and snapshot', async () => {
  for (const message of ['同步正在进行，请稍后重试', '同步服务繁忙，已保留进度，请稍后重试']) {
    const requests: string[] = [];
    const api = protocol(async (_url, options) => {
      requests.push(String(options?.body));
      return requests.length < 3 ? Response.json({ ok: false, message }, { status: 503, headers: { 'Retry-After': '2' } })
        : Response.json({ ok: true, data: { completed: true } });
    });
    assert.deepEqual(await api.platformRequest('https://public.test', 'test-only-key', '/api/platform-sync',
      { action: 'exam', snapshot: 'fixed-snapshot', after: '2' }, z.object({ completed: z.boolean() })), { completed: true });
    assert.equal(requests.length, 3); assert.equal(new Set(requests).size, 1);
  }
});

test('persistent contention is bounded and is not misreported as a credential error', async () => {
  let attempts = 0;
  const api = protocol(async () => { attempts++; return Response.json({ ok: false, message: '同步正在进行，请稍后重试' }, { status: 503 }); });
  await assert.rejects(api.platformRequest('https://public.test', 'test-only-key', '/api/platform-sync', {}, z.unknown()), /持续繁忙/);
  assert.ok(attempts > 1 && attempts <= 121);
});

test('authentication and non-contention server failures are not retried', async () => {
  for (const status of [401, 403, 409, 503]) {
    let attempts = 0;
    const api = protocol(async () => { attempts++; return Response.json({ ok: false, message: 'unrelated failure' }, { status }); });
    await assert.rejects(api.platformRequest('https://public.test', 'test-only-key', '/api/platform-sync', {}, z.unknown()));
    assert.equal(attempts, 1);
  }
});
