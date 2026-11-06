const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const heartbeat = source.slice(source.indexOf('function normalizedSecurityList('), source.indexOf('function recordStream('));
const acceptSession = source.slice(source.indexOf('function acceptSessionSnapshot('), source.indexOf('function clientAuthHeaders('));
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function harness(snapshot) {
  const state = { serverUrl: 'https://api.test', session: { id: 's1', status: 'APPROVED' }, desktopInfo: { deviceId: 'desktop' },
    requirements: {}, monitoringGeneration: 1, baselineFingerprint: 'baseline', heartbeatSnapshot: snapshot,
    heartbeatSnapshotFreshness: { scope: 'https://api.test:s1:1', observedAt: Date.now() },
    peripheralSnapshot: snapshot ? { ...snapshot, peripheralScanOk: Boolean(snapshot.peripheralsFingerprint), scope: 'https://api.test:s1:1', observedAt: Date.now() } : null,
    monitoringStarting: true, recordingBuffers: new Map(), rtmpStreamingChannels: new Set(), whipStartingChannels: new Set() };
  const scan = deferred(), peripherals = deferred(), alerts = deferred(), calls = [], reported = [];
  const responseSession = { current: null };
  const saveRendererRecovery = async () => {};
  const element = { classList: { toggle() {} } };
  const environment = { state, URL, console: { warn() {} }, window: { proctorApi: { getSecuritySnapshot: () => scan.promise, getPeripheralSnapshot: () => peripherals.promise, setWindowMode: async () => {} },
    proctorWindowPolicy: () => ({ mode: 'floating', cheating: false }) },
    saveRendererRecovery, currentServerHosts: () => ['api.test'], errorMessage: error => error.message,
    reportAlert: (...args) => { reported.push(args); return alerts.promise; }, lastNetworkCaptureStatus: '',
    api: async (_path, options) => { calls.push(JSON.parse(options.body)); return { session: responseSession.current || state.session }; },
    examConnection: { connected() {} }, flushUploadQueue: async () => {}, markRecordingEvent() {}, watchScreenControl() {},
    startSegmentRecorders() {}, startRtmpStreams: async () => {}, $: () => element, updateLocalPreviews() {},
  };
  const context = vm.createContext(environment);
  vm.runInContext(acceptSession, context);
  vm.runInContext(source.slice(source.indexOf('function isNovaJudgeExam()'), source.indexOf('function contestWebsiteUrl()')), context);
  vm.runInContext(heartbeat, context);
  return { context, state, scan, peripherals, calls, reported, responseSession };
}

for (const invalidation of ['session', 'generation', 'finished']) {
  for (const clockFails of [false, true]) {
    test(`a ${clockFails ? 'failed' : 'successful'} delayed Reaction clock response cannot cross ${invalidation} changes`, async () => {
      const h = harness(null), clock = deferred();
      const originalSession = h.state.session;
      const requirements = { reactionEnabled: false, requireFrontCamera: false };
      h.state.requirements = requirements;
      h.state.sessionToken = 'current-token';
      let clockRequested = false, previews = 0, recorders = 0, evidenceEvents = 0;
      h.context.api = async path => {
        if (path === '/api/client/time') { clockRequested = true; return clock.promise; }
        assert.equal(path, '/api/client/heartbeat');
        return { session: originalSession, requirements: { reactionEnabled: true, requireFrontCamera: true },
          desktopSessionToken: 'obsolete-token', recordingEvents: [{ id: 'obsolete-event' }] };
      };
      h.context.updateLocalPreviews = () => previews++;
      h.context.startSegmentRecorders = () => recorders++;
      h.context.markRecordingEvent = () => evidenceEvents++;
      const sending = h.context.sendHeartbeat();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(clockRequested, true);
      if (invalidation === 'session') h.state.session = { id: 's2', status: 'APPROVED' };
      if (invalidation === 'generation') h.state.monitoringGeneration++;
      if (invalidation === 'finished') h.state.finishedScreenVisible = true;
      const expectedSession = h.state.session;
      const nextClock = { clockOffsetMs: 25, clockUncertaintyMs: 10 };
      h.state.reactionClock = nextClock;
      if (clockFails) clock.reject(new Error('clock unavailable'));
      else clock.resolve({ serverTime: Date.now() });
      await sending;
      assert.equal(h.state.session, expectedSession);
      assert.equal(h.state.requirements, requirements, 'stale requirements cannot change recording policy');
      assert.equal(h.state.reactionClock, nextClock, 'stale clock samples cannot replace the current session clock');
      assert.equal(h.state.sessionToken, 'current-token');
      assert.equal(previews, 0);
      assert.equal(recorders, 0);
      assert.equal(evidenceEvents, 0);
    });
  }
}

test('USB changes remain reportable while the unrelated full security scan is stalled', async () => {
  const h = harness(null);
  await h.context.sendHeartbeat();
  assert.equal(h.calls[0].system.peripheralScanOk, undefined, 'the first pending observation has a short grace period');
  h.peripherals.resolve({ peripheralScanOk: true, peripheralsFingerprint: 'new-usb' });
  await new Promise(resolve => setImmediate(resolve));
  await h.context.sendHeartbeat();
  assert.equal(h.calls[1].system.peripheralScanOk, true);
  assert.equal(h.calls[1].system.peripheralsFingerprint, 'new-usb');
  assert.equal(h.state.heartbeatSnapshot, null, 'the full scan is still pending');
});

test('failed and stale USB probes explicitly report unavailable and never replay the baseline', async () => {
  for (const failure of ['rejected', 'unavailable', 'expired']) {
    const h = harness({ peripheralsFingerprint: 'old-usb' });
    await h.context.sendHeartbeat();
    if (failure === 'rejected') h.peripherals.reject(new Error('probe unavailable'));
    if (failure === 'unavailable') h.peripherals.resolve({ peripheralScanOk: false });
    if (failure === 'expired') {
      h.state.peripheralSnapshot.observedAt -= 8000;
      h.state.peripheralSnapshotSchedule.startedAt -= 8000;
    }
    await new Promise(resolve => setImmediate(resolve));
    await h.context.sendHeartbeat();
    assert.equal(h.calls.at(-1).system.peripheralScanOk, false, failure);
    assert.equal(h.calls.at(-1).system.peripheralsFingerprint, undefined, failure);
    assert.equal(h.state.baselineFingerprint, 'baseline');
  }
});

test('a delayed heartbeat starts a fresh USB probe without mistaking its previous success for a probe failure', async () => {
  const h = harness({ peripheralsFingerprint: 'old-usb' });
  // Simulate a ten-second API response or blocked heartbeat tick. No new USB
  // probe has failed: the next heartbeat is just starting the fresh read.
  h.state.peripheralSnapshot.observedAt -= 10_000;
  await h.context.sendHeartbeat();
  assert.equal(h.calls[0].system.peripheralScanOk, undefined);
  assert.equal(h.calls[0].system.peripheralsFingerprint, undefined);
  h.peripherals.resolve({ peripheralScanOk: true, peripheralsFingerprint: 'current-usb' });
  await new Promise(resolve => setImmediate(resolve));
  await h.context.sendHeartbeat();
  assert.equal(h.calls[1].system.peripheralScanOk, true);
  assert.equal(h.calls[1].system.peripheralsFingerprint, 'current-usb');
});

test('a pending retry cannot give an explicit USB failure a new grace period', async () => {
  const h = harness({ peripheralsFingerprint: 'old-usb' });
  h.state.peripheralSnapshot.peripheralScanOk = false;
  h.state.peripheralSnapshot.observedAt -= 10_000;
  await h.context.sendHeartbeat();
  assert.equal(h.calls[0].system.peripheralScanOk, false);
  assert.equal(h.calls[0].system.peripheralsFingerprint, undefined);
});

test('a hung initial USB probe fails closed after the grace period and cannot cross sessions', async () => {
  const h = harness(null);
  await h.context.sendHeartbeat();
  h.state.peripheralSnapshotSchedule.startedAt -= 8000;
  await h.context.sendHeartbeat();
  assert.equal(h.calls.at(-1).system.peripheralScanOk, false);
  h.state.monitoringGeneration++;
  h.state.session = { id: 'next-session', status: 'APPROVED' };
  h.peripherals.resolve({ peripheralScanOk: true, peripheralsFingerprint: 'old-session-usb' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.peripheralSnapshot, null);
});
test('slow OS scans and pending alert uploads cannot delay an online heartbeat', async () => {
  const h = harness({ peripheralsFingerprint: 'changed', disallowedProcesses: ['fixture.exe'], networkRemotes: ['outside.test'], vmSignals: [] });
  await h.context.sendHeartbeat();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].system.processes, ['fixture.exe']);
  assert.equal(h.calls[0].capture, undefined, 'initial device setup does not trigger premature capture lockdown');
  assert.equal(h.state.session.status, 'APPROVED');
});
test('late device scan results cannot replace the next session diagnostics', async () => {
  const h = harness(null); await h.context.sendHeartbeat();
  h.state.monitoringGeneration++; h.state.session = { id: 's2', status: 'APPROVED' };
  h.scan.resolve({ peripheralsFingerprint: 'old-session' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.heartbeatSnapshot, null);
  assert.equal(h.state.heartbeatSnapshotRequest, null);
});

test('USB comparison is sent through the heartbeat without a racing direct alert', async () => {
  const current = `mac-usb-v3:${'b'.repeat(64)}`;
  const h = harness({ peripheralsFingerprint: current });
  h.state.baselineFingerprint = `mac-usb-v2:${'a'.repeat(64)}`;
  h.responseSession.current = { ...h.state.session, peripheralsBaselineFingerprint: current, lockdown: false };
  await h.context.sendHeartbeat();
  assert.equal(h.calls[0].system.peripheralsFingerprint, current);
  assert.equal(h.reported.some(([type]) => type === 'PERIPHERAL_CHANGED'), false);
  assert.equal(h.state.baselineFingerprint, current, 'an accepted format migration is synchronized without a lock transition');
});

test('a proctor unlock between heartbeat responses synchronizes the accepted USB baseline', async () => {
  const accepted = `usb-v3:${'b'.repeat(64)}`;
  const h = harness({ peripheralsFingerprint: accepted });
  h.state.baselineFingerprint = `usb-v3:${'a'.repeat(64)}`;
  h.state.session.lockdown = false;
  h.responseSession.current = { ...h.state.session, peripheralsBaselineFingerprint: accepted, unlockNonce: 'new-unlock', lockdown: false };
  await h.context.sendHeartbeat();
  assert.equal(h.state.baselineFingerprint, accepted);
  await h.context.sendHeartbeat();
  assert.equal(h.calls.length, 2);
  assert.equal(h.reported.some(([type]) => type === 'PERIPHERAL_CHANGED'), false);
});

test('missing scan fingerprints do not create local USB alerts or erase the accepted baseline', async () => {
  for (const peripheralsFingerprint of [undefined, '']) {
    const h = harness({ peripheralsFingerprint });
    await h.context.sendHeartbeat();
    assert.equal(h.reported.some(([type]) => type === 'PERIPHERAL_CHANGED'), false);
    assert.equal(h.state.baselineFingerprint, 'baseline');
  }
});

test('heartbeat begins while screen capture is still opening', async () => {
  const calls = [], capture = deferred();
  const state = { session: { id: 's' }, requirements: {}, monitoringGeneration: 0 };
  const context = vm.createContext({ state, saveRendererRecovery: async () => {}, watchScreenControl() {}, updateLocalPreviews() {},
    startHeartbeat: async () => { calls.push('heartbeat'); state.heartbeatTimer = 1; },
    ensureScreenCapture: () => { calls.push('screen'); return capture.promise; }
  });
  const start = source.indexOf('async function startSubmittedMonitoring(');
  vm.runInContext(acceptSession, context);
  vm.runInContext(source.slice(start, source.indexOf('function resetWaitingLogin(', start)), context);
  void context.startSubmittedMonitoring(state.session, state.requirements);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['heartbeat', 'screen']);
  assert.equal(state.heartbeatTimer, 1);
});
