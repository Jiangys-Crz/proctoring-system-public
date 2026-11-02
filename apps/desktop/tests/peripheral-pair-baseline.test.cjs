const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const renderer = readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const pairCode = renderer.slice(renderer.indexOf('async function requestDesktopPair()'), renderer.indexOf('async function enterLogin()'));
const main = readFileSync(require.resolve('../src/main/main.ts'), 'utf8');
const ipcCode = main.slice(main.indexOf("handleClient('security:confirmPeripheralBaseline'"), main.indexOf("handleClient('permissions:requestNetworkDomain'"));
const currentFingerprint = `usb-v6:${'b'.repeat(64)}`;

function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function pairHarness() {
  const scan = deferred(), posts = [];
  let scans = 0;
  const state = { serverUrl: 'https://proctor.example', monitoringGeneration: 1, session: null,
    allPermissionsGranted: true, systemReady: true, mediaReady: true, desktopInfo: { deviceId: 'device' },
    baselineFingerprint: `usb-v4:${'a'.repeat(64)}` };
  const context = vm.createContext({ state, configureCaptureProfile() {}, window: { proctorApi: {
    getSystemPermissionStatus: async () => ({}),
    confirmPeripheralBaseline: () => { scans++; return scan.promise; }
  } }, screenSourceUsable: () => true, cameraAuthorized: () => true,
  api: async (_path, options) => { posts.push(JSON.parse(options.body)); return { pollToken: 'poll', pairCode: '123456' }; } });
  vm.runInContext(pairCode, context);
  return { context, state, scan, posts, get scans() { return scans; } };
}

test('new QR and account login pairing uses the confirmed current device fingerprint', async () => {
  const h = pairHarness();
  const pending = h.context.requestDesktopPair();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.scans, 1);
  assert.equal(h.posts.length, 0, 'pairing waits for the bounded device confirmation');
  h.scan.resolve(currentFingerprint);
  await pending;
  assert.equal(h.posts[0].peripheralsFingerprint, currentFingerprint);
  assert.equal(h.state.baselineFingerprint, currentFingerprint);
});

test('login pairing accepts supported Windows and Mac baselines without replacing the confirmed fingerprint', async () => {
  for (const prefix of ['usb-v6', 'usb-v5', 'usb-v4', 'mac-usb-v3']) {
    const h = pairHarness();
    const fingerprint = `${prefix}:${'c'.repeat(64)}`;
    h.scan.resolve(fingerprint);
    const pair = await h.context.requestDesktopPair();
    assert.equal(pair.pairCode, '123456');
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].peripheralsFingerprint, fingerprint);
    assert.equal(h.state.baselineFingerprint, fingerprint);
  }
});

test('missing, malformed and unsupported device baselines cannot create a login pairing', async () => {
  for (const fingerprint of [undefined, '', 'a'.repeat(64), `usb-v3:${'a'.repeat(64)}`, `usb-v7:${'a'.repeat(64)}`, `usb-v6:${'a'.repeat(63)}`, `usb-v6:${'g'.repeat(64)}`]) {
    const h = pairHarness();
    const previous = h.state.baselineFingerprint;
    h.scan.resolve(fingerprint);
    await assert.rejects(h.context.requestDesktopPair(), /设备检测未完成/);
    assert.equal(h.posts.length, 0);
    assert.equal(h.state.baselineFingerprint, previous);
  }
});

test('an unavailable or unstable baseline cannot submit an old cached fingerprint', async () => {
  const h = pairHarness();
  const old = h.state.baselineFingerprint;
  const pending = h.context.requestDesktopPair();
  h.scan.reject(new Error('设备检测未稳定，请稍后重试'));
  await assert.rejects(pending, /设备检测未稳定/);
  assert.equal(h.posts.length, 0);
  assert.equal(h.state.baselineFingerprint, old);
});

test('an active exam never requests a new login baseline and late confirmation cannot cross sessions', async () => {
  const active = pairHarness();
  active.state.session = { id: 'active', status: 'IN_EXAM' };
  await assert.rejects(active.context.requestDesktopPair(), /已有考试会话/);
  assert.equal(active.scans, 0);
  for (const change of [h => { h.state.session = { id: 'new-session', status: 'APPROVED' }; }, h => { h.state.serverUrl = 'https://other.example'; }, h => { h.state.monitoringGeneration++; }]) {
    const h = pairHarness();
    const pending = h.context.requestDesktopPair();
    await new Promise(resolve => setImmediate(resolve));
    change(h);
    h.scan.resolve(currentFingerprint);
    await assert.rejects(pending, /客户端状态已改变/);
    assert.equal(h.posts.length, 0);
  }
});

test('main process permits baseline confirmation only during setup without display or active streams', async () => {
  let handler, calls = 0;
  const scan = deferred();
  const env = { windowMode: 'setup', screenControlWatcher: { isDisplaying: false }, rtmpProcesses: new Map(), rtmpPipeProcesses: new Map(),
    handleClient: (_channel, callback) => { handler = callback; }, confirmPeripheralBaseline: () => { calls++; return scan.promise; } };
  vm.runInNewContext(ipcCode, env);
  for (const mode of ['floating', 'locked']) {
    env.windowMode = mode;
    await assert.rejects(handler(), /请先结束/);
  }
  env.windowMode = 'setup';
  env.screenControlWatcher.isDisplaying = true;
  await assert.rejects(handler(), /请先结束/);
  env.screenControlWatcher.isDisplaying = false;
  for (const streams of [env.rtmpProcesses, env.rtmpPipeProcesses]) {
    streams.set('active', {});
    await assert.rejects(handler(), /请先结束/);
    streams.clear();
  }
  assert.equal(calls, 0);
  const pending = handler();
  env.windowMode = 'floating';
  scan.resolve(currentFingerprint);
  await assert.rejects(pending, /客户端状态已改变/);
});
