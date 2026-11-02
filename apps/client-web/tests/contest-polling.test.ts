import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSerialPolling, submissionPollDelay } from '../src/lib/contest-polling';

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

test('slow polls never overlap, schedule only after completion, and stopping cancels future work', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let release!: () => void;
  const stop = startSerialPolling(() => { calls++; return new Promise<void>(resolve => { release = resolve; }); }, () => 1000);
  assert.equal(calls, 1);
  context.mock.timers.tick(60_000);
  assert.equal(calls, 1, 'a slow server must not create a backlog of interval requests');
  release(); await flush();
  context.mock.timers.tick(999); assert.equal(calls, 1);
  context.mock.timers.tick(1); assert.equal(calls, 2);
  stop(); release(); await flush();
  context.mock.timers.tick(60_000); assert.equal(calls, 2);
});

test('temporary failures retry and cancellation clears a scheduled retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startSerialPolling(async () => { calls++; throw new Error('temporary failure'); }, () => 5000);
  await flush(); context.mock.timers.tick(5000); await flush();
  assert.equal(calls, 2);
  stop(); context.mock.timers.tick(60_000); assert.equal(calls, 2);
});

test('leaving a monitor aborts its pending request and never schedules another poll', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let cancelled = 0;
  const stop = startSerialPolling(signal => new Promise<void>((_resolve, reject) => {
    calls++;
    signal.addEventListener('abort', () => { cancelled++; reject(new Error('cancelled')); }, { once: true });
  }), () => 5000);
  context.mock.timers.tick(30_000);
  assert.equal(calls, 1);
  stop();
  await flush();
  assert.equal(cancelled, 1);
  context.mock.timers.tick(30_000);
  assert.equal(calls, 1);
});

test('a stalled heartbeat reaches its deadline, then retries without overlapping', async context => {
  const { readWithDeadline } = await import('../src/lib/contest-polling');
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let active = 0;
  let calls = 0;
  const stop = startSerialPolling(signal => readWithDeadline(requestSignal => new Promise<void>((_resolve, reject) => {
    calls++; active++;
    assert.equal(active, 1);
    requestSignal.addEventListener('abort', () => { active--; reject(new Error('deadline')); }, { once: true });
  }), signal, 10_000), () => 5000);
  context.mock.timers.tick(10_000);
  await flush(); await flush(); await flush();
  assert.equal(active, 0);
  context.mock.timers.tick(5000);
  assert.equal(calls, 2);
  stop(); await flush();
  assert.equal(active, 0);
});

test('pending judgments stay responsive while settled and background views reduce polling', () => {
  assert.equal(submissionPollDelay(true, false, true), 1000);
  assert.equal(submissionPollDelay(true, true, false), 3000);
  assert.equal(submissionPollDelay(true, false, false), 10_000);
  assert.equal(submissionPollDelay(false, true, true), 15_000);
});

test('detail deadlines abort a stalled read and navigation also cancels it', async context => {
  const { readWithDeadline } = await import('../src/lib/contest-polling');
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const read = (signal: AbortSignal) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  const navigation = new AbortController();
  const timed = assert.rejects(readWithDeadline(read, navigation.signal, 1000), /aborted/);
  context.mock.timers.tick(1000); await timed;
  const cancelled = assert.rejects(readWithDeadline(read, navigation.signal), /aborted/);
  navigation.abort(); await cancelled;
});
