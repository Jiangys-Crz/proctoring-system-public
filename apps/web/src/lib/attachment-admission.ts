import { createRequestAdmission, isRequestAdmissionError } from './request-admission';
import { fail } from './http';

const shared = globalThis as typeof globalThis & { attachmentAdmission?: ReturnType<typeof createRequestAdmission> };
const acquire = shared.attachmentAdmission ??= createRequestAdmission(4, 64, 5000);

/** Keep the slot for the whole streamed body, not just the upstream headers. */
export function holdAttachment(response: Response, signal: AbortSignal, release: () => void, timeoutMs = 60_000) {
  const reader = response.body!.getReader();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const releaseReader = () => { try { reader.releaseLock(); } catch { /* A canceled read may still be settling. */ } };
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    release();
  };
  const stop = (reason: Error) => {
    if (closed) return;
    finish();
    try { controller?.error(reason); } catch { /* Already canceled by the consumer. */ }
    void reader.cancel(reason).catch(() => {}).finally(releaseReader);
  };
  const abort = () => stop(new Error('附件下载已断开'));
  const timer = setTimeout(() => stop(new Error('附件下载超时，请重试')), timeoutMs);
  timer.unref?.();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      if (closed) return;
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) { value.close(); finish(); releaseReader(); }
        else value.enqueue(next.value);
      } catch (error) {
        if (!closed) { value.error(error); finish(); }
        releaseReader();
      }
    },
    async cancel(reason) {
      finish();
      try { await reader.cancel(reason); } finally { releaseReader(); }
    },
  });
  try { return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }); }
  catch (error) { stop(error instanceof Error ? error : new Error('附件响应无效')); throw error; }
}

export async function admittedAttachment(request: Request, handle: () => Promise<Response>) {
  let release: (() => void) | undefined;
  try {
    release = await acquire(request.signal);
    const response = await handle();
    if (!response.ok || !response.body) return response;
    const streamed = holdAttachment(response, request.signal, release);
    release = undefined;
    return streamed;
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    const response = fail('附件下载繁忙，请稍后重试', 503);
    response.headers.set('Retry-After', '3');
    return response;
  } finally { release?.(); }
}
