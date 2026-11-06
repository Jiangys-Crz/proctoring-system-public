import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { isReactionSubmissionId } from './reaction-submission-id';

export type ReactionZipEntry = {
  submissionId: string;
  size: number;
  modifiedAt: Date;
  open: (signal: AbortSignal) => Promise<Readable>;
};

/** STORE MP4s as a ZIP64 stream; only the current object is opened. */
export function streamReactionZip(entries: ReactionZipEntry[], signal?: AbortSignal): ReadableStream<Uint8Array> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isReactionSubmissionId(entry.submissionId) || ids.has(entry.submissionId.toLowerCase())) throw new Error('Invalid or duplicate submission UUID');
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error('Invalid MP4 size');
    ids.add(entry.submissionId.toLowerCase());
  }
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const controller = new AbortController();
  const active = new Set<Readable>();
  let stopped = false;
  const stop = () => {
    stopped = true;
    controller.abort();
    for (const input of active) input.destroy();
    active.clear();
    signal?.removeEventListener('abort', abort);
  };
  const abort = () => output.destroy(new Error('Reaction export cancelled'));
  // Storage errors must not expose local paths, signed URLs or credentials.
  zip.on('error', () => output.destroy(new Error('Reaction export source could not be read')));
  output.once('close', stop);
  signal?.addEventListener('abort', abort, { once: true });
  for (const entry of entries) {
    zip.addReadStreamLazy(`${entry.submissionId}.mp4`, { size: entry.size, compress: false, mtime: entry.modifiedAt }, callback => {
      // yazl ignores the stream argument when an error is supplied.
      const finish = callback as (error: Error | null, stream?: Readable) => void;
      if (stopped || controller.signal.aborted) return finish(new Error('Reaction export cancelled'));
      entry.open(controller.signal).then(input => {
        input.on('error', () => output.destroy(new Error('Reaction export source could not be read')));
        input.once('close', () => {
          active.delete(input);
          if (!stopped && !input.readableEnded) output.destroy(new Error('Reaction export source could not be read'));
        });
        input.once('end', () => active.delete(input));
        if (stopped) { input.destroy(); return finish(new Error('Reaction export cancelled')); }
        if (input.destroyed && !input.readableEnded) return finish(new Error('Reaction export source could not be read'));
        active.add(input);
        finish(null, input);
      }, () => finish(new Error('Reaction export source could not be read')));
    });
  }
  // A pull adapter bounds memory by bytes and handles cancellation even on
  // Node 22.12, whose toWeb adapter can enqueue after its controller closes.
  let cancelled = false;
  output.on('error', () => { /* surfaced through the iterator below */ });
  const iterator = output[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(web) {
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) web.close(); else web.enqueue(next.value);
      } catch { if (!cancelled) web.error(new Error('Reaction export interrupted')); }
    },
    async cancel() {
      cancelled = true;
      stop();
      output.destroy();
      try { await iterator.return?.(); } catch { /* cancellation completed */ }
    }
  }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength });
  zip.end({ forceZip64Format: true, comment: '' });
  if (signal?.aborted) abort();
  return body;
}
