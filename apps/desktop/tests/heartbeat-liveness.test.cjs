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
    heartbeatSnapshotFreshness: { scope: 'https://api.test:s1:1', observedAt: performance.now() },
    peripheralSnapshot: snapshot ? { ...snapshot, peripheralScanOk: Boolean(snapshot.peripheralsFingerprint), scope: 'https://api.test:s1:1', observedAt: performance.now() } : null,
    monitoringStarting: true, recordingBuffers: new Map(), rtmpStreamingChannels: new Set(), whipStartingChannels: new Set() };
  const scan = deferred(), peripherals = deferred(), alerts = deferred(), calls = [], reported = [];
  const responseSession = { current: null };
  const saveRendererRecovery = async () => {};
  const element = { classList: { toggle() {} } };
  const environment = { state, URL, TextEncoder, performance, console: { warn() {} }, window: { proctorApi: { getSecuritySnapshot: () => scan.promise, getPeripheralSnapshot: () => peripherals.promise, setWindowMode: async () => {} },
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

for (const invalidation of ['session', 'generation', 'finished', 'credentials']) {
  for (const clockFails of [false, true]) {
    test(`a ${clockFails ? 'failed' : 'successful'} delayed Reaction clock response cannot cross ${invalidation} changes`, async () => {
      const h = harness(null), clock = deferred();
      const lockedSession = { ...h.state.session, status: 'LOCKED', lockdown: true, lockdownReason: '检测到 USB 外设接入' };
      h.state.requirements = { reactionEnabled: false, requireFrontCamera: false };
      h.state.sessionToken = 'current-token';
      let clockRequested = false, previews = 0, recorders = 0, evidenceEvents = 0;
      h.context.api = async path => {
        if (path === '/api/client/time') { clockRequested = true; return clock.promise; }
        assert.equal(path, '/api/client/heartbeat');
        return { session: lockedSession, requirements: { reactionEnabled: true, requireFrontCamera: true },
          recordingEvents: [{ id: 'handled-event' }] };
      };
      h.context.updateLocalPreviews = () => previews++;
      h.context.startSegmentRecorders = () => recorders++;
      h.context.markRecordingEvent = () => evidenceEvents++;
      const modes = [];
      h.context.window.proctorApi.setWindowMode = async mode => modes.push(mode);
      h.context.window.proctorWindowPolicy = session => ({ mode: session?.lockdown ? 'locked' : 'floating', cheating: false });
      h.context.closeStartConfirmation = () => {};
      h.context.scheduleWindowModeCaptureRecovery = () => {};
      await h.context.sendHeartbeat();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(clockRequested, true);
      assert.deepEqual(modes, ['locked'], 'clock request must not delay applying a lock');
      assert.equal(h.state.session.status, 'LOCKED');
      if (invalidation === 'session') h.state.session = { id: 's2', status: 'APPROVED' };
      if (invalidation === 'generation') h.state.monitoringGeneration++;
      if (invalidation === 'finished') h.state.finishedScreenVisible = true;
      if (invalidation === 'credentials') h.state.sessionToken = 'replacement-token';
      const expectedSession = h.state.session;
      const requirements = h.state.requirements;
      const expectedToken = h.state.sessionToken;
      const nextClock = { clockOffsetMs: 25, clockUncertaintyMs: 10 };
      h.state.reactionClock = nextClock;
      if (clockFails) clock.reject(new Error('clock unavailable'));
      else clock.resolve({ serverTime: Date.now() });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.state.session, expectedSession);
      assert.equal(h.state.requirements, requirements, 'stale requirements cannot change recording policy');
      assert.equal(h.state.reactionClock, nextClock, 'stale clock samples cannot replace the current session clock');
      assert.equal(h.state.sessionToken, expectedToken);
      assert.equal(previews, 1);
      assert.equal(recorders, 1);
      assert.equal(evidenceEvents, 1);
    });
  }
}

test('Reaction clock sampling retries after a local clock change and reuses a recent good sample', async () => {
  const h = harness(null);
  h.state.requirements = { reactionEnabled: true, requireFrontCamera: true };
  let elapsed = 10_000, wall = 50_000, requests = 0;
  let sample = deferred();
  h.context.performance = { now: () => elapsed };
  h.context.Date = class extends Date { static now() { return wall; } };
  const send = h.context.api;
  h.context.api = (path, options) => {
    if (path !== '/api/client/time') return send(path, options);
    requests++;
    return sample.promise;
  };
  await h.context.sendHeartbeat();
  elapsed += 100;
  wall += 5_000;
  sample.resolve({ serverTime: 50_500 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.reactionClock, undefined);

  sample = deferred();
  await h.context.sendHeartbeat();
  elapsed += 100;
  wall += 100;
  sample.resolve({ serverTime: 55_500 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.reactionClock.clockOffsetMs, 450);
  assert.equal(h.state.reactionClock.clockUncertaintyMs, 50);
  await h.context.sendHeartbeat();
  assert.equal(requests, 2);
});

test('large Unicode USB queues are drained in ordered batches without exceeding the heartbeat limit', async () => {
  const h = harness({ peripheralsFingerprint: 'stable' });
  const scope = 'https://api.test:s1:1';
  const events = Array.from({ length: 64 }, (_, index) => ({ id: String(index), action: 'INSERT',
    deviceId: `USB\\VID_1234&PID_5678\\${'设备'.repeat(900)}` }));
  h.state.usbEventSnapshot = { scope, events };
  h.state.heartbeatSnapshot = {
    activeWindow: '测'.repeat(900),
    disallowedProcesses: Array.from({ length: 60 }, (_, index) => `进程${index}${'测'.repeat(500)}`),
  };
  const sent = [];
  h.context.api = async (_path, { body }) => {
    assert.ok(Buffer.byteLength(body) <= 64 * 1024);
    const { system } = JSON.parse(body);
    const batch = system.peripheralEvents.map(event => event.id);
    assert.ok(batch.length > 0);
    assert.equal(system.processes.length, 16);
    assert.ok(system.processes.every(process => process.length <= 128));
    sent.push(...batch);
    return { session: h.state.session, acceptedPeripheralEventIds: batch };
  };
  for (let tick = 0; h.state.usbEventSnapshot.events.length && tick < 64; tick++) await h.context.sendHeartbeat();
  assert.deepEqual(sent, events.map(event => event.id));
});

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

test('a stalled USB event read or acknowledgement does not hold the heartbeat or invalidate the fingerprint', async () => {
  const h = harness({ peripheralsFingerprint: 'stable' });
  const read = deferred();
  const acknowledge = deferred();
  const event = { id: 'confirmed-usb-change' };
  let reads = 0;
  let acknowledged = false;
  h.context.window.proctorApi.readUsbEvents = () => { reads++; return read.promise; };
  h.context.window.proctorApi.acknowledgeUsbEvents = () => { acknowledged = true; return acknowledge.promise; };
  const send = h.context.api;
  h.context.api = async (...args) => {
    const result = await send(...args);
    if (h.calls.at(-1).system.peripheralEvents?.length) result.acceptedPeripheralEventIds = [event.id];
    return result;
  };
  await h.context.sendHeartbeat();
  await h.context.sendHeartbeat();
  assert.equal(reads, 1);
  assert.equal(h.calls[1].system.peripheralsFingerprint, 'stable');
  read.resolve({ available: false, events: [event] });
  await new Promise(resolve => setImmediate(resolve));
  await h.context.sendHeartbeat();
  assert.equal(h.calls[2].system.peripheralScanOk, true);
  assert.deepEqual(h.calls[2].system.peripheralEvents, [event]);
  assert.equal(acknowledged, true);
});

test('unlock invalidates cached peripheral observations until a fresh scan completes', async () => {
  const h = harness({ peripheralsFingerprint: 'before-unlock' });
  await h.context.sendHeartbeat();
  const unlockNonce = 'ba599c6d-edd7-4227-8326-abf53432e457';
  h.state.session = { ...h.state.session, unlockNonce };
  h.peripherals.resolve({ peripheralScanOk: true, peripheralsFingerprint: 'before-unlock' });
  await new Promise(resolve => setImmediate(resolve));
  const fresh = deferred();
  h.context.window.proctorApi.getPeripheralSnapshot = () => fresh.promise;
  await h.context.sendHeartbeat();
  assert.equal(h.calls[1].system.peripheralUnlockNonce, unlockNonce);
  assert.equal(h.calls[1].system.peripheralsFingerprint, undefined);
  fresh.resolve({ peripheralScanOk: true, peripheralsFingerprint: 'after-unlock' });
  await new Promise(resolve => setImmediate(resolve));
  await h.context.sendHeartbeat();
  assert.equal(h.calls[2].system.peripheralsFingerprint, 'after-unlock');
});

test('the USB event epoch is based on physical observation, rather than read completion', async () => {
  const h = harness(null);
  const unlockNonce = 'ba599c6d-edd7-4227-8326-abf53432e457';
  let now = 1000;
  h.context.performance = { now: () => now };
  h.context.acceptSessionSnapshot({ ...h.state.session, unlockNonce });
  const read = deferred();
  h.context.window.proctorApi.readUsbEvents = () => read.promise;
  now = 2200;
  await h.context.sendHeartbeat();
  now = 8500;
  read.resolve({ events: [{ id: 'older', observedAgeMs: 1800 }, { id: 'newer', observedAgeMs: 400 }, { id: 'legacy' }] });
  await new Promise(resolve => setImmediate(resolve));
  await h.context.sendHeartbeat();
  assert.deepEqual(h.calls[1].system.peripheralEvents, [
    { id: 'older', unlockNonce: null }, { id: 'newer', unlockNonce }, { id: 'legacy' }
  ]);
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

test('local wall-clock changes do not keep stale USB snapshots fresh or skip retry cadence', async () => {
  const h = harness(null);
  let elapsed = 10_000, wall = Date.now();
  h.context.performance = { now: () => elapsed };
  h.context.Date = class extends Date { static now() { return wall; } };
  await h.context.sendHeartbeat();
  h.peripherals.resolve({ peripheralScanOk: true, peripheralsFingerprint: 'first-sample' });
  await new Promise(resolve => setImmediate(resolve));
  wall += 5 * 60_000;
  await h.context.sendHeartbeat();
  assert.equal(h.calls.at(-1).system.peripheralsFingerprint, 'first-sample');

  wall -= 10 * 60_000;
  elapsed += 8_000;
  const fresh = deferred();
  h.context.window.proctorApi.getPeripheralSnapshot = () => fresh.promise;
  await h.context.sendHeartbeat();
  assert.equal(h.calls.at(-1).system.peripheralScanOk, undefined);
  assert.equal(h.calls.at(-1).system.peripheralsFingerprint, undefined);
  fresh.resolve({ peripheralScanOk: true, peripheralsFingerprint: 'updated-sample' });
  await new Promise(resolve => setImmediate(resolve));
  await h.context.sendHeartbeat();
  assert.equal(h.calls.at(-1).system.peripheralsFingerprint, 'updated-sample');
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
