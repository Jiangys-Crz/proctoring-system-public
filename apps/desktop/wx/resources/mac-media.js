(() => {
  'use strict';
  const webview = window.chrome?.webview;
  const media = navigator.mediaDevices;
  if (window !== window.top || location.origin !== window.__proctorShellOrigin ||
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

  async function paintFrame(context, jpeg, width, height) {
    // Older WKWebView versions do not provide createImageBitmap.
    const url = URL.createObjectURL(jpeg);
    try {
      const image = await new Promise((resolve, reject) => {
        const frame = new Image();
        frame.onload = () => resolve(frame);
        frame.onerror = () => reject(new Error('屏幕画面解码失败'));
        frame.src = url;
      });
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > width || image.naturalHeight > height) {
        throw new Error('完整屏幕尺寸异常');
      }
      const canvas = context.canvas;
      if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      context.drawImage(image, 0, 0);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function capture(source, fps, width, height) {
    if (!HTMLCanvasElement.prototype.captureStream) throw new Error('当前 macOS 无法创建屏幕视频轨道');
    const lease = await invoke('desktop:captureStart', source, fps, width, height);
    const read = new AbortController();
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      read.abort();
      void invoke('desktop:captureStop', lease).catch(() => {});
    }

    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('无法创建屏幕画面');
      let sequence = 0;
      let track;
      async function draw() {
        const response = await fetch('/capture-frame/' + sequence, {
          headers: { 'X-Proctor-Capture-Lease': lease },
          mode: 'same-origin', credentials: 'omit', cache: 'no-store',
          referrerPolicy: 'same-origin', signal: read.signal
        });
        if (closed) return;
        if (response.status === 204) {
          // ScreenCaptureKit pauses on static surfaces. Keep submitting the
          // last picture without another JPEG encode, transfer or decode.
          if (track && sequence > 0) context.drawImage(canvas, 0, 0);
        } else {
          if (!response.ok) throw new Error(await response.text() || '屏幕画面读取失败');
          const next = Number(response.headers.get('X-Proctor-Frame-Sequence'));
          if (!Number.isSafeInteger(next) || next <= sequence) throw new Error('屏幕画面顺序无效');
          await paintFrame(context, await response.blob(), width, height);
          sequence = next;
        }
        if (closed) return;
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

  // Preserve the renderer's desktop source selection. Camera and microphone
  // requests still run through WKWebView and its native permission delegate.
  const originalUserMedia = media.getUserMedia.bind(media);
  media.getUserMedia = options => {
    const mandatory = options?.video?.mandatory;
    if (options?.audio !== false || !['desktop', 'screen'].includes(mandatory?.chromeMediaSource)) {
      return originalUserMedia(options);
    }
    const source = mandatory.chromeMediaSource === 'desktop' ? mandatory.chromeMediaSourceId : '';
    if (typeof source !== 'string' || (source && !/^screen:\d+:0$/.test(source))) return originalUserMedia(options);
    const { maxFrameRate = 30, maxWidth = 1920, maxHeight = 1080 } = mandatory;
    return capture(source, maxFrameRate, maxWidth, maxHeight);
  };

  const originalDisplayMedia = media.getDisplayMedia?.bind(media);
  media.getDisplayMedia = options => {
    if (options?.audio !== false || !options?.video) {
      return originalDisplayMedia
        ? originalDisplayMedia(options)
        : Promise.reject(new Error('屏幕共享不可用'));
    }
    const { frameRate, width, height } = options.video;
    return capture('', frameRate?.ideal ?? frameRate?.max ?? 30,
      width?.ideal ?? width?.max ?? 1920, height?.ideal ?? height?.max ?? 1080);
  };
})();
