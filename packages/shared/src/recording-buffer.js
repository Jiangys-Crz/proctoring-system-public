(function (root) {
  root.createProctorRecordingStream = function (source, options) {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = source;
    const canvas = document.createElement('canvas');
    canvas.width = options.width; canvas.height = options.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context || !canvas.captureStream) throw new Error('当前设备无法生成压缩录像');
    const stream = canvas.captureStream(options.frameRate);
    for (const track of source.getAudioTracks()) stream.addTrack(track.clone());
    const paint = () => {
      if (video.readyState >= 2) context.drawImage(video, 0, 0, canvas.width, canvas.height);
    };
    const timer = setInterval(paint, 1000 / options.frameRate);
    let stopped = false;
    function stop() {
      if (stopped) return;
      stopped = true; clearInterval(timer);
      video.pause(); video.srcObject = null;
      stream.getTracks().forEach(track => track.stop());
    }
    void video.play().catch(error => { stop(); options.onError(error); });
    return { stream, stop };
  };
  root.proctorRecordingEnabled = function (requirements) {
    return requirements?.isPublicTest !== true && (requirements?.saveFullRecording === true || requirements?.saveIncidentRecording === true);
  };
  // At most one minute stays in memory when recording is explicitly enabled.
  root.createProctorRecordingBuffer = function (options) {
    const clips = new Map();
    const windows = new Map();
    const saved = new Set();
    const now = options.now || Date.now;
    function prune() {
      const cutoff = now() - 60000;
      for (const [id, clip] of clips) if (Date.parse(clip.endedAt) < cutoff) { clips.delete(id); saved.delete(id); }
      for (const [id, window] of windows) if (window.end < cutoff) windows.delete(id);
    }
    function drain() {
      prune();
      const full = options.saveFull();
      const incidents = options.saveIncidents?.() === true;
      if (!incidents) windows.clear();
      if (!full && !incidents) { clips.clear(); saved.clear(); return Promise.resolve(); }
      const tasks = [];
      for (const [id, clip] of clips) {
        if (saved.has(id)) continue;
        const start = Date.parse(clip.startedAt), end = Date.parse(clip.endedAt);
        if (!full && ![...windows.values()].some(window => start < window.end && end > window.start)) continue;
        saved.add(id);
        tasks.push(Promise.resolve().then(() => {
          const currentFull = options.saveFull();
          if (!currentFull && !(options.saveIncidents?.() === true && [...windows.values()].some(window => start < window.end && end > window.start))) {
            saved.delete(id);
            if (options.saveIncidents?.() !== true) { clips.delete(id); windows.clear(); }
            return;
          }
          return options.onSave(clip, !currentFull);
        }).catch(error => { saved.delete(id); throw error; }));
      }
      return Promise.all(tasks).then(() => {});
    }
    return {
      add(clip) { clips.set(clip.id, clip); return drain(); },
      mark(event) {
        if (options.saveIncidents?.() !== true) { windows.clear(); return drain(); }
        const at = Date.parse(event.occurredAt);
        if (!Number.isFinite(at)) return Promise.resolve();
        windows.set(event.id, { start: at - 20000, end: at + 20000 });
        return drain();
      },
      clear() { clips.clear(); windows.clear(); saved.clear(); },
      get size() { prune(); return clips.size; }
    };
  };
  root.proctorEvidenceChannel = function (type, alert = {}) {
    if (type === 'MOBILE_CAMERA_LOST' || type === 'SECOND_CAMERA_OFFLINE') return 'MOBILE_CAMERA';
    if (type === 'SCREEN_SWITCH' && (alert.id?.startsWith('mobile_alert_') || alert.message?.includes('第二机位'))) return 'MOBILE_CAMERA';
    if (type === 'CAMERA_CAPTURE_LOST') return 'DESKTOP_CAMERA';
    return 'DESKTOP_SCREEN';
  };
})(globalThis);
