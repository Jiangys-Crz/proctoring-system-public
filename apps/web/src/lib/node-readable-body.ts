import type { Readable } from 'node:stream';

/** Queue bytes rather than chunks, and ignore a read settling after cancel. */
export function nodeReadableBody(source: Readable): ReadableStream<Uint8Array> {
  let cancelled = false;
  source.on('error', () => { /* surfaced through the iterator */ });
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(next.value as Uint8Array);
      } catch (error) {
        source.destroy();
        if (!cancelled) controller.error(error);
      }
    },
    async cancel() {
      cancelled = true;
      source.destroy();
      try { await iterator.return?.(); } catch { /* cancellation completed */ }
    },
  }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
}
