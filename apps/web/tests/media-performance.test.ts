import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createMediaProcessingQueue } from '../src/lib/media-processing';
import { boundedUploadForm, UploadSecurityError } from '../src/lib/upload-security';
import { storeBuffer, storedObjectExists, deleteStoredObject } from '../src/lib/storage';
import type { StorageSettings } from '../src/lib/settings';
import { createMaterialUploadAdmission } from '../src/lib/upload-admission';

test('30 login material uploads queue fairly with only two active slots', async () => {
  const acquire = createMaterialUploadAdmission(2);
  let active = 0, peak = 0;
  const order: number[] = [];
  await Promise.all(Array.from({ length: 30 }, async (_, index) => {
    const release = await acquire();
    active++; peak = Math.max(peak, active); order.push(index);
    try { await new Promise(resolve => setTimeout(resolve, 2)); }
    finally { active--; release(); release(); }
  }));
  assert.equal(peak, 2);
  assert.deepEqual(order, Array.from({ length: 30 }, (_, index) => index));
});

test('cancelled and expired material waiters release queue capacity without taking a slot', async () => {
  const acquire = createMaterialUploadAdmission(1, 1, 15);
  const release = await acquire();
  const controller = new AbortController();
  const cancelled = assert.rejects(acquire(controller.signal), error => error instanceof UploadSecurityError && error.status === 408);
  controller.abort(); await cancelled;
  await assert.rejects(acquire(), error => error instanceof UploadSecurityError && error.status === 429);
  release();
  const available = await acquire(); available();
  await assert.rejects(acquire(controller.signal), error => error instanceof UploadSecurityError && error.status === 408);
  const next = await acquire(); next();
});

test('media processing bounds active work and releases capacity after decoder failures', async () => {
  const process = createMediaProcessingQueue(2, 30);
  let active = 0, peak = 0;
  const started: number[] = [];
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, index) => process(async () => {
    started.push(index); active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (index % 5 === 0) throw new Error('decoder failure');
      return index;
    } finally { active--; }
  })));
  assert.equal(peak, 2);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 24);
  assert.deepEqual(started, Array.from({ length: 30 }, (_, index) => index));
  assert.equal(await process(async () => 'still available'), 'still available');
});

test('a saturated media queue rejects excess work and removes timed-out entries', async () => {
  const process = createMediaProcessingQueue(1, 1, 15);
  let release!: () => void;
  const busy = process(() => new Promise<void>(resolve => { release = resolve; }));
  let queuedRan = false;
  const waiting = process(async () => { queuedRan = true; });
  const timedOut = assert.rejects(waiting, error => error instanceof UploadSecurityError && error.status === 429);
  await assert.rejects(process(async () => {}), error => error instanceof UploadSecurityError && error.status === 429);
  await timedOut;
  release(); await busy;
  assert.equal(queuedRan, false);
  assert.equal(await process(async () => 42), 42);
});

test('multipart streaming preserves files and cancels bodies that exceed actual-byte limits', async () => {
  const form = new FormData();
  form.set('channel', 'DESKTOP_SCREEN');
  const original = new Uint8Array(8192).fill(17);
  form.set('file', new File([original], 'video.webm', { type: 'video/webm' }));
  const request = new Request('http://localhost/upload', { method: 'POST', body: form });
  const contentType = request.headers.get('content-type')!;
  const encoded = new Uint8Array(await request.arrayBuffer());
  const parsed = await boundedUploadForm(new Request('http://localhost/upload', {
    method: 'POST', headers: { 'content-type': contentType }, body: encoded
  }), encoded.length);
  assert.equal(parsed.get('channel'), 'DESKTOP_SCREEN');
  assert.deepEqual(new Uint8Array(await (parsed.get('file') as File).arrayBuffer()), original);

  let offset = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.length) { controller.close(); return; }
      controller.enqueue(encoded.subarray(offset, offset += 512));
    },
    cancel() { cancelled = true; }
  });
  const oversize = new Request('http://localhost/upload', {
    method: 'POST', headers: { 'content-type': contentType, 'content-length': '1' }, body, duplex: 'half'
  } as RequestInit);
  await assert.rejects(boundedUploadForm(oversize, 1024), error => error instanceof UploadSecurityError && error.status === 413);
  assert.equal(cancelled, true);
  assert.ok(offset < encoded.length, 'oversized bodies stop reading before retaining the full payload');
});

test('S3 recording writes, immutable retries, material checks and deletion share a connection', async () => {
  let object: Buffer | null = null;
  const sockets = new Set<unknown>();
  const server = createServer(async (request, response) => {
    sockets.add(request.socket);
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (object && request.headers['if-none-match'] === '*') {
        response.writeHead(412, { 'content-type': 'application/xml' }).end('<Error><Code>PreconditionFailed</Code></Error>'); return;
      }
      object = Buffer.concat(chunks);
      response.writeHead(200, { etag: '"test-etag"' }).end(); return;
    }
    if (request.method === 'HEAD') {
      response.writeHead(object ? 200 : 404, object ? { 'content-length': object.length } : {}).end(); return;
    }
    if (request.method === 'DELETE') { object = null; response.writeHead(204).end(); return; }
    response.writeHead(400).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const settings: StorageSettings = { provider: 'S3', localUploadDir: './unused', s3: {
    endpoint: `http://127.0.0.1:${address.port}`, region: 'us-east-1', bucket: 'recordings',
    accessKeyId: 'synthetic-key', secretAccessKey: 'synthetic-secret', forcePathStyle: true
  } };
  try {
    const content = Buffer.from('validated recording bytes');
    const options = { filename: 'clip.webm', prefix: 'exam/candidate', immutable: true, stableName: true };
    const stored = await storeBuffer(content, options, settings);
    assert.deepEqual(object, content);
    await storeBuffer(Buffer.from('must never replace the existing recording'), options, settings);
    assert.deepEqual(object, content);
    assert.equal(await storedObjectExists(stored.objectPath, content.length, settings), true);
    assert.equal(await storedObjectExists(stored.objectPath, content.length + 1, settings), false);
    await deleteStoredObject(stored.objectPath, settings);
    assert.equal(object, null);
    assert.equal(sockets.size, 1, 'all sequential S3 operations reuse one keep-alive socket');
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
