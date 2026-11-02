/** One read at a time, including manual refreshes made during a slow poll. */
export function createMonitorPoller(read: (signal: AbortSignal) => Promise<void>, options: {
  intervalMs: number;
  timeoutMs?: number;
  visible?: boolean;
}) {
  let stopped = false;
  let visible = options.visible ?? true;
  let queued = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };

  function refresh(): Promise<void> {
    clearTimer();
    if (stopped || !visible) return Promise.resolve();
    // An action may have just changed server state. Discard its older read
    // immediately, then serialize a fresh one; never flash an acknowledged
    // alert back to pending while waiting for the refresh to finish.
    if (pending) { queued = true; controller?.abort(); return pending; }
    pending = Promise.resolve().then(async () => {
      do {
        queued = false;
        if (stopped || !visible) break;
        controller = new AbortController();
        const current = controller;
        const deadline = setTimeout(() => current.abort(new DOMException('加载超时，请稍后重试', 'TimeoutError')), options.timeoutMs ?? 15_000);
        try { await read(current.signal); } catch { /* The next poll retries transient errors. */ }
        finally { clearTimeout(deadline); }
      } while (queued && !stopped && visible);
    }).finally(() => {
      controller = undefined;
      pending = undefined;
      if (!stopped && visible) timer = setTimeout(() => void refresh(), options.intervalMs);
    });
    return pending;
  }

  return {
    refresh,
    setVisible(next: boolean) {
      if (next === visible || stopped) return;
      visible = next;
      clearTimer();
      if (!next) { queued = false; controller?.abort(); }
      else void refresh();
    },
    stop() { stopped = true; queued = false; clearTimer(); controller?.abort(); },
  };
}
