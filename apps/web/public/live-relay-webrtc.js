// Dedicated relay reader: original WebRTC media, no HLS segments or seek buffer.
export function createRelayWebRtcReader({ url, video, onStatus }) {
  const target = new URL(url, location.href);
  let closed = false, generation = 0, peer = null, resource = '', abort = null;
  let retryTimer, connectTimer, disconnectTimer, retries = 0, lastTime = -1, lastFrame = Date.now();
  const status = text => onStatus?.(text);
  function release() {
    generation++; clearTimeout(retryTimer); clearTimeout(connectTimer); clearTimeout(disconnectTimer);
    abort?.abort(); abort = null; peer?.close(); peer = null;
    const old = resource; resource = '';
    if (old) void fetch(old, { method: 'DELETE', keepalive: true }).catch(() => {});
    video.pause(); video.srcObject = null;
  }
  function retry() {
    if (closed) return;
    release(); status('连接中断，正在重连…');
    retryTimer = setTimeout(start, Math.min(8000, 500 * 2 ** Math.min(retries++, 4)) + Math.random() * 250);
  }
  async function start() {
    if (closed) return;
    const current = ++generation, active = () => !closed && generation === current;
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    peer = pc; abort = new AbortController(); const signal = abort.signal;
    let offer = '', pending = [], flushing = false;
    const media = new MediaStream(); video.srcObject = media; status('正在连接实时直播…');
    function fragment(candidates) {
      const lines = offer.split(/\r?\n/), medias = lines.filter(x => x.startsWith('m='));
      let text = lines.filter(x => /^a=ice-(ufrag|pwd):/.test(x)).slice(0, 2).join('\r\n') + '\r\n';
      for (const index of new Set(candidates.map(c => c.sdpMLineIndex))) {
        const rows = candidates.filter(c => c.sdpMLineIndex === index);
        if (!medias[index]) continue;
        text += medias[index] + '\r\na=mid:' + rows[0].sdpMid + '\r\n';
        text += rows.map(c => 'a=' + c.candidate + '\r\n').join('');
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
          if (response.status !== 204) throw new Error('ICE exchange failed');
        }
      } catch { if (active()) retry(); }
      finally { flushing = false; }
    }
    for (const kind of ['video', 'audio']) pc.addTransceiver(kind, { direction: 'recvonly' });
    pc.onicecandidate = e => { if (active() && e.candidate) { pending.push(e.candidate); void flush(); } };
    pc.ontrack = e => {
      if (!active()) return;
      // These are optional browser hints, not a reason to reject older browsers.
      try { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0; } catch {}
      try { if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0; } catch {}
      if (!media.getTracks().some(t => t.id === e.track.id)) media.addTrack(e.track);
      void video.play().catch(() => status('点击播放以观看直播'));
    };
    pc.onconnectionstatechange = () => {
      if (!active()) return;
      clearTimeout(disconnectTimer);
      if (pc.connectionState === 'connected') { clearTimeout(connectTimer); retries = 0; lastFrame = Date.now(); }
      else if (pc.connectionState === 'disconnected') disconnectTimer = setTimeout(() => { if (active()) retry(); }, 2500);
      else if (['failed', 'closed'].includes(pc.connectionState)) retry();
    };
    connectTimer = setTimeout(() => { if (active()) retry(); }, 15000);
    try {
      await pc.setLocalDescription(await pc.createOffer()); offer = pc.localDescription.sdp;
      const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: offer, signal });
      if ([401, 403].includes(response.status)) { if (active()) { closed = true; release(); status('直播密钥或授权已失效'); } return; }
      if (response.status !== 201) throw new Error('Signaling failed');
      const next = new URL(response.headers.get('location') || '', target);
      if (next.origin !== target.origin || next.pathname !== target.pathname || !next.searchParams.get('resource')) throw new Error('Invalid resource');
      if (!active()) { void fetch(next, { method: 'DELETE', keepalive: true }).catch(() => {}); return; }
      resource = next.href;
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() }); await flush();
    } catch { if (active()) retry(); }
  }
  const playing = () => { if (!closed) { status(''); lastFrame = Date.now(); } };
  video.addEventListener('playing', playing);
  const watch = setInterval(() => {
    if (closed || document.hidden || video.paused || peer?.connectionState !== 'connected') return;
    if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastFrame = Date.now(); }
    else if (Date.now() - lastFrame > 8000) retry();
  }, 2000);
  const online = () => { if (!closed) retry(); };
  window.addEventListener('online', online);
  void start();
  return { close() { closed = true; clearInterval(watch); window.removeEventListener('online', online); video.removeEventListener('playing', playing); release(); }, restart: retry };
}
