import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../../packages/shared/src/realtime-voice.js', import.meta.url), 'utf8');
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function track(id = 'microphone'): any { return { id, kind: 'audio', readyState: 'live', enabled: true, stop() { this.readyState = 'ended'; } }; }
class Stream {
  constructor(public tracks: any[] = []) {}
  getTracks() { return this.tracks; } getAudioTracks() { return this.tracks; } addTrack(t: any) { this.tracks.push(t); }
}
function fixture(side = 'ADMIN', custom?: (body: any) => Promise<any>) {
  const requests: any[] = [], peers: any[] = [], timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0, now = 0, captures = 0;
  const mic = track(), capture = deferred<Stream>();
  const info: any = { id: 'call', sessionId: 'session', callerName: '监考老师', status: 'RINGING' };
  class Peer {
    connectionState = 'new'; iceGatheringState = 'complete'; localDescription: any; transceivers: any[] = [];
    onconnectionstatechange: any; ontrack: any;
    constructor() { peers.push(this); }
    addTransceiver(t: any, options: any) { this.transceivers.push({ track: t, ...options }); }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
    async setLocalDescription(value: any) { this.localDescription = value; }
    async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); if (this.transceivers[0].direction === 'recvonly') this.ontrack?.({ track: track('remote'), streams: [] }); }
    close() { this.connectionState = 'closed'; }
  }
  const audio = { srcObject: null as Stream | null, muted: true, pauses: 0, async play() {}, pause() { this.pauses++; } };
  const context: any = vm.createContext({ MediaStream: Stream, RTCPeerConnection: Peer, AbortController,
    Date: { now: () => now }, navigator: { mediaDevices: { getUserMedia: async (constraints: any) => { assert.equal(constraints.video, false); captures++; return capture.promise; } } },
    setTimeout: (fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id: number) => timers.delete(id)
  });
  vm.runInContext(source, context);
  const controller = context.createProctorVoiceCall({ side, sessionId: 'session', audio,
    request: async (body: any) => {
      requests.push(JSON.parse(JSON.stringify(body)));
      if (custom) return custom(body);
      if (body.action === 'MEDIA_OPEN') return { ready: true, resource: body.mode + '-resource', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
      if (body.action === 'ACCEPT') info.status = 'CONNECTING';
      if (body.action === 'POLL' && body.connected && ['CONNECTING', 'ACTIVE'].includes(info.status)) info.status = 'ACTIVE';
      if (body.action === 'END') { info.status = 'ENDED'; info.endReason = body.reason; }
      return { call: { ...info } };
    }
  });
  return { controller, audio, mic, capture, requests, peers, info, get captures() { return captures; },
    async runPoll() { const next = [...timers].find(([, t]) => t.ms < 3000); if (next) { timers.delete(next[0]); next[1].fn(); await tick(); } },
    advance(ms: number) { now += ms; }
  };
}
test('calls default to the computer and publish live audio without recording or uploading a clip', async () => {
  const h = fixture(); const start = h.controller.start('session'); h.capture.resolve(new Stream([h.mic])); await start;
  assert.equal(h.requests[0].target, 'DESKTOP'); assert.equal(h.controller.state.phase, 'ringing');
  h.info.status = 'CONNECTING'; await h.runPoll(); await h.runPoll();
  assert.equal(h.peers.length, 2); assert.deepEqual(h.peers.map(p => p.transceivers[0].direction), ['sendonly', 'recvonly']);
  assert.equal(h.peers[0].transceivers[0].track.kind, 'audio');
  assert.ok(h.requests.filter(r => r.action === 'MEDIA_OPEN').every(r => /^m=audio/m.test(r.sdp) && !r.sdp.includes('m=video')));
  assert.equal(h.audio.muted, false); assert.equal(h.audio.srcObject?.getAudioTracks().length, 1);
  assert.equal(h.controller.state.phase, 'active');
  h.controller.mute(); assert.equal(h.mic.enabled, false); h.controller.mute(); assert.equal(h.mic.enabled, true);
  await h.controller.hangup(); assert.equal(h.mic.readyState, 'ended'); assert.ok(h.peers.every(p => p.connectionState === 'closed'));
  assert.equal(h.audio.srcObject, null); assert.ok(h.requests.some(r => r.action === 'END')); h.controller.dispose();
});
test('the computer rings first and does not open its call microphone until the candidate accepts', async () => {
  const h = fixture('DESKTOP'); h.controller.listen(); await h.runPoll();
  assert.equal(h.controller.state.phase, 'incoming'); assert.equal(h.captures, 0);
  const accept = h.controller.accept(); await tick(); assert.equal(h.captures, 1);
  h.capture.resolve(new Stream([h.mic])); await accept; await tick(); await h.runPoll();
  assert.ok(h.requests.some(r => r.action === 'ACCEPT')); assert.equal(h.peers.length, 2); h.controller.dispose();
});
test('closing while microphone permission is pending releases the late stream without dialing', async () => {
  const h = fixture(), start = h.controller.start('session'); h.controller.dispose(); h.capture.resolve(new Stream([h.mic])); await start;
  assert.equal(h.mic.readyState, 'ended'); assert.equal(h.requests.length, 0);
});
test('closing during call creation cancels a late server call instead of leaving a ringing orphan', async () => {
  const created = deferred<any>(), h = fixture('ADMIN', async body => body.action === 'START' ? created.promise : {});
  const start = h.controller.start('session'); h.capture.resolve(new Stream([h.mic])); await tick(); h.controller.dispose();
  created.resolve({ call: { id: 'late-call', status: 'RINGING' } }); await start; await tick();
  assert.ok(h.requests.some(r => r.action === 'END' && r.callId === 'late-call' && r.reason === 'CANCELLED')); assert.equal(h.mic.readyState, 'ended');
});
test('a remote hangup closes both peers and stops microphone capture immediately', async () => {
  const h = fixture(); const start = h.controller.start('session'); h.capture.resolve(new Stream([h.mic])); await start;
  h.info.status = 'CONNECTING'; await h.runPoll(); await tick();
  h.info.status = 'ENDED'; h.info.endReason = 'HUNG_UP'; await h.runPoll();
  assert.equal(h.controller.state.phase, 'ended'); assert.ok(h.peers.every(p => p.connectionState === 'closed'));
  assert.equal(h.mic.readyState, 'ended'); h.controller.dispose();
});
test('signaling loss stops an otherwise connected call after its local lease expires', async () => {
  let failing = false;
  const h = fixture('ADMIN', async body => { if (failing && body.action === 'POLL') throw new Error('offline'); return { call: { id: 'call', sessionId: 'session', status: 'RINGING' } }; });
  const start = h.controller.start('session'); h.capture.resolve(new Stream([h.mic])); await start; failing = true; h.advance(16000); await h.runPoll();
  assert.equal(h.controller.state.phase, 'ended'); assert.equal(h.mic.readyState, 'ended'); h.controller.dispose();
});
