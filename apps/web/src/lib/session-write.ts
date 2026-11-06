import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { createRequestAdmission } from './request-admission';

// Desktop/mobile heartbeats, alerts and reconnects can arrive together. Queue
// them before borrowing a connection; otherwise every waiter occupies a pool
// slot while MySQL waits on the same row, starving unrelated candidates.
// Keep this shared across Next route bundles, like the Prisma connection pool.
export const SESSION_WRITE_QUEUE_LIMIT = 128;
export const SESSION_WRITE_QUEUE_WAIT_MS = 10_000;
export class SessionWriteQueueError extends Error {
  readonly status = 503;
  constructor() { super('当前会话请求繁忙，请稍后重试'); }
}
type Waiter = {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  run: () => Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  expire: () => void;
  cleanup: () => void;
};
type SessionQueue = { running: boolean; waiting: Waiter[] };
const state = globalThis as typeof globalThis & { sessionWriteQueues?: Map<string, SessionQueue>; sessionWriteAdmission?: ReturnType<typeof createRequestAdmission> };
const queues = state.sessionWriteQueues ??= new Map<string, SessionQueue>();
const acquireWrite = state.sessionWriteAdmission ??= createRequestAdmission(8, 256, SESSION_WRITE_QUEUE_WAIT_MS);

async function writeSession<T>(sessionId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>, expiresAt: number, signal?: AbortSignal): Promise<T> {
  let release: (() => void) | undefined;
  try {
    try { release = await acquireWrite(signal, expiresAt); }
    catch { throw new SessionWriteQueueError(); }
    return await writeAdmittedSession(sessionId, operation, expiresAt, signal);
  } finally { release?.(); }
}

async function writeAdmittedSession<T>(sessionId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>, expiresAt: number, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0 || signal?.aborted) throw new SessionWriteQueueError();
    try {
      return await prisma.$transaction(async (tx) => {
        // All automatic alert writers share this database lock, including other
        // server processes. A pre-transaction lookup alone cannot deduplicate.
        await tx.$queryRaw`SELECT id FROM ClientSession WHERE id = ${sessionId} FOR UPDATE`;
        if (Date.now() >= expiresAt || signal?.aborted) throw new SessionWriteQueueError();
        const result = await operation(tx);
        // An operation that outlived its queue budget must not commit stale
        // liveness, device binding or cancellation state after the caller left.
        if (Date.now() >= expiresAt || signal?.aborted) throw new SessionWriteQueueError();
        return result;
      }, { isolationLevel: 'ReadCommitted', maxWait: remaining, timeout: Math.min(15_000, remaining) });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['P2024', 'P2028'].includes(String(error.code))) throw new SessionWriteQueueError();
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2034') throw error;
      if (attempt >= 2) throw new SessionWriteQueueError();
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

function drainQueue(sessionId: string, queue: SessionQueue) {
  if (queue.running) return;
  const next = queue.waiting.shift();
  if (!next) {
    if (queues.get(sessionId) === queue) queues.delete(sessionId);
    return;
  }
  next.cleanup();
  // Recheck wall time even if a busy event loop delayed the expiration timer.
  // An obsolete heartbeat must never enter the DB and refresh liveness later.
  if (Date.now() >= next.expiresAt) {
    next.expire();
    drainQueue(sessionId, queue);
    return;
  }
  queue.running = true;
  const finished = () => {
    queue.running = false;
    drainQueue(sessionId, queue);
  };
  void next.run().then(
    result => { finished(); next.resolve(result); },
    error => { finished(); next.reject(error); },
  );
}

export function withSessionWrite<T>(sessionId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(new SessionWriteQueueError());
  let queue = queues.get(sessionId);
  if (!queue) { queue = { running: false, waiting: [] }; queues.set(sessionId, queue); }
  if (queue.waiting.length + Number(queue.running) >= SESSION_WRITE_QUEUE_LIMIT) return Promise.reject(new SessionWriteQueueError());
  const current = queue;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      const index = current.waiting.indexOf(waiter);
      if (index < 0) return;
      current.waiting.splice(index, 1);
      waiter.cleanup();
      waiter.expire();
      drainQueue(sessionId, current);
    };
    const waiter: Waiter = { expiresAt: Date.now() + SESSION_WRITE_QUEUE_WAIT_MS,
      timer: setTimeout(cancel, SESSION_WRITE_QUEUE_WAIT_MS),
      run: () => writeSession(sessionId, operation, waiter.expiresAt, signal), resolve: result => resolve(result as T), reject,
      cleanup: () => { clearTimeout(waiter.timer); signal?.removeEventListener('abort', cancel); },
      // Construct typed errors in the waiting request's route bundle, even
      // when a different bundle drains the shared process-level queue.
      expire: () => reject(new SessionWriteQueueError()) };
    waiter.timer.unref?.();
    current.waiting.push(waiter);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    drainQueue(sessionId, current);
  });
}
