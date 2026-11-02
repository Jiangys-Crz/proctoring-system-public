const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function track(id) {
  return { id, kind: 'audio', enabled: true, readyState: 'live', stopped: 0, addEventListener() {},
    clone() { return track(id + '-clone'); }, stop() { this.stopped++; this.readyState = 'ended'; } };
}
class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  addTrack(value) { this.tracks.push(value); }
  removeTrack(value) { this.tracks = this.tracks.filter(t => t !== value); }
}
function fixture() {
  let resolve, calls = 0, ready = 0;
  const context = vm.createContext({ MediaStream: Stream, Date, navigator: { mediaDevices: { getUserMedia: options => {
    assert.equal(options.video, false); assert.equal(options.audio.echoCancellation, true); calls++;
    return new Promise(done => { resolve = done; });
  } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/desktop-audio.js'), 'utf8'), context);
  const mic = context.createProctorMicrophoneCapture({ onReady: () => { ready++; } });
  return { mic, resolve: value => resolve(value), get calls() { return calls; }, get ready() { return ready; } };
}
test('a screen-only exam shares one microphone acquisition, records a screen clone and gives the call its own muteable clone', async () => {
  const f = fixture(), first = f.mic.acquire(), second = f.mic.acquire(), original = track('mic');
  assert.equal(f.calls, 1); f.resolve(new Stream([original])); assert.deepEqual(await Promise.all([first, second]), [true, true]);
  const screen = new Stream([{ id: 'video', kind: 'video' }]);
  assert.equal(f.mic.attach(screen), true); assert.equal(f.mic.attach(screen), false);
  const call = await f.mic.clone(); call.getAudioTracks()[0].enabled = false;
  assert.equal(original.enabled, true); assert.equal(screen.getAudioTracks()[0].enabled, true);
  call.getTracks().forEach(t => t.stop()); screen.getAudioTracks()[0].stop();
  assert.equal(original.readyState, 'live', 'ending a call or recovering the screen must not stop ambient monitoring');
  f.mic.stop(); assert.equal(original.readyState, 'ended'); assert.equal(f.ready, 1);
});
test('stopping an exam discards late microphone authorization and a new exam can acquire independently', async () => {
  const f = fixture(), pending = f.mic.acquire(); f.mic.stop();
  const stale = track('old'); f.resolve(new Stream([stale])); assert.equal(await pending, false);
  assert.equal(stale.readyState, 'ended'); assert.equal(f.mic.available, false);
  const next = f.mic.acquire(), current = track('new'); f.resolve(new Stream([current]));
  assert.equal(await next, true); assert.equal(f.mic.available, true); f.mic.stop();
});
