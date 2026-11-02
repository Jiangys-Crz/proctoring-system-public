export interface RecordedClip {
  blob: Blob;
  startedAt: string;
  endedAt: string;
}

/** Each recorder owns its buffers and timer, including its final asynchronous stop event. */
export function startSegmentRecorder(options: {
  stream: MediaStream;
  mimeType: string;
  isCurrent: () => boolean;
  onClip: (clip: RecordedClip) => void | Promise<void>;
  onError: (error: unknown) => void;
  onStopped?: () => void;
  intervalMs?: number;
}) {
  let stopped = false;
  let recorder: MediaRecorder | null = null;
  let stopCurrent: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recordingDone: Promise<void> = Promise.resolve();
  const pending = new Set<Promise<void>>();
  let released = false;
  const release = () => { if (!released) { released = true; options.onStopped?.(); } };
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const recordNext = () => {
    if (stopped || !options.isCurrent() || !options.stream.getVideoTracks().some(track => track.readyState === 'live')) { stopped = true; release(); return; }
    let complete!: () => void;
    recordingDone = new Promise(resolve => { complete = resolve; });
    try {
      const current = new MediaRecorder(options.stream, { mimeType: options.mimeType, videoBitsPerSecond: 600_000, audioBitsPerSecond: 32_000 });
      recorder = current;
      const chunks: Blob[] = [];
      const startedAt = new Date().toISOString();
      let endedAt: string | undefined;
      let delivered = false;
      const requestStop = () => {
        if (current.state === 'inactive') return;
        endedAt = new Date().toISOString();
        current.stop();
      };
      stopCurrent = requestStop;
      current.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      current.onerror = event => {
        stopped = true;
        clearTimer();
        requestStop();
        options.onError(event);
      };
      current.onstop = () => {
        if (delivered) return;
        delivered = true;
        clearTimer();
        if (recorder === current) recorder = null;
        const blob = new Blob(chunks, { type: current.mimeType || options.mimeType });
        const saving = Promise.resolve().then(() => {
          if (blob.size) return options.onClip({ blob, startedAt, endedAt: endedAt || new Date().toISOString() });
        }).catch(options.onError).finally(() => { pending.delete(saving); complete(); });
        pending.add(saving);
        if (stopped) release();
        recordNext();
      };
      current.start();
      timer = setTimeout(requestStop, options.intervalMs ?? 5_000);
    } catch (error) {
      stopped = true;
      recorder = null;
      clearTimer();
      options.onError(error);
      complete();
      release();
    }
  };
  recordNext();
  return () => {
    stopped = true;
    clearTimer();
    stopCurrent?.();
    return Promise.allSettled([recordingDone, ...pending]).then(() => release());
  };
}
