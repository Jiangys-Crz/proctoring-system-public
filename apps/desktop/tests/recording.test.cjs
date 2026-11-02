const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const renderer = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const controllerSource = fs.readFileSync(require.resolve('../src/renderer/recording-controller.js'), 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function recordingHarness(onSave) {
  const timers = new Map();
  const instances = [];
  let timerId = 0;
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'video/webm'; instances.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      assert.equal(this.state, 'recording');
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob([`segment-${instances.indexOf(this)}`]) });
        this.onstop();
      });
    }
  }
  const context = vm.createContext({
    MediaRecorder: Recorder, Blob, crypto: { randomUUID },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(controllerSource, context);
  const errors = [];
  const options = {
    channel: 'DESKTOP_SCREEN', sessionId: 'session-a', stream: { active: true },
    isActive: () => true, getContext: () => ({ sessionToken: 'token-a', serverUrl: 'https://exam.test' }),
    onSave, onError: (error) => errors.push(error)
  };
  return { options, errors, timers, instances, create: () => context.createProctorRecordingController(options) };
}

test('stopping waits for the final segment to commit and never restarts a recorder', async () => {
  const disk = deferred();
  const saved = [];
  const harness = recordingHarness(async (...args) => { saved.push(args); await disk.promise; });
  const controller = harness.create();
  const stopped = controller.stop();
  let complete = false;
  stopped.then(() => { complete = true; });
  await tick();
  assert.equal(complete, false);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][2].sessionId, 'session-a');
  assert.ok(saved[0][2].uploadId);
  assert.ok(saved[0][2].endedAt);
  assert.equal(saved[0][3].sessionToken, 'token-a');
  disk.resolve();
  await stopped;
  assert.equal(complete, true);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.instances.length, 1);
});

test('incident flushes create independently playable segments without shared chunks or duplicate stops', async () => {
  const saved = [];
  const harness = recordingHarness(async (...args) => saved.push(args));
  const controller = harness.create();
  controller.flush();
  controller.flush();
  await tick();
  const [id, next] = [...harness.timers][0];
  harness.timers.delete(id);
  next();
  await controller.stop();
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0][2].uploadId, saved[1][2].uploadId);
  assert.equal(await saved[0][0].text(), 'segment-0');
  assert.equal(await saved[1][0].text(), 'segment-1');
});

test('duplicate stop events do not save a segment twice or spawn duplicate recorders', async () => {
  const saved = [];
  const harness = recordingHarness(async (...args) => saved.push(args));
  const controller = harness.create();
  controller.flush();
  await tick();
  harness.instances[0].onstop();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(harness.timers.size, 1);
  await controller.stop();
});

test('an encoder error saves the final segment once and stops automatic recording', async () => {
  const saved = [];
  const harness = recordingHarness(async (...args) => saved.push(args));
  const controller = harness.create();
  harness.instances[0].onerror({ error: new Error('encoder failed') });
  await tick();
  await controller.stop();
  assert.equal(saved.length, 1);
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.instances.length, 1);
});

function rendererFunctions(names, globals) {
  const context = vm.createContext({ console, ...globals });
  for (const name of names) {
    const start = renderer.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    const rest = renderer.slice(start);
    const next = rest.indexOf('\n}\n') + 2;
    vm.runInContext(rest.slice(0, next), context);
  }
  return context;
}

test('reconciling channels does not restart an existing screen recorder when adding a camera', () => {
  const screen = { active: true }, camera = { active: true };
  const stopped = [];
  const existing = { channel: 'DESKTOP_SCREEN', stream: screen, sessionId: 'a', stopped: false, stop: () => { stopped.push('screen'); return Promise.resolve(); } };
  const state = { session: { id: 'a' }, requirements: { requireFrontCamera: true, saveIncidentRecording: true }, screenStream: screen, cameraStream: camera, mediaRecorders: [existing] };
  const started = [];
  const context = rendererFunctions(['startSegmentRecorders'], {
    state, window: { proctorRecordingEnabled: req => req.saveIncidentRecording === true || req.saveFullRecording === true, proctorCapturePolicy: () => ({ channels: ['DESKTOP_SCREEN', 'DESKTOP_CAMERA'] }) },
    trackRecordingSave: (value) => value,
    recordStream: (stream, channel) => {
      started.push(channel);
      state.mediaRecorders.push({ channel, stream, sessionId: 'a', stopped: false });
    }
  });
  context.startSegmentRecorders();
  context.startSegmentRecorders();
  assert.deepEqual(started, ['DESKTOP_CAMERA']);
  assert.deepEqual(stopped, []);
});

test('fullscreen recovery verifies new frames before handing off recording and live streams', async () => {
  const gate = deferred();
  const oldScreen = { id: 'old' }, newScreen = { id: 'new', getVideoTracks: () => [{ kind: 'video' }] };
  const events = [];
  const publisher = { stream: oldScreen, peer: { connectionState: 'connected', getSenders: () => [{ track: { kind: 'video' }, replaceTrack: async () => { events.push('replace-track'); } }] } };
  const state = { session: { id: 'session', status: 'LOCKED' }, monitoringGeneration: 7, screenStream: oldScreen, finishedScreenVisible: false, captureRecoveryBusy: false, captureRecoveryRetries: 1, whipPublishers: new Map([['DESKTOP_SCREEN', publisher]]) };
  const context = rendererFunctions(['recoverWindowModeCapture'], {
    state,
    captureScreen: async () => newScreen,
    waitForVideoFrame: () => gate.promise,
    attachScreenTrackWatchers: () => events.push('watch'),
    updateLocalPreviews: () => events.push('preview'),
    startSegmentRecorders: () => events.push('record'),
    stopWhipChannel: async (channel) => { events.push(`stop-${channel}`); },
    stopStream: (stream) => { if (stream) events.push(`stop-${stream.id}`); },
    startRtmpStreams: async () => { events.push('publish'); },
    errorMessage: (error) => error.message
  });
  const recovering = context.recoverWindowModeCapture(7, 'session');
  await tick();
  assert.equal(state.screenStream, oldScreen);
  assert.deepEqual(events, []);
  gate.resolve();
  assert.equal(await recovering, true);
  assert.equal(state.screenStream, newScreen);
  assert.equal(publisher.stream, newScreen);
  assert.equal(state.captureRecoveryBusy, false);
  assert.equal(state.captureRecoveryRetries, 0);
  assert.deepEqual(events, ['watch', 'preview', 'record', 'replace-track', 'stop-old', 'publish']);
});

test('fullscreen recovery reconnects only the screen channel when track replacement fails', async () => {
  const oldScreen = { id: 'old' }, newScreen = { id: 'new', getVideoTracks: () => [{ kind: 'video' }] };
  const events = [];
  const publisher = { stream: oldScreen, peer: { connectionState: 'connected', getSenders: () => [{ track: { kind: 'video' }, replaceTrack: async () => { throw new Error('replace failed'); } }] } };
  const state = { session: { id: 'session', status: 'IN_EXAM' }, monitoringGeneration: 2, screenStream: oldScreen, finishedScreenVisible: false, captureRecoveryBusy: false, captureRecoveryRetries: 0, whipPublishers: new Map([['DESKTOP_SCREEN', publisher]]) };
  const context = rendererFunctions(['recoverWindowModeCapture'], {
    state, captureScreen: async () => newScreen, waitForVideoFrame: async () => {},
    attachScreenTrackWatchers: () => {}, updateLocalPreviews: () => {}, startSegmentRecorders: () => {},
    stopWhipChannel: async (channel) => events.push(channel), stopStream: () => {}, startRtmpStreams: async () => {},
    errorMessage: (error) => error.message
  });
  assert.equal(await context.recoverWindowModeCapture(2, 'session'), true);
  assert.deepEqual(events, ['DESKTOP_SCREEN']);
});

test('IndexedDB request success does not acknowledge a rolled-back recording transaction', async () => {
  const request = { result: 'saved' };
  const tx = { objectStore: () => ({ put: () => request }) };
  const context = rendererFunctions(['withUploadStore'], { openUploadDb: async () => ({ transaction: () => tx, close() {} }) });
  const saving = context.withUploadStore('readwrite', (store) => store.put({}));
  await tick();
  let complete = false;
  saving.then(() => { complete = true; }, () => {});
  request.onsuccess?.();
  await tick();
  assert.equal(complete, false);
  tx.error = new Error('quota exceeded');
  tx.onabort();
  await assert.rejects(saving, /quota exceeded/);
});

test('failed uploads are retained and old-server credentials are never sent to the current server', async () => {
  const sent = [], deleted = [];
  const state = { serverUrl: 'https://new.test', session: { id: 'new' }, sessionToken: 'new-token', uploadFlushBusy: false, uploadFallback: new Map(), uploadRetryAt: new Map() };
  const context = rendererFunctions(['flushUploadQueue'], {
    state,
    listQueuedUploads: async () => [
      { id: 'old', serverUrl: 'https://old.test', sessionToken: 'old-token', fields: { sessionId: 'old' } },
      { id: 'new', serverUrl: 'https://new.test', sessionToken: 'expired-token', fields: { sessionId: 'new' } }
    ],
    uploadBlob: async (_blob, _name, _fields, token) => { sent.push(token); throw new Error('令牌无效'); },
    deleteQueuedUpload: async (id) => deleted.push(id), errorMessage: (error) => error.message,
    warnCandidate() {}
  });
  await context.flushUploadQueue();
  assert.deepEqual(sent, ['new-token']);
  assert.deepEqual(deleted, []);
  assert.equal(state.uploadFlushBusy, false);
});

test('successfully uploaded memory-only clips clear even when IndexedDB is unavailable', async () => {
  const item = { id: 'memory', serverUrl: 'https://exam.test', sessionToken: 'token', fields: { sessionId: 'a' } };
  const state = { serverUrl: item.serverUrl, session: { id: 'a' }, sessionToken: 'token', uploadFlushBusy: false, uploadFallback: new Map([[item.id, item]]), uploadRetryAt: new Map() };
  let sent = 0;
  const context = rendererFunctions(['flushUploadQueue'], {
    state, listQueuedUploads: async () => { throw new Error('disk full'); },
    withUploadStore: async () => { throw new Error('disk full'); },
    uploadBlob: async () => { sent++; }, deleteQueuedUpload: () => { throw new Error('must not access missing disk row'); },
    errorMessage: (error) => error.message, warnCandidate() {}
  });
  await context.flushUploadQueue();
  await context.flushUploadQueue();
  assert.equal(sent, 1);
  assert.equal(state.uploadFallback.size, 0);
});

test('pending incidents retry with the original time and event ID after the session finishes', async () => {
  const pending = { id: 'incident', serverUrl: 'https://exam.test', sessionToken: 'original', payload: {
    sessionId: 'a', type: 'SCREEN_SWITCH', eventId: 'event-1', occurredAt: '2026-09-30T10:00:00.000Z'
  } };
  const calls = [];
  const pendingAlertReports = new Map([[pending.id, pending]]);
  const context = rendererFunctions(['sendPendingAlert', 'flushPendingAlerts'], {
    state: { session: { id: 'a', status: 'FINISHED' }, sessionToken: 'renewed', serverUrl: pending.serverUrl },
    pendingAlertReports, alertRequests: new Set(), lastAlertReports: new Map(), AbortController,
    window: { setTimeout, clearTimeout },
    withUploadStore: async (mode) => mode === 'readonly' ? [pending] : undefined,
    fetchJsonFromRenderer: async (_path, request) => { calls.push(request); if (calls.length === 1) throw new Error('response lost'); }
  });
  await context.flushPendingAlerts();
  await context.flushPendingAlerts();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(JSON.parse(calls[1].body).eventId, 'event-1');
  assert.equal(calls[1].headers['x-proctor-session-token'], 'renewed');
  assert.equal(pendingAlertReports.size, 0);
});

test('a late heartbeat failure after exam finish cannot restart the reconnect loop', async () => {
  const response = deferred();
  let reconnects = 0;
  const state = { session: { id: 'a', status: 'IN_EXAM' }, heartbeatBusy: false, monitoringGeneration: 1, finishedScreenVisible: false };
  const context = rendererFunctions(['heartbeatTick'], {
    state, sendHeartbeat: () => response.promise, setOfflineStatus() {}, startReconnectLoop: () => reconnects++
  });
  const heartbeat = context.heartbeatTick();
  state.monitoringGeneration++;
  state.finishedScreenVisible = true;
  response.reject(new Error('offline'));
  await heartbeat;
  assert.equal(reconnects, 0);
  assert.equal(state.heartbeatBusy, false);
});

test('a cancelled WHIP connection resolving late is closed, not installed as a publisher', async () => {
  const result = deferred();
  let closes = 0;
  const attempt = { sessionId: 'a' };
  const state = { session: { id: 'a' }, whipAttempts: new Map([['DESKTOP_SCREEN', attempt]]), whipPublishers: new Map(), finishedScreenVisible: false };
  const context = rendererFunctions(['startWhipChannel'], {
    state, clearWhipReconnect() {}, publishDesktopWhip: () => result.promise
  });
  const connection = context.startWhipChannel('DESKTOP_SCREEN', {}, attempt);
  state.whipAttempts.clear();
  result.resolve({ stop: async () => closes++ });
  await connection;
  assert.equal(closes, 1);
  assert.equal(state.whipPublishers.size, 0);
});

test('unselected recording stops encoders and clears evidence buffers without stopping live capture', () => {
  const screen = { active: true }, camera = { active: true };
  let cleared = 0, stopped = 0;
  const entry = { full: true, incidents: true, buffer: { clear: () => cleared++, mark: () => assert.fail('disabled event must not save footage') } };
  const state = { session: { id: 'a' }, requirements: { saveFullRecording: false, saveIncidentRecording: false }, screenStream: screen, cameraStream: camera, recordingBuffers: new Map([['a', entry]]) };
  const context = rendererFunctions(['startSegmentRecorders', 'markRecordingEvent', 'recordStream'], {
    state, window: { proctorRecordingEnabled: req => req?.saveIncidentRecording === true || req?.saveFullRecording === true },
    stopRecorders: () => { stopped++; return Promise.resolve(); }, recordStream: () => assert.fail('unselected encoder must not start')
  });
  context.startSegmentRecorders();
  context.markRecordingEvent({ channel: 'DESKTOP_SCREEN' });
  context.recordStream(screen, 'DESKTOP_SCREEN');
  assert.equal(stopped, 1); assert.equal(cleared, 1);
  assert.equal(entry.full, false); assert.equal(entry.incidents, false);
  assert.equal(state.recordingBuffers.size, 0, 'stopped encoders cannot reuse a later enabled buffer');
  assert.equal(state.screenStream, screen); assert.equal(state.cameraStream, camera);
  assert.equal(screen.active, true); assert.equal(camera.active, true);
});


test('offline alert replay shares one flush and caps in-flight requests at three', async () => {
  const pending = Array.from({ length: 24 }, (_, id) => ({ id: `incident-${id}`, serverUrl: 'https://exam.test',
    sessionToken: 'original', payload: { sessionId: 'a', type: 'SCREEN_SWITCH', eventId: `event-${id}`,
      occurredAt: '2026-10-15T10:00:00.000Z' } }));
  const pendingAlertReports = new Map(pending.map(item => [item.id, item]));
  const calls = [], active = [];
  let inFlight = 0, peak = 0, reads = 0;
  const context = rendererFunctions(['sendPendingAlert', 'flushPendingAlerts'], {
    state: { session: { id: 'a' }, sessionToken: 'renewed', serverUrl: 'https://exam.test' },
    pendingAlertReports, alertRequests: new Set(), lastAlertReports: new Map(), AbortController,
    window: { setTimeout, clearTimeout },
    withUploadStore: async (mode) => { if (mode === 'readonly') { reads++; return pending; } },
    fetchJsonFromRenderer: async (_path, request) => {
      inFlight++; peak = Math.max(peak, inFlight); calls.push(JSON.parse(request.body).eventId);
      const response = deferred(); active.push(response); await response.promise; inFlight--;
    }
  });
  const flushes = Array.from({ length: 10 }, () => context.flushPendingAlerts());
  await tick();
  assert.equal(reads, 1);
  assert.equal(calls.length, 3);
  for (let batch = 0; batch < 8; batch++) { active.splice(0).forEach(response => response.resolve()); await tick(); }
  await Promise.all(flushes);
  assert.equal(peak, 3);
  assert.equal(calls.length, 24);
  assert.equal(new Set(calls).size, 24);
  assert.equal(pendingAlertReports.size, 0);
});
