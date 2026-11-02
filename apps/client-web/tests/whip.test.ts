import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishWhip, whipErrorMessage } from '../src/lib/whip';

test('mobile WHIP still sends an offer and connects when H264 preferences are rejected', async () => {
  const keys = ['window', 'RTCPeerConnection', 'RTCRtpSender', 'RTCRtpReceiver'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const originalFetch = globalThis.fetch;
  const preferences: RTCRtpCodec[][] = [];
  let closed = false, offered = false;
  class Peer {
    connectionState = 'connected';
    iceGatheringState = 'complete';
    localDescription = { sdp: 'fixture offer SDP' };
    addTransceiver(_track: unknown, options: unknown) {
      assert.equal((options as { direction: string }).direction, 'sendonly');
      return { setCodecPreferences(codecs: RTCRtpCodec[]) {
        preferences.push(codecs);
        if (codecs.length) throw new Error('Invalid codec preferences: invalid codec with name "H264"');
      } };
    }
    addEventListener() {}
    async createOffer() { offered = true; return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription(answer: { sdp: string }) { assert.equal(answer.sdp, 'fixture answer SDP'); }
    getSenders() { return []; }
    close() { closed = true; }
  }
  const capabilities = { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264', clockRate: 90000 }] }) };
  for (const [key, value] of Object.entries({ window: { setTimeout, clearTimeout }, RTCPeerConnection: Peer, RTCRtpSender: capabilities, RTCRtpReceiver: capabilities })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'DELETE') return new Response('', { status: 200 });
    assert.equal(options?.method, 'POST'); assert.equal(options?.body, 'fixture offer SDP');
    return new Response('fixture answer SDP', { status: 201, headers: { location: '/whip/resource' } });
  };
  try {
    const stream = { getVideoTracks: () => [{}] } as unknown as MediaStream;
    const publisher = await publishWhip({ endpoint: 'https://api.example.test/whip', stream, token: 'fixture-token' });
    assert.equal(offered, true); assert.equal(closed, false);
    assert.equal(preferences.length, 2); assert.deepEqual(preferences[1], []);
    await publisher.stop(); assert.equal(closed, true);
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!); else Reflect.deleteProperty(globalThis, key); });
  }
});

const codecFailure = () => new Error("Failed to execute 'setLocalDescription' on 'RTCPeerConnection': Failed to set local offer sdp: Failed to set local video description recv parameters for m-section with mid='0'.");

async function withPeers(options: {
  localError?: (mode: string, index: number) => Error | undefined;
  networkError?: Error;
  remoteError?: Error;
  supportsVp8?: boolean;
}, run: (fixture: {
  peers: Array<{ mode: string; closed: boolean }>;
  requests: string[];
  states: string[];
  senderParameters: RTCRtpSendParameters[];
  publish: () => ReturnType<typeof publishWhip>;
}) => Promise<void>) {
  const keys = ['window', 'RTCPeerConnection', 'RTCRtpSender', 'RTCRtpReceiver'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const originalFetch = globalThis.fetch;
  const peers: Peer[] = [], requests: string[] = [], states: string[] = [], senderParameters: RTCRtpSendParameters[] = [];
  const track = { contentHint: '', stop() { assert.fail('negotiation must keep the acquired camera alive'); } };
  const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
  class Peer {
    mode = 'default';
    closed = false;
    connectionState = 'connected';
    iceGatheringState = 'complete';
    localDescription: { sdp: string } | null = null;
    listeners: Array<() => void> = [];
    index = peers.push(this) - 1;
    addTransceiver(actualTrack: unknown, init: { direction: string; streams: MediaStream[]; sendEncodings: RTCRtpEncodingParameters[] }) {
      assert.equal(actualTrack, track); assert.equal(init.streams[0], stream);
      assert.equal(track.contentHint, 'motion');
      assert.equal(init.direction, 'sendonly');
      assert.deepEqual(init.sendEncodings, [{ maxBitrate: 450_000, maxFramerate: 20 }]);
      return { sender: {
        getParameters: () => ({ transactionId: 'fixture', codecs: [], headerExtensions: [], rtcp: {}, encodings: [{ active: true, rid: 'camera' }] }),
        setParameters: async (parameters: RTCRtpSendParameters) => { senderParameters.push(parameters); }
      }, setCodecPreferences: (codecs: RTCRtpCodec[]) => {
        this.mode = codecs.length ? codecs.some(codec => codec.mimeType === 'video/H264') ? 'h264' : 'vp8' : 'default';
      } };
    }
    addEventListener(event: string, listener: () => void) { if (event === 'connectionstatechange') this.listeners.push(listener); }
    async createOffer() {
      assert.equal(this.closed, false);
      return { type: 'offer', sdp: `${this.mode} offer` };
    }
    async setLocalDescription(offer: { sdp: string }) {
      const error = options.localError?.(this.mode, this.index);
      if (error) throw error;
      this.localDescription = offer;
    }
    async setRemoteDescription() { if (options.remoteError) throw options.remoteError; this.listeners.forEach(listener => listener()); }
    getSenders() { return []; }
    close() { this.closed = true; this.connectionState = 'closed'; this.listeners.forEach(listener => listener()); }
  }
  const codecs = [{ mimeType: 'video/H264', clockRate: 90000 },
    ...(options.supportsVp8 === false ? [] : [{ mimeType: 'video/VP8', clockRate: 90000 }])];
  const capabilities = { getCapabilities: () => ({ codecs }) };
  for (const [key, value] of Object.entries({ window: { setTimeout, clearTimeout }, RTCPeerConnection: Peer, RTCRtpSender: capabilities, RTCRtpReceiver: capabilities })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  globalThis.fetch = async (_url, init) => {
    requests.push(init?.method || 'GET');
    if (init?.method === 'DELETE') return new Response('', { status: 200 });
    assert.equal(init?.body, peers.at(-1)?.localDescription?.sdp, 'only the successful fresh offer is sent');
    if (options.networkError) throw options.networkError;
    return new Response('answer', { status: 201, headers: { location: '/whip/resource' } });
  };
  try {
    await run({ peers, requests, states, senderParameters, publish: () => publishWhip({
      endpoint: 'https://api.example.test/whip', stream, token: 'fixture-token', onStateChange: state => states.push(state)
    }) });
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!); else Reflect.deleteProperty(globalThis, key); });
  }
}

test('a local H264 SDP failure closes the damaged peer and reconnects with a fresh default offer', async () => {
  await withPeers({ localError: mode => mode === 'h264' ? codecFailure() : undefined }, async ({ peers, requests, states, publish }) => {
    const publisher = await publish();
    assert.deepEqual(peers.map(peer => peer.mode), ['h264', 'default']);
    assert.equal(peers[0].closed, true); assert.equal(peers[1].closed, false);
    assert.equal(publisher.peer, peers[1]); assert.deepEqual(states, ['connected']);
    assert.deepEqual(requests, ['POST']);
    await publisher.stop(); await publisher.stop();
    assert.deepEqual(requests, ['POST', 'DELETE']); assert.equal(peers[1].closed, true);
  });
});

test('a browser that also rejects default SDP recovers with VP8 on a third peer', async () => {
  await withPeers({ localError: mode => mode !== 'vp8' ? codecFailure() : undefined }, async ({ peers, requests, states, senderParameters, publish }) => {
    const publisher = await publish();
    assert.deepEqual(peers.map(peer => peer.mode), ['h264', 'default', 'vp8']);
    assert.deepEqual(peers.map(peer => peer.closed), [true, true, false]);
    assert.deepEqual(states, ['connected']); assert.deepEqual(requests, ['POST']);
    assert.equal(senderParameters.length, 3);
    assert.ok(senderParameters.every(parameters => parameters.encodings[0].maxBitrate === 450_000 && parameters.encodings[0].maxFramerate === 20));
    assert.ok(senderParameters.every(parameters => parameters.encodings[0].active && parameters.encodings[0].rid === 'camera'));
    await publisher.stop();
  });
});

test('codec recovery is bounded and releases all peers when every local SDP fails', async () => {
  await withPeers({ localError: codecFailure }, async ({ peers, requests, publish }) => {
    await assert.rejects(publish(), /recv parameters/);
    assert.equal(peers.length, 3); assert.ok(peers.every(peer => peer.closed));
    assert.deepEqual(requests, []);
  });
});

test('an unavailable VP8 fallback preserves the original codec failure and releases its peer', async () => {
  await withPeers({ supportsVp8: false, localError: codecFailure }, async ({ peers, requests, publish }) => {
    await assert.rejects(publish(), /recv parameters/);
    assert.equal(peers.length, 3); assert.ok(peers.every(peer => peer.closed));
    assert.deepEqual(requests, []);
  });
});

test('unrelated local failures and network failures do not restart codec negotiation', async () => {
  for (const options of [{ localError: () => new Error('peer is closed') }, { networkError: new Error('network offline') }]) {
    await withPeers(options, async ({ peers, publish }) => {
      await assert.rejects(publish(), /closed|offline/);
      assert.equal(peers.length, 1); assert.equal(peers[0].closed, true);
    });
  }
});

test('a remote answer failure deletes the WHIP resource without retrying local codecs', async () => {
  await withPeers({ remoteError: new Error('invalid answer SDP') }, async ({ peers, requests, publish }) => {
    await assert.rejects(publish(), /invalid answer SDP/);
    assert.equal(peers.length, 1); assert.equal(peers[0].closed, true);
    assert.deepEqual(requests, ['POST', 'DELETE']);
  });
});

test('codec failures have a readable recovery message while server failures retain their detail', () => {
  assert.match(whipErrorMessage(codecFailure()), /视频编码连接失败/);
  assert.doesNotMatch(whipErrorMessage(codecFailure()), /setLocalDescription|摄像头权限/);
  assert.equal(whipErrorMessage(new Error('WHIP 媒体连接超时')), 'WHIP 媒体连接超时');
});
