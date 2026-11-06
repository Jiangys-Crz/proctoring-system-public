/** Bound work before opening transactions or reading request bodies. Shared
 * across route bundles; overflow is retryable and never grows the DB queue. */
export class RequestAdmissionError extends Error {
  readonly status = 503;
  readonly code = 'PROCTOR_REQUEST_ADMISSION';
  constructor() { super('登录服务繁忙，请稍后重试'); }
}

// Queues are process-wide, but Next can load this class in several bundles.
export function isRequestAdmissionError(error: unknown): error is RequestAdmissionError {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'PROCTOR_REQUEST_ADMISSION');
}

/** A failed read must not release admission while its sibling queries still
 * occupy the pool. Preserve tuple types, and throw only after all have settled. */
export async function settleReads<const T extends readonly unknown[]>(reads: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const results = await Promise.allSettled(reads);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as { [K in keyof T]: Awaited<T[K]> };
}

export function createRequestAdmission(maximum: number, maxQueued = 128, timeoutMs = 8000) {
  let active = 0;
  const waiting: Array<{ grant: () => boolean; cancel: () => void }> = [];
  function releaseSlot() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (let next = waiting.shift(); next; next = waiting.shift()) {
        if (next.grant()) return;
      }
      active--;
    };
  }
  return function acquire(signal?: AbortSignal, deadlineAt = Infinity): Promise<() => void> {
    const expiresAt = Math.min(Date.now() + timeoutMs, deadlineAt);
    if (signal?.aborted || Date.now() >= expiresAt) return Promise.reject(new RequestAdmissionError());
    if (active < maximum) { active++; return Promise.resolve(releaseSlot()); }
    if (waiting.length >= maxQueued) return Promise.reject(new RequestAdmissionError());
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const cancel = () => {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1); cleanup(); reject(new RequestAdmissionError());
      };
      const entry = { grant: () => {
        cleanup();
        if (signal?.aborted || Date.now() >= expiresAt) { reject(new RequestAdmissionError()); return false; }
        resolve(releaseSlot()); return true;
      }, cancel };
      const timer = setTimeout(cancel, Math.max(0, expiresAt - Date.now()));
      waiting.push(entry);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  };
}

function configuredConcurrency() {
  const value = Number(process.env.LOGIN_MAX_CONCURRENT || 8);
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(32, value)) : 8;
}
const shared = globalThis as typeof globalThis & {
  loginAdmission?: ReturnType<typeof createRequestAdmission>;
  contestLoadAdmission?: ReturnType<typeof createRequestAdmission>;
};
export const acquireLoginSlot = shared.loginAdmission ??= createRequestAdmission(configuredConcurrency());
const acquireContestLoadSlot = shared.contestLoadAdmission ??= createRequestAdmission(4, 128, 5000);

/** Bound full statement/history/remote judge loading independently of the
 * login budget, reducing competing work during simultaneous page refreshes. */
export async function admittedContestLoad(request: Request, handle: () => Promise<Response>) {
  let release: (() => void) | undefined;
  try {
    release = await acquireContestLoadSlot(request.signal);
    if (request.signal.aborted) throw new RequestAdmissionError();
    return await handle();
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    return Response.json({ ok: false, message: '考试页面加载繁忙，正在等待重试' }, { status: 503, headers: {
      'Retry-After': '2', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'
    } });
  } finally { release?.(); }
}

export async function admittedLogin(request: Request, handle: () => Promise<Response>) {
  let release: (() => void) | undefined;
  try {
    release = await acquireLoginSlot(request.signal);
    if (request.signal.aborted) throw new RequestAdmissionError();
    return await handle();
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    return Response.json({ ok: false, message: error.message }, { status: 503, headers: {
      'Retry-After': '2', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'
    } });
  } finally { release?.(); }
}
