import { UploadSecurityError } from './upload-security';

/** Bound CPU-heavy decoders independently of the number of uploads in flight. */
export function createMediaProcessingQueue(maximum: number, queueLimit = 16, timeoutMs = 30_000) {
  let active = 0;
  const waiting: { resolve: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  return async function processMedia<T>(operation: () => Promise<T>, busy = () => new UploadSecurityError('媒体校验服务繁忙，请稍后重试', 429)): Promise<T> {
    if (active >= maximum) {
      if (waiting.length >= queueLimit) throw busy();
      await new Promise<void>((resolve, reject) => {
        const entry = { resolve, timer: setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          reject(busy());
        }, timeoutMs) };
        waiting.push(entry);
      });
    } else active++;
    try { return await operation(); }
    finally {
      const next = waiting.shift();
      if (next) { clearTimeout(next.timer); next.resolve(); }
      else active--;
    }
  };
}

const configured = Number(process.env.MEDIA_VALIDATION_CONCURRENCY || 2);
const concurrency = Number.isSafeInteger(configured) ? Math.max(1, Math.min(8, configured)) : 2;
// Route bundles may load separate copies of this module in the same process.
// They must share admission, or each route gets another full decoder budget.
const shared = globalThis as typeof globalThis & { mediaProcessingQueue?: ReturnType<typeof createMediaProcessingQueue> };
const queue = shared.mediaProcessingQueue ??= createMediaProcessingQueue(concurrency);
export function processMedia<T>(operation: () => Promise<T>) {
  // Error identity belongs to the caller's route bundle, even if another
  // bundle created the shared queue. Routes can reliably catch its typed 429.
  return queue(operation, () => new UploadSecurityError('媒体校验服务繁忙，请稍后重试', 429));
}
