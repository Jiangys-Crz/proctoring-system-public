const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PublisherLifecycle } = require('../dist/main/publisher-lifecycle');
const { canRetryRequest, isTrustedClientFrame } = require('../dist/main/ipc-policy');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let nextPid = 100;
class FakeChild extends EventEmitter {
  pid = nextPid++;
  killed = false;
  exitCode = null;
  signalCode = null;
  signals = [];
  stdin = { end() {} };
  constructor(autoExit = true) { super(); this.autoExit = autoExit; }
  kill(signal) {
    this.killed = true;
    this.signals.push(signal);
    if (this.autoExit || signal === 'SIGKILL') queueMicrotask(() => this.exit(signal));
    return true;
  }
  exit(signal = 'SIGTERM') { this.signalCode = signal; this.emit('exit', null, signal); }
}

test('concurrent and repeated requests reuse one publisher throughout startup and capture', async () => {
  const registry = new PublisherLifecycle();
  const ready = deferred();
  const child = new FakeChild();
  let starts = 0;
  const launch = async (register) => { starts++; register(child); await ready.promise; return child.pid; };
  const first = registry.start('screen', 'session-a', launch);
  const second = registry.start('screen', 'session-a', launch);
  assert.equal(first, second);
  await tick();
  assert.equal(starts, 1);
  ready.resolve();
  assert.equal(await first, child.pid);
  assert.equal(await registry.start('screen', 'session-a', launch), child.pid);
  assert.equal(starts, 1);
  await registry.stopAll();
});

test('stop during startup kills the registered process and cannot resurrect it', async () => {
  const registry = new PublisherLifecycle();
  const ready = deferred();
  const child = new FakeChild();
  const first = registry.start('screen', 'session-a', async (register) => { register(child); await ready.promise; return child.pid; });
  const rejected = assert.rejects(first, /取消/);
  await tick();
  await registry.stopAll();
  ready.resolve();
  await rejected;
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('switching sessions waits for the old process exit before creating the replacement', async () => {
  const registry = new PublisherLifecycle();
  const oldChild = new FakeChild(false);
  await registry.start('screen', 'session-a', async (register) => { register(oldChild); return oldChild.pid; });
  let replacement;
  const next = registry.start('screen', 'session-b', async (register) => { replacement = new FakeChild(); register(replacement); return replacement.pid; });
  await tick();
  assert.equal(replacement, undefined);
  oldChild.exit();
  await next;
  assert.ok(replacement);
  await registry.stopAll();
});

test('stop cancels a queued replacement before it can spawn', async () => {
  const registry = new PublisherLifecycle();
  const child = new FakeChild(false);
  await registry.start('screen', 'session-a', async (register) => { register(child); return child.pid; });
  let replacements = 0;
  const next = registry.start('screen', 'session-b', async () => { replacements++; return 123; });
  const rejected = assert.rejects(next, /取消/);
  const stopped = registry.stopAll();
  child.exit();
  await Promise.all([stopped, rejected]);
  assert.equal(replacements, 0);
});

test('failed startup is cleaned up and a later retry can start once', async () => {
  const registry = new PublisherLifecycle();
  const failed = new FakeChild();
  await assert.rejects(registry.start('camera', 'session-a', async (register) => { register(failed); throw new Error('device disconnected'); }), /device disconnected/);
  assert.equal(failed.killed, true);
  const next = new FakeChild();
  assert.equal(await registry.start('camera', 'session-a', async (register) => { register(next); return next.pid; }), next.pid);
  await registry.stopAll();
});

test('unresponsive children are force-killed instead of allowing duplicate publishers', async () => {
  const registry = new PublisherLifecycle();
  const child = new FakeChild(false);
  await registry.start('camera', 'session-a', async (register) => { register(child); return child.pid; });
  // Keep the test alive; production has the Electron event loop while teardown runs.
  const keepAlive = setInterval(() => {}, 100);
  try { await registry.stopAll(); } finally { clearInterval(keepAlive); }
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('only the exact local client main frame can request privileged operations', () => {
  const file = '/app/dist/renderer/index.html';
  const trusted = (sender, main, url) => isTrustedClientFrame(sender, 10, main, url, file);
  assert.equal(trusted(10, true, 'file:///app/dist/renderer/index.html'), true);
  assert.equal(trusted(10, false, 'file:///app/dist/renderer/index.html'), false);
  assert.equal(trusted(11, true, 'file:///app/dist/renderer/index.html'), false);
  assert.equal(trusted(10, true, 'https://exam.example/contest'), false);
  assert.equal(trusted(10, true, 'file:///app/dist/renderer/other.html'), false);
  assert.equal(trusted(10, true, 'file:///app/dist/renderer/index.html/../other.html'), false);
});

test('unknown write outcomes are never automatically replayed through another network transport', () => {
  for (const method of ['GET', 'get', 'HEAD', 'OPTIONS']) assert.equal(canRetryRequest(method), true);
  for (const method of ['POST', 'post', 'PUT', 'PATCH', 'DELETE']) assert.equal(canRetryRequest(method), false);
});
