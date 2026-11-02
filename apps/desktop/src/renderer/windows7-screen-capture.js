(function (root) {
  // One decoded bitmap and one IPC read at a time: slow Windows 7 machines
  // discard older frames at the producer instead of growing a media queue.
  root.proctorCaptureWindows7Screen = async function (api) {
    const id = await api.startWindows7ScreenCapture();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    let closed = false, sequence = 0, track;
    const close = () => {
      if (closed) return;
      closed = true;
      void api.stopWindows7ScreenCapture(id).catch(() => {});
    };
    const draw = async () => {
      const frame = await api.readWindows7ScreenFrame(id, sequence);
      if (closed) return;
      const bitmap = await createImageBitmap(new Blob([frame.jpeg], { type: 'image/jpeg' }));
      try {
        if (closed) return;
        if (!bitmap.width || !bitmap.height || bitmap.width > 1920 || bitmap.height > 1080) throw new Error('完整屏幕尺寸异常');
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width; canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        sequence = frame.sequence;
        track?.requestFrame?.();
      } finally { bitmap.close(); }
    };
    try {
      await draw();
      if (!sequence) throw new Error('未收到完整屏幕画面');
      const stream = canvas.captureStream(15);
      track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { close(); stop(); };
      track.addEventListener('ended', close, { once: true });
      void (async () => {
        try { while (!closed) await draw(); }
        catch (error) {
          if (closed) return;
          console.warn('[windows7-screen]', error);
          close(); stop();
          track.dispatchEvent(new Event('ended'));
        }
      })();
      return stream;
    } catch (error) { close(); throw error; }
  };
})(globalThis);
