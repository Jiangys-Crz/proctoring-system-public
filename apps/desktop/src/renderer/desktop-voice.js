(function (root) {
  root.createProctorDesktopVoice = function (options) {
    let controller = null, contextKey = '', hideTimer = 0, ringTimer = 0, ringContext = null;
    const element = id => document.getElementById(id);
    function stopRing() { clearInterval(ringTimer); ringTimer = 0; void ringContext?.close().catch(() => {}); ringContext = null; }
    function ring() {
      if (ringTimer || !root.AudioContext) return;
      try { ringContext = new root.AudioContext(); } catch { return; }
      const beep = () => {
        if (!ringContext) return;
        const now = ringContext.currentTime;
        for (const offset of [0, .35]) {
          const tone = ringContext.createOscillator(), gain = ringContext.createGain();
          tone.frequency.value = 440; gain.gain.setValueAtTime(.06, now + offset); gain.gain.exponentialRampToValueAtTime(.001, now + offset + .25);
          tone.connect(gain); gain.connect(ringContext.destination); tone.start(now + offset); tone.stop(now + offset + .25);
        }
      };
      void ringContext.resume().then(beep).catch(() => {}); ringTimer = setInterval(beep, 2000);
    }
    function render(state) {
      clearTimeout(hideTimer);
      const incoming = state.phase === 'incoming', ended = ['ended', 'error', 'idle'].includes(state.phase);
      element('desktopVoicePanel').classList.toggle('hidden', state.phase === 'idle');
      element('desktopVoiceTitle').textContent = incoming ? `${state.call?.callerName || '监考老师'}来电` : '与监考老师语音通话';
      element('desktopVoiceStatus').textContent = state.message;
      element('desktopVoiceAccept').classList.toggle('hidden', !incoming);
      element('desktopVoiceMute').classList.toggle('hidden', !['connecting', 'active'].includes(state.phase));
      element('desktopVoiceMute').textContent = state.muted ? '取消静音' : '静音';
      element('desktopVoiceMute').setAttribute('aria-pressed', String(state.muted));
      element('desktopVoiceHangup').textContent = incoming ? '拒接' : ended ? '关闭' : '挂断';
      element('desktopVoicePlay').classList.toggle('hidden', !state.playbackBlocked);
      if (incoming) ring(); else stopRing();
      if (ended) hideTimer = setTimeout(() => element('desktopVoicePanel').classList.add('hidden'), 5000);
    }
    element('desktopVoiceAccept').addEventListener('click', () => { stopRing(); void controller?.accept(); });
    element('desktopVoiceMute').addEventListener('click', () => controller?.mute());
    element('desktopVoicePlay').addEventListener('click', () => void controller?.play());
    element('desktopVoiceHangup').addEventListener('click', () => {
      stopRing(); const phase = controller?.state.phase;
      if (['ended', 'error', 'idle'].includes(phase)) element('desktopVoicePanel').classList.add('hidden');
      else void controller?.hangup(phase === 'incoming' ? 'DECLINED' : 'HUNG_UP');
    });
    function stop() {
      contextKey = ''; clearTimeout(hideTimer); stopRing(); controller?.dispose(); controller = null;
      element('desktopVoicePanel').classList.add('hidden');
    }
    return {
      start() {
        const context = options.context();
        if (!context) { stop(); return; }
        const key = `${context.serverUrl}:${context.sessionId}:${context.token}`;
        if (key === contextKey) return;
        stop(); contextKey = key;
        controller = root.createProctorVoiceCall({ side: 'DESKTOP', sessionId: context.sessionId,
          audio: element('desktopVoiceAudio'), request: body => options.request(body, context),
          getMicrophone: options.getMicrophone, onState: render });
        controller.listen();
      }, stop
    };
  };
})(globalThis);
