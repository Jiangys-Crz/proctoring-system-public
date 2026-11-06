// Isolated synthetic media only. Uses the real WHIP/WHEP authorization and desktop recorder.
(function () {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = { errors: [], uploads: [], peers: {}, recorders: {}, streams: {}, locations: {}, clock: null, active: true };
  globalThis.reactionE2E = state;
  globalThis.startReactionPublisher = async function (fixture) {
    const headers = { 'x-proctor-session-token': fixture.clientToken };
    const samples = [];
    for (let index = 0; index < 5; index++) {
      const before = Date.now();
      const response = await fetch('/api/client/time?sessionId=' + encodeURIComponent(fixture.sessionId), { headers });
      if (!response.ok) throw new Error('Clock synchronization HTTP ' + response.status);
      const payload = await response.json(), after = Date.now();
      const value = payload.data?.serverTime ?? payload.data?.serverNow ?? payload.serverTime;
      const server = typeof value === 'number' ? value : Date.parse(value);
      if (!Number.isFinite(server)) throw new Error('Clock response lacks serverTime');
      samples.push({ clockOffsetMs: server - (before + after) / 2, clockUncertaintyMs: (after - before) / 2 });
      await sleep(50);
    }
    state.clock = samples.sort((a, b) => a.clockUncertaintyMs - b.clockUncertaintyMs)[0];
    const channels = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA'];
    const canvases = channels.map((channel, index) => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = index ? 480 : 360;
      canvas.style.width = '48%'; document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      const draw = () => {
        const now = Date.now() + state.clock.clockOffsetMs;
        ctx.fillStyle = index ? '#10283f' : '#1c2842'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 25px monospace';
        ctx.fillText((index ? 'SIMULATED CAMERA / ' : 'SIMULATED DESKTOP / ') + (fixture.examNumber || 'team007'), 12, 42);
        ctx.font = 'bold 25px monospace'; ctx.fillText(new Date(now).toISOString(), 12, 90);
        ctx.font = '17px monospace'; ctx.fillText('Server clock / milliseconds / Reaction E2E', 12, 124);
        const x = 35 + ((now % 5000) / 5000) * 550;
        ctx.fillStyle = index ? '#fbbf24' : '#38bdf8'; ctx.beginPath(); ctx.arc(x, 220, 28, 0, Math.PI * 2); ctx.fill();
        ctx.font = '18px monospace'; ctx.fillText('Frame epoch: ' + Math.floor(now / 33.333), 12, canvas.height - 20);
      };
      draw();
      const interval = setInterval(draw, 1000 / 30);
      state.streams[channel] = canvas.captureStream(30);
      return { canvas, interval };
    });
    state.canvases = canvases;
    async function publish(channel) {
      const peer = new RTCPeerConnection({ iceServers: [] });
      state.peers[channel] = peer;
      state.streams[channel].getTracks().forEach(track => peer.addTrack(track, state.streams[channel]));
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== 'complete') await new Promise(resolve => {
        const deadline = setTimeout(resolve, 3000);
        peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(deadline); resolve(); } });
      });
      const url = '/api/client/whip?sessionId=' + encodeURIComponent(fixture.sessionId) + '&channel=' + channel;
      const response = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/sdp' }, body: peer.localDescription.sdp });
      if (!response.ok) throw new Error(channel + ' WHIP HTTP ' + response.status + ': ' + (await response.text()).slice(0, 150));
      state.locations[channel] = response.headers.get('location');
      await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
      const deadline = Date.now() + 20000;
      while (peer.connectionState !== 'connected' && Date.now() < deadline) await sleep(100);
      if (peer.connectionState !== 'connected') throw new Error(channel + ' WHIP ICE ' + peer.connectionState);
    }
    await Promise.all(channels.map(publish));
    channels.forEach(channel => {
      state.recorders[channel] = createProctorRecordingController({
        channel, sessionId: fixture.sessionId, stream: state.streams[channel], segmentMs: 10000,
        recorderOptions: { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 800000 },
        isActive: () => state.active, getContext: () => ({ ...state.clock }),
        onError: error => state.errors.push(String(error?.message || error)),
        onSave: async (blob, filename, meta) => {
          let message = '';
          for (let attempt = 0; attempt < 4; attempt++) {
            const form = new FormData(); form.set('file', blob, filename);
            Object.entries({ ...meta, ...state.clock, examId: fixture.examId, candidateId: fixture.candidateId }).forEach(([key, value]) => form.set(key, String(value)));
            const response = await fetch('/api/client/upload', { method: 'POST', headers, body: form });
            const payload = await response.json();
            if (response.ok && !payload.data?.discarded) {
              state.uploads.push({ ...meta, byteSize: blob.size, segmentId: payload.data?.segment?.id, uploadedAt: new Date().toISOString() }); return;
            }
            message = 'Upload ' + channel + ' HTTP ' + response.status + ': ' + (payload.message || payload.data?.reason || 'discarded');
            await sleep(500 * 2 ** attempt);
          }
          throw new Error(message);
        }
      });
    });
    state.stopChannel = async channel => {
      await state.recorders[channel]?.stop();
      state.peers[channel]?.close();
      if (state.locations[channel]) await fetch(state.locations[channel], { method: 'DELETE', headers });
      state.streams[channel]?.getTracks().forEach(track => track.stop());
    };
    state.stop = async () => {
      state.active = false;
      await Promise.all(channels.map(state.stopChannel));
      canvases.forEach(value => clearInterval(value.interval));
    };
    return { clock: state.clock, channels: channels.map(channel => ({ channel, connectionState: state.peers[channel].connectionState })) };
  };
  globalThis.startReactionViewers = async function (fixture) {
    const { createProctorWebRtcReader } = await import('/live-webrtc.js');
    state.readers = [];
    ['DESKTOP_SCREEN', 'DESKTOP_CAMERA'].forEach((channel, index) => {
      const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true; video.style.width = '48%';
      video.dataset.channel = channel; document.body.appendChild(video);
      const reader = createProctorWebRtcReader({
        url: '/api/media/whep?sessionId=' + encodeURIComponent(fixture.sessionId) + '&channel=' + channel,
        onTrack: event => { if (event.track.kind === 'video') { video.srcObject = event.streams[0] || new MediaStream([event.track]); video.play().catch(() => {}); } },
        onError: error => state.errors.push(channel + ' reader: ' + error.message)
      });
      state.readers.push({ channel, reader, video });
    });
    state.readerStats = async () => Promise.all(state.readers.map(async ({ channel, reader, video }) => {
      let framesDecoded = 0, bytesReceived = 0;
      if (reader.peer) for (const item of (await reader.peer.getStats()).values()) if (item.type === 'inbound-rtp' && item.kind === 'video') { framesDecoded += item.framesDecoded || 0; bytesReceived += item.bytesReceived || 0; }
      return { channel, connectionState: reader.peer?.connectionState, width: video.videoWidth, height: video.videoHeight, framesDecoded, bytesReceived };
    }));
    state.closeReaders = () => state.readers.forEach(value => value.reader.close());
  };
})();
