import { createRequestAdmission, isRequestAdmissionError, RequestAdmissionError } from './request-admission';
import { fail } from './http';
import { holdAttachment } from './attachment-admission';

const shared = globalThis as typeof globalThis & {
  monitorReadAdmission?: ReturnType<typeof createRequestAdmission>;
  leaderboardRequestAdmission?: ReturnType<typeof createRequestAdmission>;
  gradingReadAdmission?: ReturnType<typeof createRequestAdmission>;
  gradingWriteAdmission?: ReturnType<typeof createRequestAdmission>;
  leaderboardReadAdmission?: ReturnType<typeof createRequestAdmission>;
  contestLiveReadAdmission?: ReturnType<typeof createRequestAdmission>;
  contestDisplayReadAdmission?: ReturnType<typeof createRequestAdmission>;
};
const acquireLeaderboardRequest = shared.leaderboardRequestAdmission ??= createRequestAdmission(8, 128, 3000);
const acquireMonitor = shared.monitorReadAdmission ??= createRequestAdmission(2, 64, 3000);
const acquireLeaderboard = shared.leaderboardReadAdmission ??= createRequestAdmission(2, 128, 3000);
const acquireGrading = shared.gradingReadAdmission ??= createRequestAdmission(1, 16, 3000);
const acquireGradingWrite = shared.gradingWriteAdmission ??= createRequestAdmission(2, 32, 3000);
const acquireContestLive = shared.contestLiveReadAdmission ??= createRequestAdmission(4, 64, 3000);
const acquireContestDisplay = shared.contestDisplayReadAdmission ??= createRequestAdmission(4, 32, 3000);

async function withReadSlot<T>(acquire: ReturnType<typeof createRequestAdmission>, work: () => Promise<T>, signal?: AbortSignal) {
  const release = await acquire(signal);
  try {
    if (signal?.aborted) throw new RequestAdmissionError();
    return await work();
  } finally { release(); }
}

async function admittedRead(request: Request, acquire: ReturnType<typeof createRequestAdmission>, message: string, work: () => Promise<Response>) {
  let release: (() => void) | undefined;
  try {
    release = await acquire(request.signal);
    if (request.signal.aborted) throw new RequestAdmissionError();
    const response = await work();
    if (!response.ok || !response.body) return response;
    const streamed = holdAttachment(response, request.signal, release);
    release = undefined;
    return streamed;
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    const response = fail(message, 503);
    response.headers.set('Retry-After', '2');
    return response;
  } finally { release?.(); }
}

// These responses contain whole-exam data. Bound the complete load and JSON
// serialization and slow response consumers independently of login/heartbeats.
export function admittedMonitorRead(request: Request, work: () => Promise<Response>) {
  return admittedRead(request, acquireMonitor, '监考数据加载繁忙，请稍后重试', work);
}

export function admittedContestLiveRead(request: Request, work: () => Promise<Response>) {
  return admittedRead(request, acquireContestLive, '赛事直播数据加载繁忙，请稍后重试', work);
}

export function admittedContestDisplayRead(request: Request, work: () => Promise<Response>) {
  return admittedRead(request, acquireContestDisplay, '大屏数据加载繁忙，请稍后重试', work);
}

export async function admittedContestDisplayConnection(request: Request, work: () => Promise<Response>) {
  try {
    // The display event hub limits active streams and bounds its snapshot reads.
    // Hold this slot only while opening the connection.
    return await withReadSlot(acquireContestDisplay, work, request.signal);
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    const response = fail('大屏数据加载繁忙，请稍后重试', 503);
    response.headers.set('Retry-After', '2');
    return response;
  }
}

export function admittedLeaderboardRead(request: Request, work: () => Promise<Response>) {
  return admittedRead(request, acquireLeaderboard, '排行榜加载繁忙，请稍后重试', work);
}

// Join a same-exam pending load BEFORE taking a slot. Otherwise serializing
// every candidate request would turn one shared query into repeated scans.
export function admittedLeaderboardDataRead<T>(work: () => Promise<T>) {
  return withReadSlot(acquireLeaderboard, work);
}

// Separate from the data slot: joining a shared data load must not acquire it twice.
export function admittedLeaderboardRequest(request: Request, work: () => Promise<Response>) {
  return admittedRead(request, acquireLeaderboardRequest, '排行榜请求繁忙，请稍后重试', work);
}

export function admittedGradingRead(request: Request, work: () => Promise<Response>) {
  return admittedRead(request, acquireGrading, '评卷数据加载繁忙，请稍后重试', work);
}

export function admittedGradingWrite(request: Request, work: () => Promise<Response>) {
  return admittedRead(request, acquireGradingWrite, '评分保存繁忙，请稍后重试', work);
}
