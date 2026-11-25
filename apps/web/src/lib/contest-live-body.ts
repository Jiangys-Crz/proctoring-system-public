import { AuthError } from './auth';

export async function readContestLiveBody(request: Request, limit: number) {
  if (Number(request.headers.get('content-length')) > limit) throw new AuthError('请求内容过大', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError('缺少请求内容', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 15_000);
  const onAbort = () => void reader.cancel().catch(() => {});
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (expired) throw new AuthError('读取请求内容超时，请重试', 408);
      if (request.signal.aborted) throw new AuthError('请求已断开，请重试', 400);
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw new AuthError('请求内容过大', 413);
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
