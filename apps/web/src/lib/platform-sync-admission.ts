import { holdAttachment } from './attachment-admission';
import { createRequestAdmission, isRequestAdmissionError } from './request-admission';
import { fail } from './http';

const shared = globalThis as typeof globalThis & {
  platformExchangeAdmission?: ReturnType<typeof createRequestAdmission>;
  platformFileAdmission?: ReturnType<typeof createRequestAdmission>;
};
const exchange = shared.platformExchangeAdmission ??= createRequestAdmission(1, 0, 1000);
const files = shared.platformFileAdmission ??= createRequestAdmission(2, 4, 3000);

/** Admit before parsing large bodies; retain the slot until the response closes. */
export async function admittedPlatformSync(request: Request, work: () => Promise<Response>, file = false) {
  let release: (() => void) | undefined;
  try {
    release = await (file ? files : exchange)(request.signal);
    const response = await work();
    if (response.ok && response.body) {
      const stream = holdAttachment(response, request.signal, release, file ? 300_000 : 60_000);
      release = undefined;
      return stream;
    }
    return response;
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    const response = fail('同步服务繁忙，已保留进度，请稍后重试', 503);
    response.headers.set('Retry-After', '2');
    return response;
  } finally { release?.(); }
}
