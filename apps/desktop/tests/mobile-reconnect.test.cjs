const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const renderer = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const start = renderer.indexOf('async function refreshMediaState()');
const end = renderer.indexOf('\nfunction offlineDurationText()', start);
const stopStart = renderer.indexOf('function stopMonitoringTimers()');
const stopEnd = renderer.indexOf("\nwindow.addEventListener('online'", stopStart);
const mobileUrlStart = renderer.indexOf('function mobileWebsiteUrl()');
const mobileUrlEnd = renderer.indexOf('\nfunction mediaRtmpBase()', mobileUrlStart);
const reconnectSource = renderer.slice(mobileUrlStart, mobileUrlEnd)
  + renderer.slice(start, end) + renderer.slice(stopStart, stopEnd);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const clock = { wall: Date.parse('2026-10-07T08:00:00Z'), elapsed: 0 };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.wall])); }
    static now() { return clock.wall; }
  }
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, {
        textContent: '', src: '', classes,
        removeAttribute(name) { if (name === 'src') this.src = ''; },
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name),
          toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }
        }
      });
    }
    return elements.get(id);
  };
  const state = {
    session: { id: 'session-a', status: 'IN_EXAM' }, desktopInfo: { deviceId: 'desktop-device' },
    serverUrl: 'https://api.test', sessionToken: 'token-a', baselineFingerprint: 'fingerprint',
    monitoringGeneration: 1, finishedScreenVisible: false, mediaStateRequestId: 0,
    mobileReconnectPairCode: '', mobileReconnectPairExpiresAt: 0,
    mobileReconnectQrGenerating: false, mobileReconnectQrContext: null
  };
  const requests = [], qrUrls = [], errors = [], decodedImages = [];
  let nextCode = 123456;
  const pair = code => ({
    pairCode: String(code ?? nextCode++),
    recoverySecret: 'audit-recovery-secret',
    serverNow: '2026-10-07T08:00:00Z', expiresAt: '2026-10-07T08:05:00Z'
  });
  const context = vm.createContext({
    URL, URLSearchParams, Date: TestDate, performance: { now: () => clock.elapsed }, state, $: element,
    api: async (path, request) => {
      requests.push({ path, input: request?.body ? JSON.parse(request.body) : null });
      if (options.api) return options.api(path, request);
      if (path.startsWith('/api/client/media-state')) return {
        session: { requireSecondCamera: true, lastMiniProgramSeenAt: new TestDate().toISOString() }
      };
      return pair();
    },
    Image: class {
      async decode() {
        decodedImages.push(this);
        if (options.decode) await options.decode(this);
      }
    },
    mobileWebsiteOrigin: () => 'https://candidate.test', mobileApiBase: () => 'https://api.test',
    screenCaptureLive: () => true, screenSourceUsable: () => true, cameraCaptureLive: () => true,
    showError: error => errors.push(error), updateLocalPreviews() {},
    window: {
      clearTimeout() {}, proctorApi: {
        stopNetworkDomainMonitor() {},
        async createQrDataUrl(url) {
          qrUrls.push(url);
          return options.createQr ? options.createQr(url) : `data:qr:${new URL(url).searchParams.get('pairCode')}`;
        }
      }
    },
    clearInterval() {}, evidenceFlushTimers: new Set(), ensureUploadFlushTimer() {},
    stopStream() {}, stopRtmpStreams() {}, stopReconnectLoop() {}, stopExamConnectionDisplay() {}
  });
  vm.runInContext(reconnectSource, context);
  return { context, state, clock, element, requests, qrUrls, errors, decodedImages, pair };
}

test('available second cameras show a reconnect title and QR uses the mobile API origin', async () => {
  const h = harness();
  await h.context.refreshMediaState();
  await tick();
  assert.equal(h.element('mobileReconnectQrTitle').textContent, '第二机位重连');
  assert.equal(h.element('mobileReconnectQr').classes.has('hidden'), false);
  assert.equal(h.element('mobileReconnectQr').classes.has('offline'), false);
  const url = new URL(h.qrUrls[0]);
  assert.equal(url.origin, 'https://candidate.test');
  assert.equal(url.searchParams.get('apiBase'), 'https://api.test');
  assert.equal(url.searchParams.get('reconnect'), '1');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('recoverySecret'), 'audit-recovery-secret');
  assert.equal(url.searchParams.has('recoverySecret'), false);
  assert.equal(url.searchParams.has('pollToken'), false);
  assert.equal(url.searchParams.has('sessionToken'), false);
  assert.equal(h.element('mobileReconnectQrImage').src, 'data:qr:123456');
});

test('offline second cameras are marked clearly and disabled second cameras remove the QR', async () => {
  let required = true;
  const h = harness({ api: async path => path.startsWith('/api/client/media-state')
    ? { session: { requireSecondCamera: required, lastMiniProgramSeenAt: null } } : h.pair() });
  await h.context.refreshMediaState();
  await tick();
  assert.equal(h.element('mobileReconnectQrTitle').textContent, '第二机位已断联');
  assert.equal(h.element('mobileReconnectQr').classes.has('offline'), true);
  required = false;
  await h.context.refreshMediaState();
  assert.equal(h.element('mobileReconnectQr').classes.has('hidden'), true);
  assert.equal(h.element('mobileReconnectQrImage').src, '');
  assert.equal(h.state.mobileReconnectPairCode, '');
});

test('stopping monitoring invalidates late pair responses without clearing a new request', async () => {
  const oldRequest = deferred(), nextRequest = deferred();
  let requests = 0;
  const h = harness({ api: async () => ++requests === 1 ? oldRequest.promise : nextRequest.promise });
  const oldRun = h.context.ensureMobileReconnectQr();
  h.context.stopMonitoringTimers();
  assert.equal(h.state.mobileReconnectQrGenerating, false);
  assert.equal(h.element('mobileReconnectQr').classes.has('hidden'), true);
  h.state.session = { id: 'session-b', status: 'IN_EXAM' };
  h.state.sessionToken = 'token-b';
  const nextRun = h.context.ensureMobileReconnectQr();
  oldRequest.resolve(h.pair(111111));
  await oldRun;
  assert.equal(h.state.mobileReconnectQrGenerating, true);
  assert.equal(h.state.mobileReconnectPairCode, '');
  assert.equal(h.qrUrls.length, 0);
  nextRequest.resolve(h.pair(222222));
  await nextRun;
  assert.equal(h.state.mobileReconnectPairCode, '222222');
  assert.equal(h.state.mobileReconnectQrGenerating, false);
  assert.deepEqual(h.requests.map(request => request.input.sessionId), ['session-a', 'session-b']);
});

test('late QR creation cannot publish an image after its session changes', async () => {
  const oldImage = deferred();
  let creations = 0;
  const h = harness({ createQr: async () => ++creations === 1 ? oldImage.promise : 'data:new' });
  const oldRun = h.context.ensureMobileReconnectQr();
  await tick();
  h.state.session = { id: 'session-b', status: 'IN_EXAM' };
  await h.context.ensureMobileReconnectQr();
  assert.equal(h.element('mobileReconnectQrImage').src, 'data:new');
  oldImage.resolve('data:old');
  await oldRun;
  assert.equal(h.element('mobileReconnectQrImage').src, 'data:new');
  assert.equal(h.decodedImages.length, 1);
});

test('late image decoding stays off the visible QR and cannot overwrite the next session', async () => {
  const oldDecode = deferred();
  let decodes = 0;
  const h = harness({ decode: async () => { if (++decodes === 1) await oldDecode.promise; } });
  const oldRun = h.context.ensureMobileReconnectQr();
  await tick();
  assert.equal(h.element('mobileReconnectQrImage').src, '');
  h.state.session = { id: 'session-b', status: 'IN_EXAM' };
  await h.context.ensureMobileReconnectQr();
  oldDecode.resolve();
  await oldRun;
  assert.equal(h.element('mobileReconnectQrImage').src, 'data:qr:123457');
  assert.equal(h.state.mobileReconnectPairCode, '123457');
});

test('old media state responses cannot restore a QR after stopping or changing session', async () => {
  const response = deferred();
  const h = harness({ api: async () => response.promise });
  const pending = h.context.refreshMediaState();
  h.context.stopMonitoringTimers();
  h.state.session = { id: 'session-b', status: 'IN_EXAM' };
  response.resolve({ session: { requireSecondCamera: true, lastMiniProgramSeenAt: null } });
  await pending;
  assert.equal(h.element('mobileReconnectQr').classes.has('hidden'), true);
  assert.equal(h.element('mobileReconnectQrTitle').textContent, '第二机位重连');
  assert.equal(h.requests.length, 1);
});

test('out-of-order media state responses cannot undo a newer disabled-camera response', async () => {
  const oldResponse = deferred();
  let requests = 0;
  const h = harness({ api: async () => ++requests === 1 ? oldResponse.promise : { session: { requireSecondCamera: false } } });
  const oldRun = h.context.refreshMediaState();
  await h.context.refreshMediaState();
  oldResponse.resolve({ session: { requireSecondCamera: true } });
  await oldRun;
  assert.equal(h.element('mobileReconnectQr').classes.has('hidden'), true);
  assert.equal(h.requests.length, 2);
});

test('QR expiry follows the server lifetime and elapsed request time despite local clock skew', async () => {
  const h = harness({ api: async () => {
    h.clock.elapsed += 5_000;
    return h.pair();
  } });
  h.clock.wall -= 60 * 60_000;
  await h.context.ensureMobileReconnectQr();
  assert.equal(h.state.mobileReconnectPairExpiresAt, 300_000);
  h.clock.wall += 3 * 60 * 60_000;
  h.clock.elapsed = 269_999;
  await h.context.ensureMobileReconnectQr();
  assert.equal(h.requests.length, 1);
  h.clock.elapsed = 270_001;
  await h.context.ensureMobileReconnectQr();
  assert.equal(h.requests.length, 2);
});

test('expired QR images and codes are removed when replacement fails', async () => {
  let requests = 0;
  const h = harness({ api: async () => {
    if (++requests === 2) throw new Error('offline');
    return h.pair();
  } });
  await h.context.ensureMobileReconnectQr();
  h.clock.elapsed = 300_001;
  await h.context.ensureMobileReconnectQr();
  assert.equal(h.element('mobileReconnectQrImage').src, '');
  assert.equal(h.element('mobileReconnectQrCode').textContent, '------');
  assert.equal(h.state.mobileReconnectPairCode, '');
  assert.equal(h.errors.length, 1);
});

test('concurrent QR checks share the current in-flight request', async () => {
  const response = deferred();
  const h = harness({ api: async () => response.promise });
  const first = h.context.ensureMobileReconnectQr();
  await h.context.ensureMobileReconnectQr();
  assert.equal(h.requests.length, 1);
  response.resolve(h.pair());
  await first;
  assert.equal(h.state.mobileReconnectQrGenerating, false);
});


test('a consumed recovery QR is replaced immediately while the desktop session stays authenticated', async () => {
  let consumed = false;
  const h = harness({ api: async path => path.startsWith('/api/client/media-state')
    ? { session: { requireSecondCamera: true, lastMiniProgramSeenAt: new Date(h.clock.wall).toISOString() },
      recoveryPair: { pairCode: h.state.mobileReconnectPairCode, claimedAt: consumed ? '2026-10-07T08:00:00Z' : null } }
    : h.pair() });
  await h.context.refreshMediaState(); await tick();
  assert.equal(h.state.mobileReconnectPairCode, '123456');
  await h.context.refreshMediaState(); await tick();
  assert.equal(h.qrUrls.length, 1, 'unused codes remain available');
  consumed = true;
  await h.context.refreshMediaState(); await tick();
  assert.equal(h.state.mobileReconnectPairCode, '123457', 'used codes are replaced before their five-minute TTL');
  assert.ok(h.requests.some(item => item.path.includes('recoveryPairCode=123456')));
  assert.equal(h.state.sessionToken, 'token-a');
  assert.equal(h.state.session.id, 'session-a');
});

test('explicit mobile disconnect is shown immediately even with a recent heartbeat', async () => {
  const h = harness({ api: async path => path.startsWith('/api/client/media-state')
    ? { session: { requireSecondCamera: true, lastMiniProgramSeenAt: '2026-10-07T08:00:00Z', miniProgramOfflineAt: '2026-10-07T08:00:00Z' } }
    : h.pair() });
  await h.context.refreshMediaState(); await tick();
  assert.equal(h.element('mobileReconnectQrTitle').textContent, '第二机位已断联');
});
