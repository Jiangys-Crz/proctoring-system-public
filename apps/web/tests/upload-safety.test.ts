import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/db';
import { hashClientSessionToken } from '../src/lib/client-auth';
import { POST } from '../src/app/api/client/upload/route';
import { POST as legacyPOST } from '../src/app/api/uploads/route';

test('concurrent upload retries keep exactly one file and one database row, including Prisma unique conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'proctor-upload-test-'));
  const originals = { session: prisma.clientSession.findUnique, preSession: prisma.clientSession.findFirst, rate: prisma.requestRateBucket.upsert, transaction: prisma.$transaction, exam: prisma.exam.findUnique, settings: prisma.systemSetting.findUnique, segment: prisma.mediaSegment.findUnique, requiredSegment: prisma.mediaSegment.findUniqueOrThrow, upsert: prisma.mediaSegment.upsert };
  const video = await readFile(new URL('./fixtures/material-room.webm', import.meta.url));
  const changedVideo = Buffer.concat([video, Buffer.from('different-content')]);
  const reservations = new Map<string, bigint>();
  const budgets = new Map<string, bigint>();
  const quotaStore = {
    uploadReservation: {
      upsert: async ({ where }: any) => { if (!reservations.has(where.id)) reservations.set(where.id, 0n); },
      updateMany: async ({ where, data }: any) => { if (reservations.get(where.id) !== 0n) return { count: 0 }; reservations.set(where.id, data.bytes); return { count: 1 }; }
    },
    uploadBudget: {
      upsert: async ({ where }: any) => { if (!budgets.has(where.scope)) budgets.set(where.scope, 0n); },
      updateMany: async ({ where, data }: any) => { const old = budgets.get(where.scope) || 0n; if (old > where.bytes.lte) return { count: 0 }; budgets.set(where.scope, old + data.bytes.increment); return { count: 1 }; }
    }
  };
  prisma.$transaction = (async (operation: any) => operation(quotaStore)) as typeof originals.transaction;
  prisma.requestRateBucket.upsert = (async () => ({ count: 1 })) as unknown as typeof originals.rate;
  const token = 'upload-session-token';
  const session = { id: 's'.repeat(25), examId: 'e'.repeat(25), candidateId: 'c'.repeat(25), status: 'IN_EXAM', endedAt: null as Date | null, desktopTokenHash: hashClientSessionToken(token), miniProgramTokenHash: null };
  let examEnd = new Date(Date.now() + 3_600_000);
  const rows = new Map<string, Record<string, any>>();
  prisma.clientSession.findFirst = (async () => session) as unknown as typeof originals.preSession;
  prisma.clientSession.findUnique = (async () => session) as unknown as typeof originals.session;
  prisma.exam.findUnique = (async () => ({ endAt: examEnd, saveFullRecording: true })) as unknown as typeof originals.exam;
  prisma.systemSetting.findUnique = (async () => ({ value: { provider: 'LOCAL', localUploadDir: root } })) as unknown as typeof originals.settings;
  prisma.mediaSegment.findUnique = (async ({ where }: any) => rows.get(where.id) || null) as unknown as typeof originals.segment;
  prisma.mediaSegment.findUniqueOrThrow = (async ({ where }: any) => rows.get(where.id)) as unknown as typeof originals.requiredSegment;
  prisma.mediaSegment.upsert = (async ({ where, create }: any) => {
    if (rows.has(where.id)) throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
    rows.set(where.id, create);
    return create;
  }) as unknown as typeof originals.upsert;
  Object.assign(quotaStore, { $queryRaw: async () => [], exam: prisma.exam, clientSession: prisma.clientSession, mediaSegment: prisma.mediaSegment, fileDeletionJob: { findFirst: async () => null } });
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const endedAt = new Date().toISOString();
  function upload(bytes: Buffer | string = video, uploadId: string | null = 'stable-upload-id', options: Record<string, string> = {}) {
    const form = new FormData();
    form.append('file', new File([typeof bytes === 'string' ? bytes : Uint8Array.from(bytes)], 'screen.webm', { type: 'video/webm' }));
    for (const [key, value] of Object.entries({ sessionId: session.id, channel: 'DESKTOP_SCREEN', startedAt, endedAt, ...(uploadId ? { uploadId } : {}), ...options })) form.append(key, value);
    return new Request('http://localhost/api/client/upload', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  }
  try {
    assert.equal(legacyPOST, POST);
    const responses = await Promise.all(Array.from({ length: 4 }, () => POST(upload())));
    assert.ok(responses.every((response) => response.ok));
    assert.equal(rows.size, 1);
    assert.equal([...budgets.values()][0], BigInt(video.length), 'concurrent retries consume quota once');
    const record = [...rows.values()][0];
    assert.ok(record.objectPath.length <= 191);
    assert.equal(record.endedAt.toISOString(), endedAt);
    assert.equal((await readdir(path.join(root, session.examId, session.candidateId))).length, 1);
    const originalProbe = process.env.FFPROBE_PATH;
    try {
      process.env.FFPROBE_PATH = path.join(root, 'decoder-must-not-run-for-validated-retries');
      assert.equal((await POST(upload())).status, 200, 'a persisted exact video retry skips decoding');
      assert.equal((await POST(upload(changedVideo))).status, 409, 'digest conflicts are rejected before decoding');
      assert.equal(rows.size, 1);
      assert.equal([...budgets.values()][0], BigInt(video.length));
    } finally {
      if (originalProbe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = originalProbe;
    }
    const activeSessionLookup = prisma.clientSession.findUnique;
    try {
      prisma.clientSession.findUnique = (async () => ({ ...session, revokedAt: new Date() })) as unknown as typeof activeSessionLookup;
      assert.equal((await POST(upload())).status, 401, 'revocation during body upload also blocks the fast duplicate path');
    } finally { prisma.clientSession.findUnique = activeSessionLookup; }
    const conflicts = await Promise.all([POST(upload(video, 'racing-content')), POST(upload(changedVideo, 'racing-content'))]);
    assert.deepEqual(conflicts.map(response => response.status).sort(), [201, 409]);
    assert.equal(rows.size, 2);
    assert.equal((await readdir(path.join(root, session.examId, session.candidateId))).length, 2, 'the losing digest leaves no unused video');
    assert.equal((await POST(upload(changedVideo))).status, 409);
    assert.equal(rows.size, 2);
    assert.equal((await readdir(path.join(root, session.examId, session.candidateId))).length, 2);
    assert.equal((await POST(upload('', 'empty-video'))).status, 400);
    assert.equal((await POST(upload('fake-video', 'fake-mime'))).status, 400, 'claimed video MIME does not make arbitrary bytes valid');
    assert.equal((await POST(upload('video', 'bad-time', { endedAt: 'invalid-date' }))).status, 400);
    assert.equal((await POST(upload('video', 'other-candidate', { candidateId: 'another-candidate' }))).status, 400);
    const legacy = await Promise.all([POST(upload(video, null)), POST(upload(video, null))]);
    assert.ok(legacy.every((response) => response.ok));
    assert.equal(rows.size, 3);
    session.status = 'FINISHED';
    session.endedAt = new Date(Date.now() - 31 * 60_000);
    assert.equal((await POST(upload())).status, 200, 'already persisted uploads can acknowledge a lost response after the grace window');
    assert.equal((await POST(upload(video, 'late-upload'))).status, 409);
    session.status = 'IN_EXAM';
    session.endedAt = null;
    examEnd = new Date(Date.now() - 60_000);
    assert.equal((await POST(upload(video, 'tail-upload'))).status, 201, 'final buffered data can upload even before the heartbeat closes the session');
  } finally {
    prisma.clientSession.findUnique = originals.session;
    prisma.clientSession.findFirst = originals.preSession;
    prisma.requestRateBucket.upsert = originals.rate;
    prisma.$transaction = originals.transaction;
    prisma.exam.findUnique = originals.exam;
    prisma.systemSetting.findUnique = originals.settings;
    prisma.mediaSegment.findUnique = originals.segment;
    prisma.mediaSegment.findUniqueOrThrow = originals.requiredSegment;
    prisma.mediaSegment.upsert = originals.upsert;
    await rm(root, { recursive: true, force: true });
  }
});
