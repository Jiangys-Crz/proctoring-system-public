import type { ProblemSubmission } from '@prisma/client';
import { prisma } from './db';
import { judgeStatistics, requestHydroJudgeStatus } from './hydro-contest';
import { hydroStatusIsAwaiting } from './hydro-status';
import { createRequestAdmission, isRequestAdmissionError, RequestAdmissionError } from './request-admission';
import { fail } from './http';

type ObservedRecord = Pick<ProblemSubmission, 'id' | 'hydroRecordId' | 'status' | 'statusText' | 'judgeAt' | 'updatedAt'>;
const shared = globalThis as typeof globalThis & {
  problemStatusAdmission?: ReturnType<typeof createRequestAdmission>;
  problemStatusPending?: Map<string, Promise<void>>;
  problemRecordAdmission?: ReturnType<typeof createRequestAdmission>;
};
const acquire = shared.problemStatusAdmission ??= createRequestAdmission(4, 128, 3000);
const pending = shared.problemStatusPending ??= new Map<string, Promise<void>>();
const acquireRead = shared.problemRecordAdmission ??= createRequestAdmission(4, 64, 3000);

export async function admittedProblemRecordRead(request: Request, work: () => Promise<Response>) {
  let release: (() => void) | undefined;
  try {
    release = await acquireRead(request.signal);
    if (request.signal.aborted) throw new RequestAdmissionError();
    return await work();
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    const response = fail('题库记录加载繁忙，请稍后重试', 503);
    response.headers.set('Retry-After', '2');
    return response;
  } finally { release?.(); }
}

/** List and detail polls share requests, but never an authorized response. A
 * late status for an old Hydro run cannot finish a replacement rejudge. */
export function syncProblemSubmissionStatus(record: ObservedRecord, force = false): Promise<void> {
  if (!force && (!record.hydroRecordId || !hydroStatusIsAwaiting(record.statusText, record.status, record.judgeAt?.toISOString() || null))) return Promise.resolve();
  const remoteId = record.hydroRecordId || (/^[a-f0-9]{24}$/i.test(record.id) ? record.id : null);
  if (!remoteId) return Promise.resolve();
  const key = JSON.stringify([record.id, remoteId, record.status, record.judgeAt, record.updatedAt]);
  const running = pending.get(key);
  if (running) return running;
  if (pending.size >= 128) return Promise.reject(new RequestAdmissionError());
  const task = (async () => {
    const release = await acquire();
    try {
      const remote = await requestHydroJudgeStatus({ platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' }, remoteId);
      await prisma.problemSubmission.updateMany({
        where: { id: record.id, hydroRecordId: record.hydroRecordId, updatedAt: record.updatedAt, status: record.status, judgeAt: record.judgeAt },
        data: {
          status: remote.status ?? 0, statusText: remote.statusText || 'Waiting', score: remote.score ?? 0,
          ...judgeStatistics(remote.testCases), time: remote.time ?? 0, memory: remote.memory ?? 0,
          testCases: remote.testCases as any, subtasks: remote.subtasks as any,
          judgeAt: remote.judgeAt ? new Date(remote.judgeAt) : null,
        },
      });
    } finally { release(); }
  })().finally(() => { if (pending.get(key) === task) pending.delete(key); });
  pending.set(key, task);
  return task;
}
