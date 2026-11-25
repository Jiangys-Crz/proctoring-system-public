(() => {
  'use strict';
  const webview = window.chrome?.webview;
  const media = navigator.mediaDevices;
  if (window !== window.top || location.origin !== 'https://proctor-client.invalid' ||
      location.pathname !== '/index.html' || !webview || !media?.getUserMedia) return;

  const pending = new Map();
  let requestId = 0;
  webview.addEventListener('message', ({ data }) => {
    const request = pending.get(data?.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.ok) request.resolve(data.value);
    else request.reject(new Error(data.error));
  });
  function invoke(channel, ...args) {
    return new Promise((resolve, reject) => {
      const id = 'capture-' + ++requestId;
      pending.set(id, { resolve, reject });
      try {
        webview.postMessage({ id, channel, args });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  let binaryUnavailable = false;
  async function readFrame(lease, sequence, signal, fallback) {
    if (binaryUnavailable) return fallback();
    let response;
    try {
      // This synthetic host is intercepted by the trusted WebView2 shell.
      // No network server listens for frame requests.
      response = await fetch(`https://proctor-media.invalid/frame/${lease}/${sequence}`, {
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal
      });
    } catch (error) {
      if (signal.aborted) throw error;
      binaryUnavailable = true;
      return fallback();
    }
    if (!response.ok) throw new Error(await response.text() || '完整屏幕采集已停止');
    const next = Number(response.headers.get('X-Proctor-Frame-Sequence'));
    if (!Number.isSafeInteger(next) || next <= sequence) throw new Error('完整屏幕采集帧顺序异常');
    return { sequence: next, jpeg: response.status === 204 ? null : await response.blob() };
  }

  async function capture(source, fps, width, height, windows7Api = null) {
    const lease = windows7Api ? await windows7Api.startWindows7ScreenCapture()
      : await invoke('desktop:captureStart', source, fps, width, height);
    const abort = new AbortController();
    let closed = false;
    let bitmap;
    function close() {
      if (closed) return;
      closed = true;
      abort.abort();
      bitmap?.close();
      bitmap = undefined;
      const stop = windows7Api ? windows7Api.stopWindows7ScreenCapture(lease) : invoke('desktop:captureStop', lease);
      void stop.catch(() => {});
    }
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('无法创建屏幕画面');
      let sequence = 0;
      let track;
      async function legacyRead() {
        if (windows7Api) return windows7Api.readWindows7ScreenFrame(lease, sequence);
        const frame = await invoke('desktop:captureRead', lease, sequence);
        const bytes = atob(frame.jpeg);
        return { sequence: frame.sequence, jpeg: Uint8Array.from(bytes, char => char.charCodeAt(0)) };
      }
      async function draw() {
        const frame = await readFrame(lease, sequence, abort.signal, legacyRead);
        if (closed) return;
        if (frame.jpeg) {
          const image = frame.jpeg instanceof Blob ? frame.jpeg : new Blob([frame.jpeg], { type: 'image/jpeg' });
          const next = await createImageBitmap(image);
          if (closed) { next.close(); return; }
          if (!next.width || !next.height || next.width > width || next.height > height) {
            next.close();
            throw new Error('完整屏幕尺寸异常');
          }
          bitmap?.close();
          bitmap = next;
        }
        if (!bitmap) throw new Error('未收到完整屏幕画面');
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        // Paint each capture tick so live video and evidence keep their cadence.
        // Identical desktops reuse the decoded bitmap for that paint.
        context.drawImage(bitmap, 0, 0);
        sequence = frame.sequence;
        track?.requestFrame?.();
      }

      await draw();
      const stream = canvas.captureStream(fps);
      track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { close(); stop(); };
      track.addEventListener('ended', close, { once: true });
      void (async () => {
        try {
          while (!closed) await draw();
        } catch (error) {
          if (closed) return;
          console.warn('[desktop-screen]', error);
          track.stop();
          track.dispatchEvent(new Event('ended'));
        }
      })();
      return stream;
    } catch (error) {
      close();
      throw error;
    }
  }

  Object.defineProperty(window, '__proctorCaptureWindows7', {
    value: api => capture('', 15, 1920, 1080, api)
  });

  // The legacy renderer passes Electron desktop source constraints. Supply the
  // same track to the preview, WHIP publisher and recorder without a new picker.
  const original = media.getUserMedia.bind(media);
  media.getUserMedia = options => {
    const mandatory = options?.video?.mandatory;
    if (options?.audio !== false || !['desktop', 'screen'].includes(mandatory?.chromeMediaSource)) {
      return original(options);
    }
    const source = mandatory.chromeMediaSource === 'desktop' ? mandatory.chromeMediaSourceId : '';
    if (typeof source !== 'string' || (source && !/^screen:\d+:0$/.test(source))) return original(options);
    const { maxFrameRate = 30, maxWidth = 1920, maxHeight = 1080 } = mandatory;
    return capture(source, maxFrameRate, maxWidth, maxHeight);
  };

  // Electron's display-media callback also selected the primary display
  // automatically. Keep the existing basic and low-rate fallback requests.
  const originalDisplay = media.getDisplayMedia?.bind(media);
  media.getDisplayMedia = options => {
    if (options?.audio !== false || !options?.video) {
      return originalDisplay ? originalDisplay(options) : Promise.reject(new Error('屏幕共享不可用'));
    }
    const { frameRate, width, height } = options.video;
    return capture('', frameRate?.ideal ?? frameRate?.max ?? 30,
      width?.ideal ?? width?.max ?? 1920, height?.ideal ?? height?.max ?? 1080);
  };
})();
