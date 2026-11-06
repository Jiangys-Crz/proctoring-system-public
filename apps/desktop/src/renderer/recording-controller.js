(function (root) {
  root.proctorUploadId = function () {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  // Each controller owns one channel, one stream, and one recorder at a time.
  // Saving a completed segment must not block capture of the following segment.
  root.createProctorRecordingController = function (options) {
    const pending = new Set();
    let timer = 0;
    let current = null;
    const controller = {
      channel: options.channel,
      stream: options.sourceStream || options.stream,
      sessionId: options.sessionId,
      stopped: false,
      flush() { if (current?.recorder.state === 'recording') current.stop(); },
      stop() {
        controller.stopped = true;
        clearTimeout(timer);
        const segment = current;
        segment?.stop();
        return Promise.allSettled([...(segment ? [segment.done] : []), ...pending]).finally(() => options.onStopped?.());
      }
    };

    function next() {
      if (controller.stopped || !options.isActive() || !options.stream.active) {
        controller.stopped = true;
        options.onStopped?.();
        return;
      }
      let complete;
      const done = new Promise((resolve) => { complete = resolve; });
      const context = options.getContext();
      const clockOffsetMs = Number.isFinite(context.clockOffsetMs) ? context.clockOffsetMs : 0;
      const startedAt = new Date(Date.now() + clockOffsetMs).toISOString();
      const uploadId = root.proctorUploadId();
      const chunks = [];
      let delivered = false;
      try {
        const recorder = new MediaRecorder(options.stream, options.recorderOptions);
        const segment = {
          recorder, done, endedAt: null,
          stop() {
            if (recorder.state === 'inactive') return;
            // Encoder finalization/onstop can arrive much later than stop().
            // That wait is not captured footage and must not extend the clip.
            segment.endedAt ??= new Date(Date.now() + clockOffsetMs).toISOString();
            recorder.stop();
          }
        };
        current = segment;
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = (event) => {
          controller.stopped = true;
          clearTimeout(timer);
          segment.stop();
          options.onError(event.error || new Error('录像编码失败'));
        };
        recorder.onstop = () => {
          if (delivered) return;
          delivered = true;
          clearTimeout(timer);
          // A source ending or encoder stopping itself may have no stop request.
          // Keep the observed fallback; server media/clock checks still apply.
          const endedAt = segment.endedAt || new Date(Date.now() + clockOffsetMs).toISOString();
          current = null;
          if (!controller.stopped) timer = setTimeout(next, 0);
          const save = Promise.resolve().then(() => {
            if (!chunks.length) return;
            const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
            return options.onSave(blob, `${options.channel}-${uploadId}.webm`, {
              sessionId: options.sessionId, channel: options.channel, uploadId, startedAt, endedAt,
              ...(Number.isFinite(context.clockOffsetMs) ? { clockOffsetMs: String(clockOffsetMs), clockUncertaintyMs: String(context.clockUncertaintyMs) } : {})
            }, context);
          }).catch(options.onError).finally(() => {
            if (controller.stopped) options.onStopped?.();
            pending.delete(save);
            complete();
          });
          pending.add(save);
        };
        recorder.start();
        timer = setTimeout(() => {
          if (recorder.state === 'recording') segment.stop();
        }, options.segmentMs || 10000);
      } catch (error) {
        controller.stopped = true;
        current = null;
        complete();
        options.onError(error);
        options.onStopped?.();
      }
    }
    next();
    return controller;
  };
})(globalThis);
