import '@cwnupaa/proctor-shared/webrtc-codecs';

export interface WhipPublisher {
  peer: RTCPeerConnection;
  stop: () => Promise<void>;
}

function isLocalCodecError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /(?:codec|local (?:offer|video) description|video description (?:recv|send) parameters)/i.test(message);
}

export function whipErrorMessage(error: unknown) {
  if (isLocalCodecError(error)) return '当前浏览器的视频编码连接失败，请更新浏览器或换用其他浏览器后重新推流';
  return error instanceof Error ? error.message : '第二机位推流失败';
}

function waitForIceGathering(peer: RTCPeerConnection, timeoutMs = 1000) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', changed);
      resolve();
    }
    function changed() {
      if (peer.iceGatheringState === 'complete') done();
    }
    peer.addEventListener('icegatheringstatechange', changed);
  });
}

function waitForConnection(peer: RTCPeerConnection, timeoutMs = 15_000) {
  if (peer.connectionState === 'connected') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => done(new Error('WHIP 媒体连接超时')), timeoutMs);
    function cleanup() {
      window.clearTimeout(timeout);
      peer.removeEventListener('connectionstatechange', changed);
    }
    function done(error?: Error) {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function changed() {
      if (peer.connectionState === 'connected') done();
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        done(new Error(`WHIP 媒体连接失败（${peer.connectionState}）`));
      }
    }
    peer.addEventListener('connectionstatechange', changed);
  });
}

export async function publishWhip(options: {
  endpoint: string;
  stream: MediaStream;
  token: string;
  onStateChange?: (state: RTCPeerConnectionState) => void;
}): Promise<WhipPublisher> {
  const createPeer = () => new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: 'max-bundle'
  });
  let peer = createPeer();
  let resourceEndpoint: string | null = null;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    peer.getSenders().forEach(sender => { void sender.replaceTrack(null).catch(() => {}); });
    peer.close();
    if (!resourceEndpoint) return;
    await fetch(resourceEndpoint, {
      method: 'DELETE',
      keepalive: true,
      redirect: 'error',
      headers: {
        'x-proctor-client': 'browser',
        'x-proctor-session-token': options.token,
        authorization: `Bearer ${options.token}`
      }
    }).catch(() => {});
  };
  try {
    const videoTrack = options.stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('未获取到可推送的视频轨道');
    try { videoTrack.contentHint = 'motion'; } catch { /* Older browsers may not expose content hints. */ }
    let negotiationError: unknown;
    for (const mode of ['h264', 'default', 'vp8'] as const) {
      const transceiver = peer.addTransceiver(videoTrack, {
        direction: 'sendonly',
        streams: [options.stream],
        sendEncodings: [{ maxBitrate: 450_000, maxFramerate: 20 }]
      });
      if (mode === 'h264') globalThis.proctorPreferH264(transceiver);
      if (mode === 'vp8' && !globalThis.proctorPreferVp8(transceiver)) throw negotiationError;
      const sender = transceiver.sender;
      if (sender && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function') {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = 450_000;
        parameters.encodings[0].maxFramerate = 20;
        await sender.setParameters(parameters).catch(() => {});
      }
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        break;
      } catch (error) {
        if (!isLocalCodecError(error) || mode === 'vp8') throw error;
        negotiationError = error;
        // A failed local description can leave libwebrtc in a permanent session
        // error. Retry on a fresh peer while reusing the live camera track.
        peer.close();
        peer = createPeer();
      }
    }
    peer.addEventListener('connectionstatechange', () => options.onStateChange?.(peer.connectionState));

    await waitForIceGathering(peer);
    const localSdp = peer.localDescription?.sdp;
    if (!localSdp) throw new Error('浏览器未生成 WHIP SDP');

    const response = await fetch(options.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/sdp',
        accept: 'application/sdp',
        'x-proctor-client': 'browser',
        'x-proctor-session-token': options.token,
        authorization: `Bearer ${options.token}`
      },
      body: localSdp
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(message || `WHIP 建连失败（${response.status}）`);
    }
    const location = response.headers.get('location');
    const resource = new URL(location || options.endpoint, options.endpoint);
    const endpointOrigin = new URL(options.endpoint).origin;
    if (resource.origin !== endpointOrigin || resource.username || resource.password) throw new Error('视频服务返回的连接地址不属于当前监考平台');
    resourceEndpoint = resource.toString();
    const answer = await response.text();
    await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    await waitForConnection(peer);
    return { peer, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function supportedRecordingMime(kind: 'video' | 'audio') {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates =
    kind === 'video'
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) || '';
}

export function extensionForMime(mime: string) {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.startsWith('audio/')) return mime.includes('ogg') ? 'ogg' : 'webm';
  if (mime.startsWith('image/')) return mime.includes('png') ? 'png' : 'jpg';
  return 'webm';
}
