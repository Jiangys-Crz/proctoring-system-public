(function (root) {
  const endMessages = { HUNG_UP: '通话已结束', CANCELLED: '呼叫已取消', DECLINED: '对方已拒接', UNANSWERED: '对方未接听',
    MICROPHONE: '麦克风不可用，通话已结束', NETWORK: '语音连接中断，请重新拨号', CLOSED: '通话窗口已关闭', SESSION_ENDED: '考试会话已结束' };
  function stopStream(stream) { stream?.getTracks().forEach(track => track.stop()); }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('通话已取消')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  root.createProctorVoiceCall = function (options) {
    let closed = false, generation = 0, call = null, stream = null, capturePending = false, mediaStarted = false;
    let timer = 0, polling = false, pollAgain = false, abort = null, lastPollAt = Date.now();
    const peers = new Set(), resources = new Set(), disconnected = new Map();
    const connected = { publish: false, read: false };
    let snapshot = { phase: 'idle', call: null, muted: false, playbackBlocked: false, message: '' };
    function emit(patch) { snapshot = { ...snapshot, ...patch }; if (!closed) options.onState?.({ ...snapshot }); }
    async function send(body) {
      let deadline;
      const epoch = generation;
      const request = Promise.resolve().then(() => options.request(body)).then(result => {
        // A timed-out or closed request can still have created server state.
        // Clean up late results even when the original await already ended.
        if (closed || generation !== epoch) {
          if (body.action === 'START' && result.call) void options.request({ action: 'END', callId: result.call.id, reason: 'CANCELLED' }).catch(() => {});
          if (body.action === 'MEDIA_OPEN' && result.ready) void options.request({ action: 'MEDIA_CLOSE', callId: body.callId, resource: result.resource }).catch(() => {});
        }
        return result;
      });
      try { return await Promise.race([request, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('语音请求超时，请检查连接')), 16000); })]); }
      finally { clearTimeout(deadline); }
    }
    function release() {
      generation++;
      abort?.abort(); abort = null;
      for (const timeout of disconnected.values()) clearTimeout(timeout);
      disconnected.clear();
      for (const peer of peers) { peer.onconnectionstatechange = null; peer.ontrack = null; peer.close(); }
      peers.clear();
      for (const resource of resources) void send({ action: 'MEDIA_CLOSE', callId: resource.callId, resource: resource.id }).catch(() => {});
      resources.clear();
      stopStream(stream); stream = null; capturePending = false; mediaStarted = false;
      connected.publish = false; connected.read = false;
      if (options.audio) { options.audio.pause(); options.audio.srcObject = null; }
    }
    function finish(reason, message) {
      const ended = call; call = null; release();
      emit({ phase: 'ended', call: ended, muted: false, playbackBlocked: false, message: message || endMessages[reason] || '通话已结束' });
    }
    function schedule(ms) {
      clearTimeout(timer);
      if (!closed && (options.side === 'DESKTOP' || call)) timer = setTimeout(() => void poll(), ms);
    }
    async function hangup(reason = 'HUNG_UP') {
      const ended = call;
      finish(reason);
      if (ended) await send({ action: 'END', callId: ended.id, reason }).catch(() => {});
      schedule(2500);
    }
    async function microphone() {
      const result = options.getMicrophone ? await options.getMicrophone() : await root.navigator.mediaDevices.getUserMedia({ video: false,
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!result?.getAudioTracks().some(track => track.readyState === 'live')) { stopStream(result); throw new Error('没有可用的麦克风，请连接麦克风后重试'); }
      return result;
    }
    function iceComplete(peer, signal) {
      if (peer.iceGatheringState === 'complete') return Promise.resolve();
      return new Promise((resolve, reject) => {
        function done(error) {
          clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', cancel);
          error ? reject(error) : resolve();
        }
        function changed() { if (peer.iceGatheringState === 'complete') done(); }
        function cancel() { done(new Error('通话已取消')); }
        const timeout = setTimeout(() => done(new Error('语音网络地址检测超时')), 5000);
        peer.addEventListener('icegatheringstatechange', changed); signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel(); else changed();
      });
    }
    async function openPeer(mode, current, epoch, signal) {
      const peer = new root.RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      peers.add(peer);
      const active = () => !closed && generation === epoch && call?.id === current.id && !signal.aborted;
      peer.onconnectionstatechange = () => {
        if (!active()) return;
        const state = peer.connectionState;
        connected[mode] = state === 'connected';
        clearTimeout(disconnected.get(peer)); disconnected.delete(peer);
        if (state === 'connected') { if (connected.publish && connected.read) void poll(); }
        else if (state === 'disconnected') disconnected.set(peer, setTimeout(() => { if (active()) void hangup('NETWORK'); }, 5000));
        else if (state === 'failed' || state === 'closed') void hangup('NETWORK');
      };
      if (mode === 'publish') {
        const track = stream.getAudioTracks()[0];
        track.enabled = !snapshot.muted;
        try { track.contentHint = 'speech'; } catch {}
        peer.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [{ maxBitrate: 32000 }] });
      } else {
        peer.addTransceiver('audio', { direction: 'recvonly' });
        peer.ontrack = event => {
          if (!active() || event.track.kind !== 'audio' || !options.audio) return;
          const received = options.audio.srcObject || new root.MediaStream();
          if (!received.getTracks().some(track => track.id === event.track.id)) received.addTrack(event.track);
          options.audio.srcObject = received; options.audio.muted = false;
          void options.audio.play().then(() => { if (active()) emit({ playbackBlocked: false }); }, () => { if (active()) emit({ playbackBlocked: true }); });
        };
      }
      await peer.setLocalDescription(await peer.createOffer());
      await iceComplete(peer, signal);
      const offer = peer.localDescription?.sdp;
      if (!offer) throw new Error('无法建立语音连接');
      const started = Date.now();
      while (active()) {
        const answer = await send({ action: 'MEDIA_OPEN', callId: current.id, mode, sdp: offer });
        if (answer.ready) {
          const resource = { id: answer.resource, callId: current.id };
          if (!active()) { void send({ action: 'MEDIA_CLOSE', callId: current.id, resource: resource.id }).catch(() => {}); return; }
          resources.add(resource);
          await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
          return;
        }
        if (mode !== 'read' || Date.now() - started > 20000) throw new Error('对方的语音尚未连接，请重新拨号');
        await delay(500, signal);
      }
    }
    function connect() {
      if (closed || !call || !stream || mediaStarted) return;
      mediaStarted = true; abort = new AbortController();
      const current = call, epoch = generation, signal = abort.signal;
      emit({ phase: 'connecting', message: '正在连接实时语音…' });
      void Promise.all([openPeer('publish', current, epoch, signal), openPeer('read', current, epoch, signal)]).catch(error => {
        if (!closed && generation === epoch && call?.id === current.id) { emit({ message: error.message || '语音连接失败' }); void hangup('NETWORK'); }
      });
    }
    function apply(next) {
      if (!next) { if (call) finish('CLOSED'); return; }
      if (next.status === 'ENDED') { call = next; finish(next.endReason); return; }
      if (call && call.id !== next.id) release();
      call = next;
      lastPollAt = Date.now();
      if (next.status === 'RINGING') emit({ call: next,
        phase: capturePending ? 'preparing' : options.side === 'ADMIN' ? 'ringing' : 'incoming',
        message: capturePending ? '正在打开麦克风…' : options.side === 'ADMIN' ? '正在呼叫电脑客户端…' : `${next.callerName || '监考老师'}来电` });
      else {
        emit({ call: next, phase: next.status === 'ACTIVE' && connected.publish && connected.read ? 'active' : 'connecting',
          message: next.status === 'ACTIVE' && connected.publish && connected.read ? '实时通话中' : '正在连接实时语音…' });
        connect();
      }
    }
    async function poll() {
      if (closed) return;
      if (polling) { pollAgain = true; return; }
      if (options.side === 'ADMIN' && !call) return;
      polling = true;
      const epoch = generation, id = call?.id;
      try {
        const result = await send({ action: 'POLL', ...(id ? { callId: id } : { sessionId: options.sessionId }), connected: connected.publish && connected.read });
        if (!closed && generation === epoch && call?.id === id) apply(result.call);
      } catch (error) {
        if (!closed && generation === epoch && call) {
          if (Date.now() - lastPollAt > 15000) void hangup('NETWORK');
          else emit({ message: '语音连接暂不可用，正在重试…' });
        }
      } finally {
        polling = false;
        const again = pollAgain; pollAgain = false;
        schedule(again ? 0 : call ? 1000 : 2500);
      }
    }
    async function start(sessionId) {
      if (closed || call || capturePending || options.side !== 'ADMIN') return;
      capturePending = true; const epoch = generation;
      emit({ phase: 'preparing', call: null, muted: false, message: '正在打开麦克风…' });
      try {
        const captured = await microphone();
        if (closed || generation !== epoch) { stopStream(captured); return; }
        stream = captured;
        const result = await send({ action: 'START', sessionId, target: 'DESKTOP' });
        if (closed || generation !== epoch) { stopStream(captured); if (result.call) void send({ action: 'END', callId: result.call.id, reason: 'CANCELLED' }).catch(() => {}); return; }
        capturePending = false; apply(result.call); schedule(0);
      } catch (error) { if (!closed && generation === epoch) { release(); emit({ phase: 'error', message: error.message || '无法访问麦克风' }); } }
    }
    async function accept() {
      if (closed || !call || call.status !== 'RINGING' || capturePending || options.side !== 'DESKTOP') return;
      const current = call, epoch = generation; capturePending = true;
      emit({ phase: 'preparing', message: '正在打开麦克风…' });
      try {
        const captured = await microphone();
        if (closed || generation !== epoch || call?.id !== current.id) { stopStream(captured); return; }
        stream = captured;
        const result = await send({ action: 'ACCEPT', callId: current.id });
        if (closed || generation !== epoch || call?.id !== current.id) return;
        capturePending = false; apply(result.call); schedule(0);
      } catch (error) {
        if (!closed && generation === epoch) { await hangup('MICROPHONE'); emit({ message: error.message || '无法访问麦克风' }); }
      }
    }
    return {
      start, accept, hangup, listen() { if (options.side === 'DESKTOP') schedule(0); },
      mute() { const muted = !snapshot.muted; stream?.getAudioTracks().forEach(track => { track.enabled = !muted; }); emit({ muted }); },
      async play() { try { await options.audio?.play(); emit({ playbackBlocked: false }); } catch { emit({ playbackBlocked: true }); } },
      get state() { return { ...snapshot }; },
      dispose() {
        if (closed) return;
        const ended = call; closed = true; call = null; clearTimeout(timer); release();
        if (ended) void send({ action: 'END', callId: ended.id, reason: 'CLOSED' }).catch(() => {});
      }
    };
  };
})(globalThis);
