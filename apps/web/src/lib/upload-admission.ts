import { UploadSecurityError } from './upload-security';

type WaitingUpload = { resolve: (release: () => void) => void; cleanup: () => void };

/** Login materials need reserved, bounded capacity even while recordings are
 * being retried. Queued requests have not read or copied their multipart body. */
export function createMaterialUploadAdmission(maximum = 2, maxQueued = 32, timeoutMs = 30_000) {
  let active = 0;
  const waiting: WaitingUpload[] = [];
  function releaseSlot() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) { next.cleanup(); next.resolve(releaseSlot()); }
      else active--;
    };
  }
  return function acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new UploadSecurityError('上传已取消，请重试', 408));
    if (active < maximum) { active++; return Promise.resolve(releaseSlot()); }
    if (waiting.length >= maxQueued) return Promise.reject(new UploadSecurityError('材料上传服务繁忙，请稍后重试', 429));
    return new Promise((resolve, reject) => {
      const fail = (error: UploadSecurityError) => {
        const index = waiting.indexOf(entry);
        if (index === -1) return;
        waiting.splice(index, 1); entry.cleanup(); reject(error);
      };
      const onAbort = () => fail(new UploadSecurityError('上传已取消，请重试', 408));
      const timer = setTimeout(() => fail(new UploadSecurityError('材料上传服务繁忙，请稍后重试', 429)), timeoutMs);
      const entry: WaitingUpload = { resolve, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
      waiting.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
}

const configured = Number(process.env.UPLOAD_MATERIAL_MAX_CONCURRENT || 2);
const concurrency = Number.isSafeInteger(configured) ? Math.max(1, Math.min(4, configured)) : 2;
export const acquireMaterialUploadSlot = createMaterialUploadAdmission(concurrency);
