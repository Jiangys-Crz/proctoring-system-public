const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/recording-buffer.js'), 'utf8');
function harness(full = false, incidents = true) {
  let time = 90000, saveFull = full, saveIncidents = incidents;
  const saved = [];
  const context = vm.createContext({ Date, Promise });
  vm.runInContext(source, context);
  const buffer = context.createProctorRecordingBuffer({ now: () => time, saveFull: () => saveFull, saveIncidents: () => saveIncidents, onSave: (clip, evidenceOnly) => { saved.push({ clip, evidenceOnly }); } });
  const clip = (start, end) => ({ id: String(start), startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), bytes: 'independent clip' });
  return { buffer, saved, clip, time: value => { time = value; }, full: value => { saveFull = value; }, incidents: value => { saveIncidents = value; }, context };
}
test('normal footage stays in a bounded memory buffer and never reaches durable storage', async () => {
  const h = harness();
  for (let i = 0; i < 18; i++) await h.buffer.add(h.clip(i * 5000, (i + 1) * 5000));
  assert.equal(h.saved.length, 0);
  assert.ok(h.buffer.size <= 13);
  h.time(200000);
  assert.equal(h.buffer.size, 0);
});
test('an incident preserves the preceding and following twenty seconds without duplicate copies', async () => {
  const h = harness();
  for (let i = 8; i < 18; i++) await h.buffer.add(h.clip(i * 5000, (i + 1) * 5000));
  const event = { id: 'incident', occurredAt: new Date(90000).toISOString() };
  await h.buffer.mark(event);
  await h.buffer.mark(event);
  for (let i = 18; i < 25; i++) { h.time((i + 1) * 5000); await h.buffer.add(h.clip(i * 5000, (i + 1) * 5000)); }
  assert.deepEqual(h.saved.map(item => Number(item.clip.id)), [70000, 75000, 80000, 85000, 90000, 95000, 100000, 105000]);
  assert.ok(h.saved.every(item => item.evidenceOnly));
});
test('overlapping incidents share uploaded clips and full recording persists all clips', async () => {
  const h = harness(true);
  await h.buffer.add(h.clip(80000, 85000));
  assert.equal(h.saved[0].evidenceOnly, false);
  h.full(false);
  await h.buffer.add(h.clip(85000, 90000));
  assert.equal(h.saved.length, 1);
  await h.buffer.mark({ id: 'a', occurredAt: new Date(90000).toISOString() });
  await h.buffer.mark({ id: 'b', occurredAt: new Date(95000).toISOString() });
  assert.equal(h.saved.length, 2);
  h.buffer.clear();
  assert.equal(h.buffer.size, 0);
});
test('recording channel selection follows the existing incident evidence policy', () => {
  const { context } = harness();
  assert.equal(context.proctorEvidenceChannel('SCREEN_SWITCH', { id: 'mobile_alert_a' }), 'MOBILE_CAMERA');
  assert.equal(context.proctorEvidenceChannel('SECOND_CAMERA_OFFLINE'), 'MOBILE_CAMERA');
  assert.equal(context.proctorEvidenceChannel('CAMERA_CAPTURE_LOST'), 'DESKTOP_CAMERA');
  assert.equal(context.proctorEvidenceChannel('PROCESS_POLICY'), 'DESKTOP_SCREEN');
});
test('downscaling stops only derived tracks and keeps the 1080p/30fps live stream untouched', async () => {
  const stopped = [], timers = new Map();
  const video = { readyState: 2, play: async () => {}, pause() {}, srcObject: null };
  const clone = { stop: () => stopped.push('audio-clone') };
  const audio = { clone: () => clone, stop: () => stopped.push('source-audio') };
  let frames = 0, draws = 0;
  const output = { tracks: [{ requestFrame: () => frames++, stop: () => stopped.push('canvas') }], addTrack(track) { this.tracks.push(track); }, getTracks() { return this.tracks; }, getVideoTracks() { return this.tracks.slice(0, 1); } };
  const canvas = { getContext: () => ({ drawImage() { draws++; } }), captureStream: fps => { assert.equal(fps, 0); return output; } };
  const context = vm.createContext({ document: { createElement: tag => tag === 'video' ? video : canvas },
    setInterval: fn => { timers.set(1, fn); return 1; }, clearInterval: id => timers.delete(id) });
  vm.runInContext(source, context);
  const stream = { getAudioTracks: () => [audio], settings: { width: 1920, height: 1080, frameRate: 30 } };
  const recording = context.createProctorRecordingStream(stream, { width: 1280, height: 720, frameRate: 20, onError: assert.fail });
  assert.equal(canvas.width, 1280);
  assert.equal(canvas.height, 720);
  assert.equal(video.srcObject, stream);
  await Promise.resolve();
  timers.get(1)();
  assert.equal(draws, 2, 'ready playback and the recording timer each draw one frame');
  assert.equal(frames, draws, 'each painted frame is explicitly captured without animation-frame scheduling');
  const paint = timers.get(1);
  recording.stop(); recording.stop();
  paint();
  assert.equal(frames, 2, 'late timer callbacks cannot capture after stop');
  assert.deepEqual(stopped, ['canvas', 'audio-clone']);
  assert.equal(timers.size, 0);
  assert.deepEqual(stream.settings, { width: 1920, height: 1080, frameRate: 30 });
});

test('older canvas tracks fall back to automatic capture without leaking the probe stream', async () => {
  const rates = [], stopped = [], timers = new Map();
  const video = { readyState: 1, play: async () => {}, pause() {} };
  let draws = 0;
  const canvas = { getContext: () => ({ drawImage() { draws++; } }), captureStream: fps => {
    rates.push(fps);
    const track = { stop: () => stopped.push(fps) };
    return { getVideoTracks: () => [track], getTracks: () => [track], addTrack: assert.fail };
  } };
  const context = vm.createContext({ document: { createElement: tag => tag === 'video' ? video : canvas },
    setInterval: callback => { timers.set(1, callback); return 1; }, clearInterval: id => timers.delete(id) });
  vm.runInContext(source, context);
  const recording = context.createProctorRecordingStream({ getAudioTracks: () => [] }, { width: 640, height: 360, frameRate: 20, onError: assert.fail });
  await Promise.resolve();
  assert.deepEqual(rates, [0, 20]);
  assert.deepEqual(stopped, [0]);
  assert.equal(draws, 0, 'unready video is not fabricated as a captured frame');
  video.readyState = 2; timers.get(1)();
  assert.equal(draws, 1);
  recording.stop();
  assert.deepEqual(stopped, [0, 20]);
  assert.equal(timers.size, 0);
});

test('without either opt-in, incidents save nothing and disabled footage cannot be recovered later', async () => {
  const h = harness(false, false);
  await h.buffer.add(h.clip(80000, 85000));
  await h.buffer.mark({ id: 'disabled-incident', occurredAt: new Date(90000).toISOString() });
  assert.equal(h.saved.length, 0); assert.equal(h.buffer.size, 0);
  h.incidents(true);
  await h.buffer.add(h.clip(85000, 90000));
  assert.equal(h.saved.length, 0, 'an incident reported while disabled must not be replayed');
  await h.buffer.mark({ id: 'selected-incident', occurredAt: new Date(90000).toISOString() });
  assert.deepEqual(h.saved.map(item => Number(item.clip.id)), [85000]);
  h.incidents(false);
  await h.buffer.add(h.clip(90000, 95000));
  assert.equal(h.saved.length, 1); assert.equal(h.buffer.size, 0);
});
test('disabling before a queued save runs cancels it; full recording works independently', async () => {
  const h = harness(true, false);
  const pending = h.buffer.add(h.clip(80000, 85000));
  h.full(false);
  await pending;
  assert.equal(h.saved.length, 0);
  h.full(true);
  await h.buffer.add(h.clip(85000, 90000));
  assert.equal(h.saved.length, 1); assert.ok(h.saved.every(item => !item.evidenceOnly));
});
test('recorders start only for an explicit recording choice, with public tests always excluded', () => {
  const { context } = harness();
  assert.equal(context.proctorRecordingEnabled(), false);
  assert.equal(context.proctorRecordingEnabled({}), false);
  assert.equal(context.proctorRecordingEnabled({ saveFullRecording: false, saveIncidentRecording: false }), false);
  assert.equal(context.proctorRecordingEnabled({ saveIncidentRecording: true }), true);
  assert.equal(context.proctorRecordingEnabled({ saveFullRecording: true }), true);
  assert.equal(context.proctorRecordingEnabled({ isPublicTest: true, saveFullRecording: true, saveIncidentRecording: true }), false);
});
