(function (root) {
  root.createProctorMicrophoneCapture = function (options = {}) {
    let source = null, pending = null, epoch = 0, retryAt = 0;
    const attached = new WeakMap();
    const liveTrack = () => source?.getAudioTracks().find(track => track.readyState === 'live');
    async function acquire(force = false) {
      if (liveTrack()) return true;
      if (pending) return pending;
      if (!force && root.performance.now() < retryAt) return false;
      const current = epoch;
      let expired = false, timer;
      const request = Promise.resolve().then(() => root.navigator.mediaDevices.getUserMedia({ video: false,
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })).then(stream => {
        if (expired || current !== epoch) { stream.getTracks().forEach(track => track.stop()); throw new Error('麦克风采集请求已失效'); }
        return stream;
      });
      const bounded = Promise.race([request, new Promise((_, reject) => {
        timer = root.setTimeout(() => { expired = true; reject(new Error('麦克风采集启动超时')); }, 15000);
      })]);
      const task = bounded.then(stream => {
        if (current !== epoch) { stream.getTracks().forEach(track => track.stop()); return false; }
        const track = stream.getAudioTracks().find(item => item.readyState === 'live');
        if (!track) { stream.getTracks().forEach(item => item.stop()); throw new Error('没有检测到可用的电脑麦克风'); }
        source?.getTracks().forEach(item => item.stop()); source = stream; retryAt = 0;
        track.addEventListener('ended', () => { if (current === epoch && source === stream) options.onUnavailable?.('电脑麦克风已断开'); }, { once: true });
        options.onReady?.(); return true;
      }).catch(error => {
        if (current === epoch) {
          retryAt = root.performance.now() + 30000;
          const message = error.name === 'NotAllowedError' ? '尚未允许麦克风权限' : error.name === 'NotFoundError' ? '未检测到麦克风' : error.name === 'NotReadableError' ? '麦克风被占用或设备无法打开' : '电脑麦克风暂不可用';
          options.onUnavailable?.(message);
        }
        return false;
      }).finally(() => { root.clearTimeout(timer); if (pending === task) pending = null; });
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
