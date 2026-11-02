(function (root) {
  root.createProctorMicrophoneCapture = function (options = {}) {
    let source = null, pending = null, epoch = 0, retryAt = 0;
    const attached = new WeakMap();
    const liveTrack = () => source?.getAudioTracks().find(track => track.readyState === 'live');
    async function acquire(force = false) {
      if (liveTrack()) return true;
      if (pending) return pending;
      if (!force && Date.now() < retryAt) return false;
      const current = epoch;
      const request = root.navigator.mediaDevices.getUserMedia({ video: false,
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const task = request.then(stream => {
        if (current !== epoch) { stream.getTracks().forEach(track => track.stop()); return false; }
        const track = stream.getAudioTracks().find(item => item.readyState === 'live');
        if (!track) { stream.getTracks().forEach(item => item.stop()); throw new Error('没有检测到可用的电脑麦克风'); }
        source?.getTracks().forEach(item => item.stop()); source = stream; retryAt = 0;
        track.addEventListener('ended', () => { if (current === epoch && source === stream) options.onUnavailable?.('电脑麦克风已断开'); }, { once: true });
        options.onReady?.(); return true;
      }).catch(error => {
        if (current === epoch) {
          retryAt = Date.now() + 30000;
          const message = error.name === 'NotAllowedError' ? '尚未允许麦克风权限' : error.name === 'NotFoundError' ? '未检测到麦克风' : error.name === 'NotReadableError' ? '麦克风被占用或设备无法打开' : '电脑麦克风暂不可用';
          options.onUnavailable?.(message);
        }
        return false;
      }).finally(() => { if (pending === task) pending = null; });
      pending = task; return task;
    }
    return {
      acquire,
      attach(stream) {
        const track = liveTrack();
        if (!stream || !track || attached.get(stream) === track && stream.getAudioTracks().some(item => item.readyState === 'live')) return false;
        for (const previous of stream.getAudioTracks()) { stream.removeTrack(previous); previous.stop(); }
        // Screen recovery and call mute own their clones, never the shared mic.
        stream.addTrack(track.clone()); attached.set(stream, track); return true;
      },
      async clone() {
        if (!await acquire(true)) throw new Error('当前电脑没有可用麦克风，请连接麦克风并检查系统权限');
        return new root.MediaStream([liveTrack().clone()]);
      },
      stop() { epoch++; pending = null; retryAt = 0; source?.getTracks().forEach(track => track.stop()); source = null; },
      get available() { return Boolean(liveTrack()); }
    };
  };
})(globalThis);
