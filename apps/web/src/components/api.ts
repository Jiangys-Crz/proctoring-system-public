export type ApiRequestInit = RequestInit & { timeoutMs?: number };

export async function api<T>(url: string, init?: ApiRequestInit): Promise<T> {
  const { timeoutMs, ...requestInit } = init || {};
  const timeoutDuration = timeoutMs ?? (requestInit.body instanceof FormData ? 120_000 : 20_000);
  if (!Number.isSafeInteger(timeoutDuration) || timeoutDuration <= 0 || timeoutDuration > 600_000) throw new Error('请求超时时间不正确');
  const controller = new AbortController();
  const abort = () => controller.abort();
  requestInit.signal?.addEventListener('abort', abort, { once: true });
  if (requestInit.signal?.aborted) abort();
  const timeout = setTimeout(abort, timeoutDuration);
  try {
    const response = await fetch(url, {
      ...requestInit,
      signal: controller.signal,
      headers: {
        ...(requestInit.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...requestInit.headers
      }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw new Error(body?.message || '服务暂不可用，请稍后再试');
    }
    return body.data as T;
  } finally {
    clearTimeout(timeout);
    requestInit.signal?.removeEventListener('abort', abort);
  }
}
