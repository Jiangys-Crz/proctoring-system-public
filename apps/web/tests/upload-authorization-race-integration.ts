// Disposable database coverage for authority changes while a file is decoded/stored.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/lib/db';
import { getStorageSettings } from '../src/lib/settings';
import { hashUploadTicket } from '../src/lib/upload-security';
import { createClientSessionToken } from '../src/lib/client-auth';
import { processFileDeletions } from '../src/lib/file-deletion';
import { POST } from '../src/app/api/client/upload/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/proctor_recording_qa(?:_[a-z_]+)?$/, 'requires an isolated recording QA database');
const marker = `upload-race-${randomUUID()}`;
const originals = { grant: prisma.materialUploadGrant.findUnique, pair: prisma.pairingSession.findUnique, session: prisma.clientSession.findUnique };
const pairIds: string[] = [];
let examId = '', root = '';
try {
  const settings = await getStorageSettings(); assert.equal(settings.provider, 'LOCAL');
  root = path.resolve(process.cwd(), settings.localUploadDir);
  const now = Date.now();
  const exam = await prisma.exam.create({ data: { examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(now - 60_000), latestStartAt: new Date(now + 3_600_000), endAt: new Date(now + 7_200_000), durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker, contestType: 'INDIVIDUAL', rules: marker, saveFullRecording: true } });
  examId = exam.id;
  const candidate = await prisma.candidate.create({ data: { examId, examNumber: marker, password: marker, seatNo: 'QA' } });
  const video = await readFile(new URL('./fixtures/material-room.webm', import.meta.url));
  async function grant() {
    const pair = await prisma.pairingSession.create({ data: { pairCode: String(randomInt(100000, 1000000)), desktopDeviceId: marker,
      purpose: 'INITIAL', expiresAt: new Date(now + 300_000) } });
    pairIds.push(pair.id);
    const token = randomUUID();
    const row = await prisma.materialUploadGrant.create({ data: { tokenHash: hashUploadTicket(token), examId, candidateId: candidate.id,
      pairingId: pair.id, deviceId: marker, expiresAt: new Date(now + 300_000) } });
    return { token, row, pair };
  }
  async function upload(token: string, sessionId?: string) {
    const form = new FormData();
    form.set('examId', examId); form.set('channel', sessionId ? 'DESKTOP_SCREEN' : 'ROOM_VIDEO');
    if (sessionId) form.set('sessionId', sessionId);
    form.set('file', new File([Uint8Array.from(video)], 'room.webm', { type: 'video/webm' }));
    const response = await POST(new Request('http://localhost/api/client/upload', { method: 'POST', body: form,
      headers: sessionId ? { authorization: `Bearer ${token}` } : { 'x-proctor-upload-ticket': token } }));
    const body = await response.json();
    assert.equal(response.status, 401, JSON.stringify(body));
  }

  const deleted = await grant();
  prisma.materialUploadGrant.findUnique = (async (args: any) => {
    const row = await originals.grant(args);
    if (args.where.tokenHash === deleted.row.tokenHash) await prisma.materialUploadGrant.delete({ where: { id: deleted.row.id } });
    return row;
  }) as typeof originals.grant;
  await upload(deleted.token);
  prisma.materialUploadGrant.findUnique = originals.grant;
  assert.equal(await prisma.fileDeletionJob.count({ where: { examId } }), 0, 'deleted admission grants fail before writing a file');

  const consumed = await grant();
  prisma.materialUploadGrant.findUnique = (async (args: any) => {
    const row = await originals.grant(args);
    if (args.where.id === consumed.row.id) await prisma.materialUploadGrant.update({ where: { id: consumed.row.id }, data: { consumedAt: new Date() } });
    return row;
  }) as typeof originals.grant;
  await upload(consumed.token);
  prisma.materialUploadGrant.findUnique = originals.grant;
  assert.equal(await prisma.fileDeletionJob.count({ where: { examId } }), 1, 'consumed during decoding queues cleanup after storage');

  const claimed = await grant();
  let pairReads = 0;
  prisma.pairingSession.findUnique = (async (args: any) => {
    const row = await originals.pair(args);
    if (args.where.id === claimed.pair.id && ++pairReads === 2) await prisma.pairingSession.update({ where: { id: claimed.pair.id }, data: { claimedAt: new Date() } });
    return row;
  }) as typeof originals.pair;
  await upload(claimed.token);
  prisma.pairingSession.findUnique = originals.pair;
  assert.equal(await prisma.fileDeletionJob.count({ where: { examId } }), 2, 'a pair claimed during decoding cannot publish material');

  const token = createClientSessionToken();
  const session = await prisma.clientSession.create({ data: { examId, candidateId: candidate.id, desktopDeviceId: marker,
    desktopTokenHash: token.tokenHash, status: 'IN_EXAM' } });
  prisma.clientSession.findUnique = (async (args: any) => {
    const row = await originals.session(args);
    if (args.where.id === session.id) await prisma.clientSession.update({ where: { id: session.id }, data: { desktopTokenHash: createClientSessionToken().tokenHash } });
    return row;
  }) as typeof originals.session;
  await upload(token.token, session.id);
  prisma.clientSession.findUnique = originals.session;
  assert.equal(await prisma.mediaSegment.count({ where: { examId } }), 0);
  assert.equal(await prisma.fileDeletionJob.count({ where: { examId } }), 3, 'token rotation during decoding queues cleanup');
  const jobs = await prisma.fileDeletionJob.findMany({ where: { examId } });
  await processFileDeletions({ examId });
  assert.equal(await prisma.fileDeletionJob.count({ where: { examId, completedAt: null } }), 0);
  for (const job of jobs) await assert.rejects(readFile(path.join(root, job.objectPath)), { code: 'ENOENT' });
  console.log(JSON.stringify({ ok: true, deletedGrantRejected: true, consumedGrantRejected: true, claimedPairRejected: true, rotatedTokenRejected: true, orphanedFilesCleaned: 3 }));
} finally {
  prisma.materialUploadGrant.findUnique = originals.grant;
  prisma.pairingSession.findUnique = originals.pair;
  prisma.clientSession.findUnique = originals.session;
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.pairingSession.deleteMany({ where: { id: { in: pairIds } } });
  if (root && examId) await rm(path.join(root, examId), { recursive: true, force: true });
  await prisma.$disconnect();
}
