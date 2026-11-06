import { createRequestAdmission, isRequestAdmissionError, RequestAdmissionError } from './request-admission';
import { fail } from './http';
const shared = globalThis as typeof globalThis & { qaWriteAdmission?: ReturnType<typeof createRequestAdmission>; qaReadAdmission?: ReturnType<typeof createRequestAdmission> };
const acquire = shared.qaWriteAdmission ??= createRequestAdmission(2, 512, 5000);
const acquireRead = shared.qaReadAdmission ??= createRequestAdmission(4, 512, 5000);
/** Questions/replies and acknowledgment bursts never fan out into unbounded DB transactions. */
export async function admittedQaWrite(request: Request, work: () => Promise<Response>) {
  let release: (() => void) | undefined;
  try { release = await acquire(request.signal); if (request.signal.aborted) throw new RequestAdmissionError(); return await work(); }
  catch (error) { if (!isRequestAdmissionError(error)) throw error; return fail('答疑服务繁忙，请稍后重试', 503); }
  finally { release?.(); }
}

/** One synchronized notice may refresh many candidates together. Bound reads
 * independently of login and preserve headroom for heartbeats and replies. */
export async function admittedQaRead(request: Request, work: () => Promise<Response>) {
  let release: (() => void) | undefined;
  try { release = await acquireRead(request.signal); if (request.signal.aborted) throw new RequestAdmissionError(); return await work(); }
  catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    const response = fail('答疑加载繁忙，请稍后重试', 503);
    response.headers.set('Retry-After', '2');
    return response;
  } finally { release?.(); }
}
