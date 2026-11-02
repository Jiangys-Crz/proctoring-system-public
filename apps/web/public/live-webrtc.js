const root = typeof window !== 'undefined' ? window : globalThis;
export function isProctorWebRtcPlaying(reader, video) {
  return reader?.peer?.connectionState === 'connected' && video?.readyState >= 2
    && video.videoWidth > 2 && video.videoHeight > 2
    && video.srcObject?.getVideoTracks().some(track => track.readyState === 'live');
}
  // Shared by the authenticated monitor and API-key viewers. WHEP signaling
  // stays on the backend; both viewers receive the original WebRTC media.
export function createProctorWebRtcReader(options) {
    const target = new URL(options.url, root.location.href);
    let closed = false, generation = 0, peer = null, resource = '', abort = null;
    let retryTimer = 0, connectTimer = 0;
    function release() {
      generation++;
      clearTimeout(connectTimer); clearTimeout(retryTimer);
      abort?.abort(); abort = null;
      options.onReset?.();
      const previous = peer; peer = null; previous?.close();
      const previousResource = resource; resource = '';
      if (previousResource) void fetch(previousResource, { method: 'DELETE', keepalive: true }).catch(() => {});
    }
    function retry(error) {
      if (closed) return;
      release(); options.onError?.(error);
      retryTimer = setTimeout(start, 2000);
    }
    async function start() {
      if (closed) return;
      const current = ++generation;
      const connection = new RTCPeerConnection({ iceServers: [] });
      peer = connection; abort = new AbortController();
      const signal = abort.signal;
      const active = () => !closed && current === generation;
      let offer = '', pending = [], flushing = false;
      function fragment(candidates) {
        const lines = offer.split(/\r?\n/), medias = lines.filter(line => line.startsWith('m='));
        let text = lines.filter(line => /^a=ice-(?:ufrag|pwd):/.test(line)).slice(0, 2).join('\r\n') + '\r\n';
        const indices = [...new Set(candidates.map(candidate => candidate.sdpMLineIndex))];
        for (const index of indices) {
          const rows = candidates.filter(candidate => candidate.sdpMLineIndex === index);
          if (!medias[index]) continue;
          text += medias[index] + '\r\n' + 'a=mid:' + rows[0].sdpMid + '\r\n';
          for (const candidate of rows) text += 'a=' + candidate.candidate + '\r\n';
        }
        return text;
      }
      async function flush() {
        if (flushing || !resource || !active()) return;
        flushing = true;
        try {
          while (pending.length && active()) {
            const batch = pending; pending = [];
            const response = await fetch(resource, { method: 'PATCH', headers: { 'content-type': 'application/trickle-ice-sdpfrag', 'if-match': '*' }, body: fragment(batch), signal });
            if (response.status !== 204) throw new Error('WebRTC candidate exchange failed');
          }
        } catch (error) { if (active()) retry(error); }
        finally { flushing = false; }
      }
      connection.addTransceiver('video', { direction: 'recvonly' });
      connection.addTransceiver('audio', { direction: 'recvonly' });
      connection.createDataChannel('');
      connection.onicecandidate = event => {
        if (!active() || !event.candidate) return;
        pending.push(event.candidate); void flush();
      };
      connection.ontrack = event => { if (active()) options.onTrack?.(event); };
      connection.onconnectionstatechange = () => {
        if (!active()) return;
        options.onConnectionState?.(connection.connectionState);
        if (connection.connectionState === 'connected') clearTimeout(connectTimer);
        if (['failed', 'closed'].includes(connection.connectionState)) retry(new Error('WebRTC connection lost'));
      };
      connectTimer = setTimeout(() => { if (active()) retry(new Error('WebRTC connection timeout')); }, 15000);
      try {
        await connection.setLocalDescription(await connection.createOffer());
        offer = connection.localDescription.sdp;
        const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/sdp', accept: 'application/sdp' }, body: offer, signal });
        if (!response.ok) throw new Error('WebRTC signaling HTTP ' + response.status);
        const location = new URL(response.headers.get('location') || '', target);
        if (location.origin !== target.origin || location.pathname !== target.pathname || !location.searchParams.get('resource')) throw new Error('Invalid WebRTC resource');
        if (!active()) { void fetch(location, { method: 'DELETE', keepalive: true }).catch(() => {}); return; }
        resource = location.href;
        await connection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
        await flush();
      } catch (error) { if (active()) retry(error); }
    }
    void start();
    return { close() { closed = true; release(); }, restart() { retry(new Error('WebRTC playback stalled')); }, get peer() { return peer; } };
  }
