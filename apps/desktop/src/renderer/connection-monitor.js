(function (root) {
  root.createExamConnectionMonitor = function ({ now = () => performance.now(), changed, timeoutMs = 15000 }) {
    let active = false, phase = 'checking', lastContactAt = 0, offlineSince = null, dismissed = false;
    const snapshot = () => ({
      active, phase,
      offlineSeconds: offlineSince === null ? 0 : Math.max(0, Math.floor((now() - offlineSince) / 1000)),
      warning: active && offlineSince !== null && now() - offlineSince >= timeoutMs && !dismissed
    });
    const emit = () => { const value = snapshot(); changed(value); return value; };
    return {
      start() { active = true; phase = 'checking'; lastContactAt = now(); offlineSince = null; dismissed = false; return emit(); },
      stop() { active = false; offlineSince = null; dismissed = false; return emit(); },
      connected() { if (!active) return snapshot(); lastContactAt = now(); phase = 'connected'; offlineSince = null; dismissed = false; return emit(); },
      disconnected() { if (!active) return snapshot(); if (offlineSince === null) offlineSince = now(); phase = 'offline'; return emit(); },
      tick() {
        if (active && offlineSince === null && now() - lastContactAt >= timeoutMs) {
          offlineSince = lastContactAt; phase = 'offline';
        }
        return emit();
      },
      dismiss() { dismissed = true; return emit(); },
      snapshot
    };
  };
})(globalThis);
