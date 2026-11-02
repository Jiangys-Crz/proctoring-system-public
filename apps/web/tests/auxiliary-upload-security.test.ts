import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { admitAuxiliaryUpload, acquireUploadSlot, UploadSecurityError } from '../src/lib/upload-security';
import { createMediaProcessingQueue, processMedia } from '../src/lib/media-processing';
import { normalizeScreenControlImage } from '../src/lib/screen-control-images';
import { POST as liveFrame } from '../src/app/api/client/live-frame/route';
import { POST as qaImage } from '../src/app/api/client/qa/image/route';

test('rate-limited or saturated live frames and QA images do not read or decode the request body', async () => {
  const originals = { session: prisma.clientSession.findFirst, setting: prisma.systemSetting.findUnique, counter: prisma.requestRateBucket.upsert };
  const token = createClientSessionToken();
  prisma.clientSession.findFirst = (async () => ({ id: 'session', examId: 'exam', desktopTokenHash: token.tokenHash,
    miniProgramTokenHash: null, status: 'IN_EXAM', revokedAt: null, exam: { endAt: new Date(Date.now() + 60_000) } })) as never;
  prisma.systemSetting.findUnique = (async () => null) as never;
  let count = 241;
  prisma.requestRateBucket.upsert = (async () => ({ count })) as never;
  const releases: Array<() => void> = [];
  try {
    for (const reason of ['rate', 'capacity']) {
      if (reason === 'capacity') {
        count = 1;
        const configured = Number(process.env.UPLOAD_MAX_CONCURRENT || 4);
        const maximum = Number.isSafeInteger(configured) ? Math.max(1, Math.min(16, configured)) : 4;
        for (let index = 0; index < maximum; index++) releases.push(acquireUploadSlot());
        const duplicate = await import(new URL('../src/lib/upload-security.ts', import.meta.url).href + '?upload-route-bundle');
        assert.throws(() => duplicate.acquireUploadSlot(), (error: unknown) => error instanceof duplicate.UploadSecurityError,
          'a second bundle cannot allocate a separate set of upload slots');
      }
      for (const handler of [liveFrame, qaImage]) {
        let reads = 0;
        const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.error(new Error('body must remain unread')); } }, { highWaterMark: 0 });
        const request = new Request('http://localhost/api/upload', { method: 'POST', headers: {
          authorization: `Bearer ${token.token}`, 'content-type': 'multipart/form-data; boundary=fixture',
        }, body, duplex: 'half' } as RequestInit);
        const response = await handler(request);
        assert.equal(response.status, 429, `${reason}: ${await response.text()}`);
        assert.equal(reads, 0);
        assert.equal(request.bodyUsed, false);
        await request.body?.cancel();
      }
    }
    releases.forEach(release => release());
    for (const handler of [liveFrame, qaImage]) {
      const form = new FormData(); form.set('sessionId', 'session');
      const response = await handler(new Request('http://localhost/api/upload', { method: 'POST',
        headers: { authorization: `Bearer ${token.token}` }, body: form }));
      assert.equal(response.status, 400, 'invalid uploads release their admission slot');
    }
    const available = acquireUploadSlot(); available();
  } finally {
    releases.forEach(release => release());
    prisma.clientSession.findFirst = originals.session; prisma.systemSetting.findUnique = originals.setting; prisma.requestRateBucket.upsert = originals.counter;
  }
});

test('admitted image groups count once and reserve only the converted bytes', async () => {
  const originals = { counter: prisma.requestRateBucket.upsert, transaction: prisma.$transaction };
  let attempts = 0;
  const charged: bigint[] = [];
  prisma.requestRateBucket.upsert = (async () => { attempts++; return { count: attempts }; }) as never;
  prisma.$transaction = (async (operation: (tx: unknown) => unknown) => operation({
    uploadReservation: { upsert: async () => ({}), updateMany: async () => ({ count: 1 }) },
    uploadBudget: { upsert: async () => ({}), updateMany: async (input: { data: { bytes: { increment: bigint } } }) => {
      charged.push(input.data.bytes.increment); return { count: 1 };
    } },
  })) as never;
  try {
    const account = await admitAuxiliaryUpload('image-group-fixture', 30);
    assert.equal(attempts, 1); assert.deepEqual(charged, []);
    await account(123); await account(456);
    assert.equal(attempts, 1);
    assert.deepEqual(charged, [123n, 456n]);
  } finally { prisma.requestRateBucket.upsert = originals.counter; prisma.$transaction = originals.transaction; }
});

test('image decoding shares the bounded media queue across module copies and recovers after saturation', async () => {
  const duplicatePath = new URL('../src/lib/media-processing.ts', import.meta.url).href + '?independent-route-bundle';
  const duplicate = await import(duplicatePath);
  assert.notEqual(duplicate.processMedia, processMedia, 'separate route copies have their own error constructors');
  const configured = Number(process.env.MEDIA_VALIDATION_CONCURRENCY || 2);
  const concurrency = Number.isSafeInteger(configured) ? Math.max(1, Math.min(8, configured)) : 2;
  const releases: Array<() => void> = [];
  const active = Array.from({ length: concurrency }, () => processMedia(() => new Promise<void>(resolve => releases.push(resolve))));
  let waitingRan = 0;
  const waiting = Array.from({ length: 16 }, () => processMedia(async () => { waitingRan++; }));
  try {
    // If normalization bypasses admission, these invalid PNG bytes produce a
    // decoder error (400), rather than the expected queue saturation (429).
    await assert.rejects(normalizeScreenControlImage(Buffer.from('89504e470d0a1a0a', 'hex')),
      error => error instanceof UploadSecurityError && error.status === 429);
    await assert.rejects(duplicate.processMedia(async () => { throw new Error('must remain queued'); }),
      (error: unknown) => error instanceof UploadSecurityError && error.status === 429);
    assert.equal(waitingRan, 0);
  } finally { releases.forEach(release => release()); await Promise.all([...active, ...waiting]); }
  assert.equal(waitingRan, 16);
  const input = await sharp({ create: { width: 4, height: 7, channels: 3, background: '#fff' } }).png().toBuffer();
  const result = await normalizeScreenControlImage(input);
  assert.equal(result.width, 4); assert.equal(result.height, 7);
});

test('shared decoder queues use the requesting bundle error constructor for overflow and timeout', async () => {
  const independentErrors = await import(new URL('../src/lib/upload-security.ts', import.meta.url).href + '?caller-bundle');
  assert.notEqual(independentErrors.UploadSecurityError, UploadSecurityError);
  const process = createMediaProcessingQueue(1, 1, 10);
  let release!: () => void;
  const active = process(() => new Promise<void>(resolve => { release = resolve; }));
  const busy = () => new independentErrors.UploadSecurityError('请求方的繁忙错误', 429);
  const ownedByCaller = (error: unknown) => error instanceof independentErrors.UploadSecurityError && !(error instanceof UploadSecurityError);
  try {
    const waiting = assert.rejects(process(async () => {}, busy), ownedByCaller);
    await assert.rejects(process(async () => {}, busy), ownedByCaller);
    await waiting;
  } finally { release(); await active; }
});
