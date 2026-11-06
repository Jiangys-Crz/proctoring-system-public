import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { streamReactionZip, type ReactionZipEntry } from '../src/lib/reaction-export-zip';

function entry(sequence: number, value: string): ReactionZipEntry {
  const bytes = Buffer.from(value);
  const submissionId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  return { submissionId, size: bytes.length, modifiedAt: new Date('2026-01-01'), open: async () => Readable.from([bytes]) };
}

// Read the ZIP64 central directory and stored data to verify actual payloads.
function files(bytes: Buffer) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
  assert.ok(end > 0);
  const count = Number(bytes.readBigUInt64LE(end + 32));
  let offset = Number(bytes.readBigUInt64LE(end + 48));
  const result = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(offset + 10), 0, 'MP4 is stored without recompression');
    const size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    result.set(name, bytes.subarray(start, start + size));
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return result;
}

test('ZIP64 contains only exact submission UUID.mp4 names and unchanged bytes, including over 200 records', async () => {
  const entries = Array.from({ length: 205 }, (_, i) => entry(i + 1, `MP4 content ${i + 1}`));
  const zipped = Buffer.from(await new Response(streamReactionZip(entries)).arrayBuffer());
  const unpacked = files(zipped);
  assert.equal(unpacked.size, 205);
  for (const [index, item] of entries.entries()) assert.equal(unpacked.get(`${item.submissionId}.mp4`)?.toString(), `MP4 content ${index + 1}`);
});

test('invalid, path-like and duplicate UUIDs cannot create unsafe or colliding filenames', () => {
  for (const id of ['', '123', '../video', 'a/b', 'a\\b', 'a\r\nheader', null, undefined, 123]) assert.throws(() => streamReactionZip([{ ...entry(1, 'x'), submissionId: id as string }]));
  assert.throws(() => streamReactionZip([entry(1, 'a'), entry(1, 'b')]), /duplicate/);
  const id = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
  assert.throws(() => streamReactionZip([{ ...entry(1, 'a'), submissionId: id }, { ...entry(2, 'b'), submissionId: id.toUpperCase() }]), /duplicate/);
  assert.throws(() => streamReactionZip([entry(1, '')]), /size/);
});

test('storage open failures terminate the archive and do not leak private errors', async () => {
  const broken = { ...entry(2, 'x'), open: async () => { throw new Error('secret signed URL'); } };
  await assert.rejects(new Response(streamReactionZip([entry(1, 'ok'), broken])).arrayBuffer(), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /secret/); return true;
  });
});

test('truncated or errored MP4 streams cannot become a successful ZIP', async () => {
  await assert.rejects(new Response(streamReactionZip([{ ...entry(1, 'x'), size: 100 }])).arrayBuffer());
  const broken = { ...entry(2, 'x'), open: async () => new Readable({ read() { this.destroy(new Error('S3 connection lost')); } }) };
  await assert.rejects(new Response(streamReactionZip([broken])).arrayBuffer());
});

test('browser cancellation destroys the current source and prevents later reads', async () => {
  let source: Readable | undefined, laterOpened = false, observedSignal: AbortSignal | undefined;
  const first: ReactionZipEntry = { ...entry(1, 'x'), size: 100_000_000, open: async signal => {
    observedSignal = signal;
    source = new Readable({ read() { this.push(Buffer.alloc(64 * 1024)); } });
    return source;
  } };
  const second = { ...entry(2, 'x'), open: async () => { laterOpened = true; return Readable.from(['x']); } };
  const reader = streamReactionZip([first, second]).getReader();
  await reader.read(); await reader.read();
  await reader.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(source?.destroyed); assert.ok(observedSignal?.aborted); assert.equal(laterOpened, false);
});

test('request abort cancels lazy storage requests', async () => {
  const controller = new AbortController(); let requestSignal: AbortSignal | undefined;
  const first = { ...entry(1, 'x'), open: async (signal: AbortSignal) => {
    requestSignal = signal;
    return new Readable({ read() {} });
  } };
  const reader = streamReactionZip([first], controller.signal).getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read());
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(requestSignal?.aborted);
});

test('a source that closes before EOF without an error still interrupts the archive', { timeout: 3000 }, async () => {
  const broken = { ...entry(1, 'abcdef'), open: async () => new Readable({ read() { this.push(Buffer.from('abc')); this.destroy(); } }) };
  await assert.rejects(new Response(streamReactionZip([broken])).arrayBuffer());
});

test('a source returned after cancellation has an error handler before destruction', async () => {
  let supply: ((source: Readable) => void) | undefined;
  const late = { ...entry(1, 'abcdef'), open: () => new Promise<Readable>(resolve => { supply = resolve; }) };
  const reader = streamReactionZip([late]).getReader();
  await reader.read();
  await reader.cancel();
  const source = new Readable({ read() {}, destroy(_error, callback) { callback(new Error('private late close')); } });
  assert.ok(supply); supply(source);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(source.destroyed);
});
