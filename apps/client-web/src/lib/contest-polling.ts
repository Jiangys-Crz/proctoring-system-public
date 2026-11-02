/** Schedule after completion so slow requests cannot accumulate in the browser/server. */
export function startSerialPolling(task: (signal: AbortSignal) => Promise<unknown>, interval: () => number) {
  let stopped = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try { await task(controller.signal); } catch { /* The next poll can recover from a transient failure. */ }
    if (!stopped) timer = setTimeout(() => void run(), interval());
  };
  void run();
  return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
}

export function submissionPollDelay(visible: boolean, recordsVisible: boolean, pending: boolean) {
  if (!visible) return 15_000;
  if (pending) return 1_000;
  return recordsVisible ? 3_000 : 10_000;
}

/** Compatible with Electron 22, which does not provide AbortSignal.any. */
export async function readWithDeadline<T>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs = 15_000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try { return await read(controller.signal); }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
}
