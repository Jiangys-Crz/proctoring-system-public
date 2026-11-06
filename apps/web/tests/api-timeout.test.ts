import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { api } from '../src/components/api';

function pendingFetch(t: TestContext) {
  let options: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', (_url: string, init?: RequestInit) => {
    options = init;
    return new Promise<Response>((_resolve, reject) => {
      const aborted = () => reject(new DOMException('Request cancelled', 'AbortError'));
      if (init?.signal?.aborted) aborted();
      else init?.signal?.addEventListener('abort', aborted, { once: true });
    });
  });
  return () => { assert(options?.signal); return options as RequestInit & { signal: AbortSignal }; };
}

test('ordinary API requests keep the existing 20 second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = pendingFetch(t);
  const failed = assert.rejects(api('/ordinary'), { name: 'AbortError' });
  t.mock.timers.tick(19_999); assert.equal(options().signal.aborted, false);
  t.mock.timers.tick(1); await failed;
});

test('form uploads retain the existing 120 second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = pendingFetch(t);
  const failed = assert.rejects(api('/upload', { method: 'POST', body: new FormData() }), { name: 'AbortError' });
  t.mock.timers.tick(119_999); assert.equal(options().signal.aborted, false);
  t.mock.timers.tick(1); await failed;
});

test('Reaction export preflight can use a longer bounded deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = pendingFetch(t);
  for (const timeoutMs of [600_000]) {
    const failed = assert.rejects(api('/reaction-operation', { timeoutMs }), { name: 'AbortError' });
    assert.equal('timeoutMs' in options(), false, 'Client-only options must not leak into fetch');
    t.mock.timers.tick(20_000); assert.equal(options().signal.aborted, false);
    t.mock.timers.tick(timeoutMs - 20_001); assert.equal(options().signal.aborted, false);
    t.mock.timers.tick(1); await failed;
  }
});

test('a longer custom deadline never overrides the caller cancellation signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = pendingFetch(t);
  const controller = new AbortController();
  const failed = assert.rejects(api('/reaction-export', { timeoutMs: 600_000, signal: controller.signal }), { name: 'AbortError' });
  t.mock.timers.tick(20_000); assert.equal(options().signal.aborted, false);
  controller.abort(); assert.equal(options().signal.aborted, true); await failed;
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  await assert.rejects(api('/cancelled', { timeoutMs: 60_000, signal: alreadyCancelled.signal }), { name: 'AbortError' });
});

test('successful requests clear both their timeout and caller abort listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let receivedSignal: AbortSignal | null | undefined;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    receivedSignal = init?.signal;
    return Response.json({ ok: true, data: { accepted: true } });
  });
  assert.deepEqual(await api('/ready', { timeoutMs: 60_000, signal: controller.signal }), { accepted: true });
  assert(receivedSignal); controller.abort(); t.mock.timers.tick(60_000);
  assert.equal(receivedSignal.aborted, false);
});

test('an invalid or unbounded custom deadline never starts a request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, data: {} }));
  for (const timeoutMs of [0, -1, NaN, Infinity, 600_001]) await assert.rejects(api('/invalid', { timeoutMs }), /请求超时时间不正确/);
  assert.equal(fetch.mock.callCount(), 0);
});
