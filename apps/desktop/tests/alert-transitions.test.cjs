const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const alertSource = source.slice(source.indexOf('async function reportAlert('), source.indexOf('async function runWithButtonBusy('));
const heartbeatSource = source.slice(source.indexOf('function normalizedSecurityList('), source.indexOf('function recordStream('));
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const clock = { now: Date.parse('2026-10-11T01:00:00Z') };
  const state = {
    serverUrl: 'https://api.test', session: { id: 'session-1', status: 'APPROVED' }, sessionToken: 'token',
    desktopInfo: { deviceId: 'desktop' }, requirements: {}, monitoringGeneration: 1,
    baselineFingerprint: 'baseline', heartbeatSnapshot: null, monitoringStarting: true,
    heartbeatSnapshotFreshness: { scope: 'https://api.test:session-1:1', observedAt: clock.now },
    recordingBuffers: new Map(), rtmpStreamingChannels: new Set(), whipStartingChannels: new Set()
  };
  const saved = new Map(), pending = new Map(), requests = [], marks = [], heartbeats = [], scans = [];
  const transport = { online: true, snapshot: {}, scanFailure: false };
  let eventId = 0, timer = 0, flushes = 0;
  const context = vm.createContext({
    saveRendererRecovery: async () => {},
    state, console: { warn() {} }, AbortController,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } },
    lastAlertReports: new Map(), pendingAlertReports: pending, alertRequests: new Set(), evidenceFlushTimers: new Set(),
    ALERT_COOLDOWN_MS: 5 * 60_000,
    window: {
      proctorUploadId: () => `event-${++eventId}`, proctorEvidenceChannel: () => 'DESKTOP_SCREEN',
      setTimeout: () => ++timer, clearTimeout() {},
      proctorApi: { getSecuritySnapshot: async () => {
        scans.push(clock.now);
        if (transport.scanFailure) throw new Error('scan unavailable');
        if (transport.pendingScan) return transport.pendingScan;
        return transport.snapshot;
      }, getPeripheralSnapshot: async () => ({ peripheralScanOk: true, peripheralsFingerprint: transport.snapshot.peripheralsFingerprint || 'stable-usb' }), setWindowMode: async () => {} },
      proctorWindowPolicy: () => ({ mode: 'floating', cheating: false })
    },
    withUploadStore: async (_mode, action) => action({
      put: value => saved.set(value.id, structuredClone(value)), delete: key => saved.delete(key), getAll: () => [...saved.values()]
    }),
    ensureUploadFlushTimer() {}, markRecordingEvent: event => marks.push(event),
    flushRecorders: () => { flushes++; }, flushUploadQueue: async () => {},
    fetchJsonFromRenderer: async (_path, options) => {
      requests.push(JSON.parse(options.body));
      if (!transport.online) throw new Error('offline');
      return {};
    },
    currentServerHosts: () => ['api.test'], errorMessage: error => error.message,
    api: async (_path, options) => { heartbeats.push(JSON.parse(options.body)); return { session: state.session }; },
    examConnection: { connected() {} }, watchScreenControl() {}, startSegmentRecorders() {},
    startRtmpStreams: async () => {}, $: () => ({ classList: { toggle() {} } }), updateLocalPreviews() {}
  });
  vm.runInContext(source.slice(source.indexOf('function isNovaJudgeExam()'), source.indexOf('function contestWebsiteUrl()')), context);
  vm.runInContext(`${alertSource}\n${heartbeatSource}`, context);
  const observe = async snapshot => {
    context.observeSecuritySnapshot(snapshot, { generation: state.monitoringGeneration, sessionId: state.session.id, serverUrl: state.serverUrl });
    await settle();
  };
  return { context, clock, state, transport, saved, pending, requests, marks, heartbeats, scans, observe, flushes: () => flushes };
}

test('continuous process/network anomalies do not repeat after cooldown or list reordering', async () => {
  const h = harness();
  await h.observe({ disallowedProcesses: ['b.exe', 'a.exe', 'a.exe'], networkRemotes: ['b.test', 'a.test'] });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].message, '发现不允许的进程：a.exe、b.exe');
  for (let index = 0; index < 100; index++) {
    h.clock.now += 10_000;
    await h.observe({ disallowedProcesses: ['a.exe', 'b.exe'], networkRemotes: ['a.test', 'b.test'] });
  }
  assert.equal(h.requests.length, 2);
  assert.equal(h.marks.length, 2);
  assert.equal(h.flushes(), 2);
});

test('new members remain in heartbeat details without restarting the ongoing direct-report episode', async () => {
  const h = harness();
  await h.observe({ disallowedProcesses: ['a.exe'], networkRemotes: ['a.test'] });
  h.state.heartbeatSnapshot = { disallowedProcesses: ['new.exe', 'a.exe'], networkRemotes: ['b.test', 'a.test', 'b.test'] };
  await h.observe(h.state.heartbeatSnapshot);
  h.transport.snapshot = h.state.heartbeatSnapshot;
  await h.context.sendHeartbeat(); await settle();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.heartbeats[0].system.processes, ['a.exe', 'new.exe']);
  assert.deepEqual(h.heartbeats[0].system.networkRemotes, ['a.test', 'b.test']);
});

test('real recovery allows a new incident within five minutes, but missing scans never count as recovery', async () => {
  const h = harness();
  await h.observe({ disallowedProcesses: ['a.exe'] });
  await h.observe({});
  await h.observe({ disallowedProcesses: ['a.exe'] });
  assert.equal(h.requests.length, 1);
  for (let i = 0; i <= 6; i++) {
    await h.observe({ disallowedProcesses: [] });
    h.clock.now += 5000;
  }
  await h.observe({ disallowedProcesses: ['a.exe'] });
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[0].eventId, h.requests[1].eventId);
  assert.equal(h.marks.length, 2);
});

test('separate offline incidents preserve both queued event IDs and evidence through retry', async () => {
  const h = harness(); h.transport.online = false;
  await h.observe({ disallowedProcesses: ['a.exe'] });
  for (let i = 0; i <= 6; i++) {
    await h.observe({ disallowedProcesses: [] });
    h.clock.now += 5000;
  }
  await h.observe({ disallowedProcesses: ['a.exe'] });
  assert.equal(h.saved.size, 2);
  assert.equal(h.pending.size, 2);
  const eventIds = h.requests.map(item => item.eventId);
  assert.equal(new Set(eventIds).size, 2);
  h.transport.online = true;
  await h.context.flushPendingAlerts();
  assert.deepEqual(h.requests.slice(2).map(item => item.eventId), eventIds);
  assert.equal(h.saved.size, 0);
  assert.equal(h.pending.size, 0);
  assert.equal(h.marks.length, 2, 'transport retries do not open duplicate recording windows');
});

test('network monitor diagnostics remain one episode through short recoveries or severity downgrades', async () => {
  const h = harness();
  await h.observe({ networkRemotes: ['outside.test'], networkDomainStatus: { state: 'unavailable', message: 'first failure' } });
  assert.equal(h.requests.length, 2);
  h.clock.now += 10 * 60_000;
  await h.observe({ networkRemotes: ['outside.test'], networkDomainStatus: { state: 'unavailable', message: 'new counter in failure message' } });
  assert.equal(h.requests.length, 2);
  await h.observe({ networkDomainStatus: { state: 'ready', message: '' } });
  await h.observe({ networkDomainStatus: { state: 'unavailable', message: 'failed again' } });
  assert.equal(h.requests.length, 2, 'a single ready sample cannot restart the diagnostic incident');
  for (let i = 0; i < 20; i++) {
    h.clock.now += 5000;
    await h.observe({ networkDomainStatus: { state: i % 2 ? 'idle' : 'unavailable', message: `jitter ${i}` } });
  }
  assert.equal(h.requests.length, 2, 'diagnostic severity downgrade/upgrade within one episode does not repeat');
  for (let i = 0; i <= 6; i++) {
    h.clock.now += 5000;
    await h.observe({ networkDomainStatus: { state: 'ready', message: '' } });
  }
  await h.observe({ networkDomainStatus: { state: 'idle', message: 'idle again' } });
  assert.equal(h.requests.length, 3, 'sustained recovery allows a new diagnostic incident');
  await h.observe({ networkDomainStatus: { state: 'unavailable', message: 'capture failed' } });
  assert.equal(h.requests.length, 4, 'severity escalation is immediate');
});

test('ordinary instantaneous alerts retain their existing cooldown', async () => {
  const h = harness();
  assert.equal(await h.context.reportAlert('SCREEN_SWITCH', 4, 'focus lost', true), true);
  assert.equal(await h.context.reportAlert('SCREEN_SWITCH', 4, 'focus lost', true), false);
  h.clock.now += 5 * 60_000;
  assert.equal(await h.context.reportAlert('SCREEN_SWITCH', 4, 'focus lost', true), true);
  assert.equal(h.requests.length, 2);
});

test('initial or failed security scans cannot fabricate healthy arrays', async () => {
  const h = harness(); h.transport.scanFailure = true;
  await h.context.sendHeartbeat(); await settle();
  assert.equal('processes' in h.heartbeats[0].system, false);
  assert.equal('networkRemotes' in h.heartbeats[0].system, false);
  assert.equal('vmSignals' in h.heartbeats[0].system, false);
  assert.equal(h.heartbeats[0].system.peripheralsFingerprint, undefined, 'initial USB observation cannot fabricate the login baseline');
  h.state.heartbeatSnapshot = { disallowedProcesses: ['a.exe'], networkRemotes: ['a.test'], vmSignals: ['hypervisor'] };
  h.clock.now += 5000;
  await h.context.sendHeartbeat(); await settle();
  assert.equal('processes' in h.heartbeats[1].system, false, 'a failed scan invalidates even a previously cached result');
  assert.deepEqual(h.state.heartbeatSnapshot.disallowedProcesses, ['a.exe']);
});

test('a single healthy snapshot stops confirming recovery immediately after subsequent scan failures', async () => {
  const h = harness();
  h.transport.snapshot = { disallowedProcesses: [], networkRemotes: [], vmSignals: [], peripheralsFingerprint: 'stable-usb' };
  await h.context.sendHeartbeat(); await settle();
  h.clock.now += 1000;
  await h.context.sendHeartbeat(); await settle();
  assert.deepEqual(h.heartbeats.at(-1).system.processes, []);
  h.transport.scanFailure = true;
  h.clock.now += 4000;
  await h.context.sendHeartbeat(); await settle();
  for (const advance of [1000, 5000, 5000]) {
    h.clock.now += advance;
    await h.context.sendHeartbeat(); await settle();
    const system = h.heartbeats.at(-1).system;
    for (const field of ['processes', 'networkRemotes', 'vmSignals']) assert.equal(field in system, false);
    assert.equal(system.peripheralsFingerprint, 'stable-usb');
  }
  assert.equal(h.heartbeats.length, 6, 'unknown OS diagnostics never block the online heartbeat');
  assert.equal(h.requests.length, 0);
  h.transport.scanFailure = false;
  h.clock.now += 5000;
  await h.context.sendHeartbeat(); await settle();
  h.clock.now += 1000;
  await h.context.sendHeartbeat(); await settle();
  assert.deepEqual(h.heartbeats.at(-1).system.processes, [], 'a new successful scan can confirm healthy state again');
  assert.deepEqual(h.heartbeats.at(-1).system.networkRemotes, []);
  assert.deepEqual(h.heartbeats.at(-1).system.vmSignals, []);
});

test('a stalled scan expires cached healthy arrays before the ten-second recovery window', async () => {
  const h = harness();
  h.transport.snapshot = { disallowedProcesses: [], networkRemotes: [], vmSignals: [], peripheralsFingerprint: 'stable-usb' };
  await h.context.sendHeartbeat(); await settle();
  let finishScan;
  h.transport.pendingScan = new Promise(resolve => { finishScan = resolve; });
  const scanCompletedAt = h.clock.now;
  h.clock.now = scanCompletedAt + 5000;
  await h.context.sendHeartbeat(); await settle();
  assert.deepEqual(h.heartbeats.at(-1).system.processes, [], 'normal five-second scan cadence remains valid');
  for (const elapsed of [7500, 10000, 15000]) {
    h.clock.now = scanCompletedAt + elapsed;
    await h.context.sendHeartbeat(); await settle();
    const system = h.heartbeats.at(-1).system;
    for (const field of ['processes', 'networkRemotes', 'vmSignals']) assert.equal(field in system, false);
    assert.equal(system.peripheralsFingerprint, 'stable-usb');
  }
  assert.equal(h.scans.length, 2, 'a pending scan is never duplicated');
  assert.equal(h.requests.length, 0);
  finishScan({ disallowedProcesses: ['new.exe'], networkRemotes: [], vmSignals: [], peripheralsFingerprint: 'stable-usb' });
  await settle();
  h.transport.pendingScan = null;
  h.transport.snapshot = { disallowedProcesses: ['new.exe'], networkRemotes: [], vmSignals: [] };
  await h.context.sendHeartbeat(); await settle();
  assert.deepEqual(h.heartbeats.at(-1).system.processes, ['new.exe']);
  assert.equal(h.requests.length, 1, 'a real new observation still records its incident and evidence');
});

test('reusing an expired abnormal snapshot cannot create a direct alert or leak observations across generations', async () => {
  const h = harness();
  h.state.heartbeatSnapshot = { disallowedProcesses: ['stale.exe'], networkRemotes: ['stale.test'], vmSignals: ['stale-vm'], peripheralsFingerprint: 'stable-usb' };
  h.transport.pendingScan = new Promise(() => {});
  h.clock.now += 7500;
  await h.context.sendHeartbeat(); await settle();
  for (const field of ['processes', 'networkRemotes', 'vmSignals']) assert.equal(field in h.heartbeats.at(-1).system, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.marks.length, 0);
  h.state.heartbeatSnapshotFreshness = { scope: 'https://api.test:session-1:1', observedAt: h.clock.now };
  h.state.monitoringGeneration = 2;
  await h.context.sendHeartbeat(); await settle();
  assert.equal('processes' in h.heartbeats.at(-1).system, false, 'another generation cannot reuse even a recently timestamped observation');
  assert.equal(h.heartbeats.at(-1).system.peripheralsFingerprint, undefined, 'USB observations cannot cross monitoring generations');
});

test('two-second reconnect heartbeats keep flowing without accelerating full OS scans', async () => {
  const h = harness();
  for (const elapsed of [0, 2000, 4000, 5000, 6000, 8000, 10000]) {
    h.clock.now = Date.parse('2026-10-11T01:00:00Z') + elapsed;
    await h.context.sendHeartbeat(); await settle();
  }
  assert.equal(h.heartbeats.length, 7);
  assert.equal(h.scans.length, 3);
  assert.deepEqual(h.scans.map(time => time - h.scans[0]), [0, 5000, 10000]);
  h.state.monitoringGeneration++;
  await h.context.sendHeartbeat(); await settle();
  assert.equal(h.scans.length, 4, 'a new monitoring generation must get a fresh scan immediately');
});

test('observation state does not suppress incidents in a different session', async () => {
  const h = harness();
  await h.observe({ disallowedProcesses: ['a.exe'] });
  h.state.session = { id: 'session-2', status: 'APPROVED' };
  await h.observe({ disallowedProcesses: ['a.exe'] });
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests.map(item => item.sessionId), ['session-1', 'session-2']);
});


test('short process recoveries and missing or widely separated healthy scans never restart an episode', async () => {
  const h = harness();
  await h.observe({ disallowedProcesses: ['a.exe'] });
  for (let i = 0; i < 10; i++) {
    for (let tick = 0; tick < 3; tick++) {
      h.clock.now += 5000;
      await h.observe({ disallowedProcesses: [] });
    }
    h.clock.now += 5000;
    await h.observe({ disallowedProcesses: ['a.exe'] });
  }
  assert.equal(h.requests.length, 1, 'ten-second recovery flicker cannot create direct-report and recording storms');
  await h.observe({ disallowedProcesses: [] });
  h.clock.now += 60_000;
  await h.observe({ disallowedProcesses: [] });
  await h.observe({ disallowedProcesses: ['a.exe'] });
  assert.equal(h.requests.length, 1, 'silence is not continuous recovery');
  for (let tick = 0; tick < 6; tick++) { h.clock.now += 5000; await h.observe({ disallowedProcesses: [] }); }
  await h.observe({});
  h.clock.now += 5000;
  await h.observe({ disallowedProcesses: [] });
  await h.observe({ disallowedProcesses: ['a.exe'] });
  assert.equal(h.requests.length, 1, 'unknown sampling breaks the recovery run');
});
