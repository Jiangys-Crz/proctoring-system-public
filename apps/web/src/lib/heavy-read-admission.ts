import { createRequestAdmission, isRequestAdmissionError, RequestAdmissionError } from './request-admission';
import { fail } from './http';

const shared = globalThis as typeof globalThis & {
  monitorReadAdmission?: ReturnType<typeof createRequestAdmission>;
  leaderboardReadAdmission?: ReturnType<typeof createRequestAdmission>;
};
const acquireMonitor = shared.monitorReadAdmission ??= createRequestAdmission(2, 64, 3000);
const acquireLeaderboard = shared.leaderboardReadAdmission ??= createRequestAdmission(2, 128, 3000);

async function withReadSlot<T>(acquire: ReturnType<typeof createRequestAdmission>, work: () => Promise<T>, signal?: AbortSignal) {
  const release = await acquire(signal);
  try {
    if (signal?.aborted) throw new RequestAdmissionError();
    return await work();
  } finally { release(); }
}

async function admittedRead(request: Request, acquire: ReturnType<typeof createRequestAdmission>, message: string, work: () => Promise<Response>) {
  try {
    return await withReadSlot(acquire, work, request.signal);
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    const response = fail(message, 503);
    response.headers.set('Retry-After', '2');
    return response;
  }
}

// These responses contain whole-exam data. Bound the complete load and JSON
// serialization independently of login, heartbeat writes and stream transfers.
export function admittedMonitorRead(request: Request, work: () => Promise<Response>) {
  return admittedRead(request, acquireMonitor, '监考数据加载繁忙，请稍后重试', work);
}

export function admittedLeaderboardRead(request: Request, work: () => Promise<Response>) {
  return admittedRead(request, acquireLeaderboard, '排行榜加载繁忙，请稍后重试', work);
}

// Join a same-exam pending load BEFORE taking a slot. Otherwise serializing
// every candidate request would turn one shared query into repeated scans.
export function admittedLeaderboardDataRead<T>(work: () => Promise<T>) {
  return withReadSlot(acquireLeaderboard, work);
}
