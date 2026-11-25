import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { admitAuxiliaryUpload, acquireUploadSlot, UploadSecurityError } from '../src/lib/upload-security';
import { createMediaProcessingQueue, processMedia } from '../src/lib/media-processing';
import { normalizeScreenControlImage } from '../src/lib/screen-control-images';
import { POST as liveFrame } from '../src/app/api/client/live-frame/route';
import { POST as qaImage } from '../src/app/api/client/qa/image/route';
import { DELETE as stopWebRtc, POST as publishWebRtc } from '../src/app/api/client/whip/route';
import { GET as download } from '../src/app/api/uploads/file/[...key]/route';
import { isSharedLiveFramePath } from '../src/lib/live-frame-path';
import { signedLocalObjectUrl } from '../src/lib/storage';

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

test('legacy live-frame uploads keep team members and rotated session credentials isolated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proctor-live-frames-'));
  const original = { authorize: prisma.clientSession.findFirst, session: prisma.clientSession.findUnique,
    setting: prisma.systemSetting.findUnique, limiter: prisma.requestRateBucket.upsert, transaction: prisma.$transaction };
  const now = Date.now();
  const team = { examId: 'exam-id', candidateId: 'shared-team', revokedAt: null, status: 'IN_EXAM',
    startedAt: new Date(now - 5_000), candidate: { status: 'ONLINE_NORMAL', startedAt: new Date(now - 5_000) },
    exam: { startAt: new Date(now - 60_000), latestStartAt: new Date(now + 30_000), endAt: new Date(now + 60_000),
      durationMinutes: 1, contestRule: 'XCPC', flexible: false, requireFrontCamera: false, requireMiniProgram: false },
    miniProgramTokenHash: null };
  const initial = createClientSessionToken(), other = createClientSessionToken(), replacement = createClientSessionToken();
  const first = { ...team, id: 'first-session', desktopTokenHash: initial.tokenHash };
  const second = { ...team, id: 'second-session', desktopTokenHash: other.tokenHash };
  const rows = new Map([first, second].map(session => [session.id, session]));
  let rotateBeforePublish = false;
  const published: string[] = [];
  prisma.systemSetting.findUnique = (async ({ where }: { where: { key: string } }) => where.key === 'storage'
    ? { value: { provider: 'LOCAL', localUploadDir: root } } : null) as never;
  prisma.clientSession.findFirst = (async ({ where }: { where: { OR: Array<{ desktopTokenHash?: string }> } }) => {
    return [...rows.values()].find(session => session.desktopTokenHash === where.OR[0].desktopTokenHash);
  }) as never;
  prisma.clientSession.findUnique = (async ({ where }: { where: { id: string } }) => rows.get(where.id)) as never;
  prisma.requestRateBucket.upsert = (async () => ({ count: 1 })) as never;
  prisma.$transaction = (async (operation: (tx: unknown) => unknown) => operation({
    $queryRaw: async () => [],
    uploadReservation: { upsert: async () => ({}), updateMany: async () => ({ count: 1 }) },
    uploadBudget: { upsert: async () => ({}), updateMany: async () => ({ count: 1 }) },
    clientSession: { findUnique: async ({ where }: { where: { id: string } }) => {
      if (rotateBeforePublish) {
        rotateBeforePublish = false;
        first.desktopTokenHash = replacement.tokenHash;
      }
      return rows.get(where.id);
    } },
    liveFrame: { upsert: async ({ create }: { create: { objectPath: string } }) => {
      published.push(create.objectPath);
      return create;
    } }
  })) as never;
  const upload = async (id: string, token: string, color: string) => {
    const image = await sharp({ create: { width: 24, height: 24, channels: 3, background: color } }).png().toBuffer();
    const form = new FormData();
    form.set('sessionId', id);
    form.set('channel', 'DESKTOP_SCREEN');
    form.set('file', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'screen.png');
    return liveFrame(new Request('http://localhost/api/client/live-frame', { method: 'POST', body: form,
      headers: { authorization: `Bearer ${token}` } }));
  };
  try {
    const legacyKey = 'exam/candidate/live/live-DESKTOP_SCREEN.webp';
    const legacyUrl = signedLocalObjectUrl(legacyKey);
    assert.equal(isSharedLiveFramePath(legacyUrl), true);
    assert.equal((await download(new Request(`http://localhost${legacyUrl}`),
      { params: Promise.resolve({ key: legacyKey.split('/') }) })).status, 404);
    const one = await upload(first.id, initial.token, 'red');
    assert.equal(one.status, 201);
    const oneKey = (await one.json()).data.stored.objectPath;
    const originalImage = await readFile(join(root, oneKey));
    const two = await upload(second.id, other.token, 'blue');
    assert.equal(two.status, 201);
    const twoKey = (await two.json()).data.stored.objectPath;
    assert.notEqual(oneKey, twoKey);
    assert.equal(isSharedLiveFramePath(oneKey), false);
    assert.deepEqual(await readFile(join(root, oneKey)), originalImage);
    rotateBeforePublish = true;
    assert.equal((await upload(first.id, initial.token, 'green')).status, 401);
    assert.equal(published.length, 2);
    const lastOldImage = await readFile(join(root, oneKey));
    const refreshed = await upload(first.id, replacement.token, 'yellow');
    assert.equal(refreshed.status, 201);
    const refreshedKey = (await refreshed.json()).data.stored.objectPath;
    assert.notEqual(refreshedKey, oneKey);
    assert.deepEqual(await readFile(join(root, oneKey)), lastOldImage,
      'the earlier signed byte path never exposes frames of the replacement credentials');
  } finally {
    prisma.clientSession.findFirst = original.authorize; prisma.clientSession.findUnique = original.session;
    prisma.systemSetting.findUnique = original.setting; prisma.requestRateBucket.upsert = original.limiter;
    prisma.$transaction = original.transaction;
    await rm(root, { recursive: true, force: true });
  }
});

test('WebRTC signaling rejects oversized bodies before reaching the media server', async () => {
  const original = { session: prisma.clientSession.findUnique, fetch: globalThis.fetch };
  const token = createClientSessionToken();
  prisma.clientSession.findUnique = (async () => ({
    id: 'sample-session', desktopTokenHash: token.tokenHash, revokedAt: null, status: 'IN_EXAM',
    exam: { endAt: new Date(Date.now() + 60_000) }
  })) as never;
  let forwarded = 0;
  globalThis.fetch = async (target, init) => {
    forwarded++;
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    assert.equal(init?.body, 'v=0\r\n');
    const upstream = new URL(String(target));
    return new Response('v=0\r\n', { status: 201, headers: {
      location: `${upstream.pathname}/4b830564-2940-4fbe-a90e-0626301e0bb6${upstream.search}`
    } });
  };
  const request = (body: BodyInit, headers?: HeadersInit) => new Request(
    'http://localhost/api/client/whip?sessionId=sample-session&channel=DESKTOP_SCREEN',
    { method: 'POST', body, duplex: 'half', headers: { authorization: `Bearer ${token.token}`,
      'content-type': 'application/sdp', ...headers } } as RequestInit);
  try {
    const declared = request('v=0\r\n', { 'content-length': '65537' });
    assert.equal((await publishWebRtc(declared)).status, 413);
    assert.equal(declared.bodyUsed, false);
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65537)); controller.close(); }
    });
    assert.equal((await publishWebRtc(request(chunks))).status, 413);
    assert.equal(forwarded, 0);
    const opened = await publishWebRtc(request('v=0\r\n'));
    assert.equal(opened.status, 201);
    assert.equal(forwarded, 1);
    const location = new URL(opened.headers.get('location')!, 'http://localhost');
    assert.equal(location.searchParams.get('token'), null, 'upstream token is never returned');
    const deleteRequest = (url: URL) => new Request(url, { method: 'DELETE', headers: { authorization: `Bearer ${token.token}` } });
    const unbound = new URL(location);
    unbound.searchParams.delete('proof');
    assert.equal((await stopWebRtc(deleteRequest(unbound))).status, 403);
    assert.equal(forwarded, 1, 'unproven continuation never reaches upstream');
    assert.equal((await stopWebRtc(deleteRequest(location))).status, 204);
    assert.equal(forwarded, 2);
  } finally {
    prisma.clientSession.findUnique = original.session;
    globalThis.fetch = original.fetch;
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
