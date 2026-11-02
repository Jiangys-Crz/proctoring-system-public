import type { Prisma } from '@prisma/client';
import { prisma } from './db';

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
};
type SessionQueue = { running: boolean; waiting: Waiter[] };
const state = globalThis as typeof globalThis & { sessionWriteQueues?: Map<string, SessionQueue> };
const queues = state.sessionWriteQueues ??= new Map<string, SessionQueue>();

async function writeSession<T>(sessionId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>, expiresAt: number): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) throw new SessionWriteQueueError();
    try {
      return await prisma.$transaction(async (tx) => {
        // All automatic alert writers share this database lock, including other
        // server processes. A pre-transaction lookup alone cannot deduplicate.
        await tx.$queryRaw`SELECT id FROM ClientSession WHERE id = ${sessionId} FOR UPDATE`;
        if (Date.now() >= expiresAt) throw new SessionWriteQueueError();
        return operation(tx);
      }, { isolationLevel: 'ReadCommitted', maxWait: remaining, timeout: 15_000 });
    } catch (error) {
      if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2034') throw error;
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
  clearTimeout(next.timer);
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

export function withSessionWrite<T>(sessionId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let queue = queues.get(sessionId);
  if (!queue) { queue = { running: false, waiting: [] }; queues.set(sessionId, queue); }
  if (queue.waiting.length + Number(queue.running) >= SESSION_WRITE_QUEUE_LIMIT) return Promise.reject(new SessionWriteQueueError());
  const current = queue;
  return new Promise<T>((resolve, reject) => {
    const waiter: Waiter = { expiresAt: Date.now() + SESSION_WRITE_QUEUE_WAIT_MS,
      timer: setTimeout(() => {
        const index = current.waiting.indexOf(waiter);
        if (index < 0) return;
        current.waiting.splice(index, 1);
        waiter.expire();
        drainQueue(sessionId, current);
      }, SESSION_WRITE_QUEUE_WAIT_MS),
      run: () => writeSession(sessionId, operation, waiter.expiresAt), resolve: result => resolve(result as T), reject,
      // Construct typed errors in the waiting request's route bundle, even
      // when a different bundle drains the shared process-level queue.
      expire: () => reject(new SessionWriteQueueError()) };
    waiter.timer.unref?.();
    current.waiting.push(waiter);
    drainQueue(sessionId, current);
  });
}
