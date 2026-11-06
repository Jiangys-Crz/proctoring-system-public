import { AuthError } from './auth';
import { RequestParseError } from './http';
import { createRequestAdmission, isRequestAdmissionError } from './request-admission';

const shared = globalThis as typeof globalThis & { relayAdmission?: ReturnType<typeof createRequestAdmission>; relaySignalAdmission?: ReturnType<typeof createRequestAdmission> };
const acquire = shared.relayAdmission ??= createRequestAdmission(2, 24, 2000);
// A signaling request waits for a MediaMTX auth callback. Never let these two
// directions share slots, otherwise concurrent offers deadlock their callbacks.
const acquireSignal = shared.relaySignalAdmission ??= createRequestAdmission(4, 16, 3000);
export const relayHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
export function relayFailure(error: unknown) {
  const status = error instanceof AuthError ? error.status : error instanceof RequestParseError ? 400 : isRequestAdmissionError(error) ? 503 : 503;
  const message = error instanceof AuthError || error instanceof RequestParseError ? error.message : isRequestAdmissionError(error) ? '直播转发鉴权繁忙，请稍后重试' : '直播转发服务暂不可用，请稍后重试';
  return Response.json({ ok: false, message }, { status, headers: relayHeaders });
}
async function admitted(request: Request, work: () => Promise<Response>, admission: typeof acquire) {
  let release: (() => void) | undefined;
  try { release = await admission(request.signal); return await work(); }
  catch (error) { return relayFailure(error); }
  finally { release?.(); }
}
export const admittedRelay = (request: Request, work: () => Promise<Response>) => admitted(request, work, acquire);
export const admittedRelaySignal = (request: Request, work: () => Promise<Response>) => admitted(request, work, acquireSignal);
