const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
function between(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

function mediaContext({ camera = true, microphone = true, screen = true } = {}) {
  const state = {
    systemReady: true, mediaProbeResults: {},
    verifiedSystemStatus: { scope: 'setup', permissions: {}, capabilities: { vmSignals: [] } }
  };
  const checks = [], probes = [];
  const context = {
    state, permissionContextKey: () => 'setup', stopStream() {}, updateLocalPreviews() {}, updateSetupButtons() {},
    setCheck: (...args) => checks.push(args),
    probeScreenCaptureFrame: async () => ({ ok: screen }),
    probeMediaDevice: async target => {
      probes.push(target);
      const ok = target === 'camera' ? camera : microphone;
      state.mediaProbeResults[target] = { ok };
      if (!ok) throw new Error(`${target} unavailable`);
    },
    refreshPermissionCards: async () => {},
  };
  vm.runInNewContext(between('async function detectMedia(', 'async function requestDesktopPair('), context);
  return { context, state, checks, probes };
}

test('preflight keeps missing-device results truthful and allows login with a working screen', async () => {
  const { context, state, checks, probes } = mediaContext({ camera: false, microphone: false });
  assert.equal(await context.detectMedia(), true);
  assert.equal(state.mediaReady, true);
  assert.equal(state.mediaProbeResults.camera.ok, false);
  assert.equal(state.mediaProbeResults.microphone.ok, false);
  assert.deepEqual(probes, ['camera', 'microphone']);
  assert.match(checks.find(([id, ok]) => id === 'cameraCheck' && ok === true)[2], /已跳过/);
});

test('screen failures still block preflight regardless of optional device availability', async () => {
  for (const failure of [{ screen: false }, { screen: false, microphone: false, camera: false }]) {
    const { context, state } = mediaContext(failure);
    assert.equal(await context.detectMedia(), false);
    assert.equal(state.mediaReady, false);
  }
});

test('missing, denied and busy front cameras are skipped without a blocking error', async () => {
  for (const name of ['NotFoundError', 'NotAllowedError', 'NotReadableError']) {
    const state = { session: { id: 's' }, requirements: { requireFrontCamera: true }, monitoringGeneration: 1 };
    const checks = [];
    const context = {
      state, performance: { now: () => 100 }, cameraCaptureLive: () => false,
      stopStream() {}, updateLocalPreviews() {}, captureProfile: {},
      tryScreenCapture: (_label, capture) => capture(),
      navigator: { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error(name), { name }); } } },
      setCheck: (...args) => checks.push(args), errorMessage: String, console: { warn() {} },
      showError() { assert.fail('Optional camera must not show a blocking error'); },
    };
    vm.runInNewContext(between('async function acquireCameraCapture(', 'function setActionVisibility('), context);
    assert.equal(await context.acquireCameraCapture(1), false);
    assert.equal(state.cameraStream, null);
    assert.equal(state.cameraCaptureRetryAt, 15100);
    assert.match(checks[0][2], /跳过/);
  }
});

test('an available camera is previewed and the optional startup publishes it', async () => {
  const stream = { getVideoTracks: () => [{ readyState: 'live' }] };
  const state = { session: { id: 's' }, requirements: { requireFrontCamera: true }, monitoringGeneration: 1 };
  let previews = 0, recorders = 0, publishers = 0;
  const context = {
    state, performance: { now: () => 100 }, cameraCaptureLive: () => false,
    stopStream() {}, updateLocalPreviews: () => previews++, captureProfile: {},
    tryScreenCapture: (_label, capture) => capture(),
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    setCheck() {}, errorMessage: String, console,
    startSegmentRecorders: () => recorders++, startRtmpStreams: () => publishers++,
  };
  vm.runInNewContext(between('async function startOptionalCameraCapture(', 'function setActionVisibility('), context);
  context.ensureCameraCapture = () => context.acquireCameraCapture(1);
  await context.startOptionalCameraCapture();
  assert.equal(state.cameraStream, stream);
  assert.equal(previews, 2);
  assert.equal(recorders, 1);
  assert.equal(publishers, 1);
});

test('a delayed optional capture cannot publish into a replaced session', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const context = {
    state: { session: { id: 'old' }, monitoringGeneration: 1 },
    ensureCameraCapture: () => pending,
    startSegmentRecorders() { assert.fail('stale recording'); },
    startRtmpStreams() { assert.fail('stale publisher'); }, console, errorMessage: String,
  };
  vm.runInNewContext(between('async function startOptionalCameraCapture(', 'async function acquireCameraCapture('), context);
  const result = context.startOptionalCameraCapture();
  context.state.session = { id: 'new' };
  context.state.monitoringGeneration++;
  resolve(true);
  await result;
});

test('opening an optional camera never holds up screen publishing or monitoring startup', async () => {
  const state = { session: { id: 's' }, requirements: { requireFrontCamera: true }, monitoringGeneration: 0 };
  const calls = [];
  const context = {
    state, window: {}, acceptSessionSnapshot: session => { state.session = session; },
    saveRendererRecovery: async () => {}, watchScreenControl() {}, updateLocalPreviews() {},
    startHeartbeat: async () => calls.push('heartbeat'), ensureScreenCapture: async () => true,
    startOptionalCameraCapture: () => { calls.push('camera'); return new Promise(() => {}); },
    startSegmentRecorders: () => calls.push('record'), startRtmpStreams: () => calls.push('publish'),
    screenCaptureLive: () => true, cameraCaptureLive: () => false, setCheck() {},
  };
  vm.runInNewContext(between('async function startSubmittedMonitoring(', 'function resetWaitingLogin('), context);
  const completed = context.startSubmittedMonitoring(state.session, state.requirements);
  // Let the real startup complete while camera authorization remains pending.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['heartbeat', 'camera', 'record', 'publish']);
  assert.equal(state.monitoringStarting, false);
  await completed;
});

test('the camera permission card is optional without pretending permission was granted', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/permission-state.js'), 'utf8'), context);
  const rows = context.proctorPermissionRows({}, {}, { camera: false });
  const camera = rows.find(row => row.key === 'camera');
  assert.equal(camera.optional, true);
  assert.equal(camera.granted, false);
  assert.equal(camera.label, '未启用');
  assert.equal(rows.find(row => row.key === 'microphone').optional, true);
});
