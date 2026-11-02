import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture(post: (url: string, init: any) => Promise<Response>) {
  const requests: { method: string; url: string; body?: string }[] = [];
  const peers: any[] = [];
  class Peer {
    localDescription: any;
    connectionState = 'new';
    onicecandidate: any;
    constructor() { peers.push(this); }
    addTransceiver() {}
    createDataChannel() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:qa\r\na=ice-pwd:qa-password\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }; }
    async setLocalDescription(value: any) {
      this.localDescription = value;
      this.candidate('candidate:early 1 udp 1 127.0.0.1 44819 typ host');
    }
    async setRemoteDescription() {}
    candidate(candidate: string) { this.onicecandidate?.({ candidate: { candidate, sdpMLineIndex: 0, sdpMid: '0' } }); }
    close() { this.connectionState = 'closed'; }
  }
  const source = readFileSync(new URL('../public/live-webrtc.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ');
  const context = vm.createContext({ URL, AbortController, RTCPeerConnection: Peer, setTimeout, clearTimeout,
    location: { href: 'https://qa.example/monitor' },
    fetch: async (value: any, init: any) => {
      requests.push({ url: String(value), method: init.method, body: init.body });
      return init.method === 'POST' ? post(String(value), init) : new Response(null, { status: 204 });
    }
  });
  vm.runInContext(source, context);
  return { isPlaying: (context as any).isProctorWebRtcPlaying, requests, peers, reader: (context as any).createProctorWebRtcReader({ url: '/api/media/whep?sessionId=qa&channel=DESKTOP_SCREEN' }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('ICE candidates arriving before and after the answer are sent without delaying the initial offer', async () => {
  let answer: (value: Response) => void = () => {};
  const f = fixture(() => new Promise(resolve => { answer = resolve; }));
  try {
    await tick(); assert.equal(f.requests[0].method, 'POST'); assert.equal(f.requests.length, 1);
    answer(new Response('v=0\r\n', { status: 201, headers: { location: '/api/media/whep?sessionId=qa&channel=DESKTOP_SCREEN&resource=qa-resource' } }));
    await tick();
    assert.equal(f.requests[1].method, 'PATCH'); assert.match(f.requests[1].body!, /candidate:early/);
    assert.match(f.requests[1].body!, /a=ice-ufrag:qa\r\na=ice-pwd:qa-password/);
    f.peers[0].candidate('candidate:late 1 tcp 1 127.0.0.1 443 typ host'); await tick();
    assert.equal(f.requests[2].method, 'PATCH'); assert.match(f.requests[2].body!, /candidate:late/);
  } finally { f.reader.close(); }
  await tick(); assert.equal(f.requests.at(-1)!.method, 'DELETE'); assert.equal(f.peers[0].connectionState, 'closed');
});

test('closing during negotiation deletes a late resource without starting another reader', async () => {
  let answer: (value: Response) => void = () => {};
  const f = fixture(() => new Promise(resolve => { answer = resolve; }));
  await tick(); f.reader.close();
  answer(new Response('v=0\r\n', { status: 201, headers: { location: '/api/media/whep?resource=late-resource' } }));
  await tick();
  assert.deepEqual(f.requests.map(r => r.method), ['POST', 'DELETE']);
  assert.equal(f.peers.length, 1); assert.equal(f.peers[0].connectionState, 'closed');
});

test('an upstream resource cannot send authenticated candidate requests to another origin', async () => {
  const f = fixture(async () => new Response('v=0\r\n', { status: 201, headers: { location: 'https://other.example/api/media/whep?resource=bad' } }));
  await tick(); f.reader.close(); await tick();
  assert.deepEqual(f.requests.map(r => r.method), ['POST']);
  assert.equal(f.peers[0].connectionState, 'closed');
});


test('closed-connection placeholder frames never count as a live feed', async () => {
  const f = fixture(async () => new Response('v=0\r\n', { status: 201, headers: { location: '/api/media/whep?resource=qa-resource' } }));
  await tick();
  const video = { readyState: 4, videoWidth: 1920, videoHeight: 1080, srcObject: { getVideoTracks: () => [{ readyState: 'live' }] } };
  try {
    assert.equal(f.isPlaying(f.reader, video), false, 'onplaying during ICE negotiation is not enough');
    f.peers[0].connectionState = 'connected'; assert.equal(f.isPlaying(f.reader, video), true);
    assert.equal(f.isPlaying(f.reader, { ...video, videoWidth: 2, videoHeight: 2 }), false);
    f.reader.close(); assert.equal(f.isPlaying(f.reader, video), false);
  } finally { f.reader.close(); }
});
