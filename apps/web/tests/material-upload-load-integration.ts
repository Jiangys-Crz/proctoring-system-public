// Runs only against a disposable recording QA database and LOCAL upload store.
import assert from 'node:assert/strict';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prisma } from '../src/lib/db';
import { getStorageSettings } from '../src/lib/settings';
import { acquireUploadSlot, hashUploadTicket } from '../src/lib/upload-security';
import { POST } from '../src/app/api/client/upload/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/proctor_recording_qa(?:_[a-z_]+)?$/, 'requires an isolated recording QA database');
const marker = `material-load-${randomUUID()}`;
const releaseRecordings: (() => void)[] = [];
const pairIds: string[] = [];
const recordingRates = new Map<string, { count: number; expiresAt: Date } | null>();
let examId = '', root = '';
try {
  const settings = await getStorageSettings(); assert.equal(settings.provider, 'LOCAL');
  root = path.resolve(process.cwd(), settings.localUploadDir);
  const now = Date.now();
  const exam = await prisma.exam.create({ data: { examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(now - 60_000), latestStartAt: new Date(now + 3_600_000), endAt: new Date(now + 7_200_000), durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker, contestType: 'INDIVIDUAL', rules: marker } });
  examId = exam.id;
  const fixtures: { token: string; pairingId: string; candidateId: string }[] = [];
  const pairStart = randomInt(100000, 999000);
  for (let index = 0; index < 30; index++) {
    const candidate = await prisma.candidate.create({ data: { examId, examNumber: `${marker}-${index}`, password: marker, seatNo: String(index) } });
    const pair = await prisma.pairingSession.create({ data: { pairCode: String(pairStart + index), desktopDeviceId: marker,
      purpose: 'INITIAL', expiresAt: new Date(now + 300_000) } });
    pairIds.push(pair.id);
    const token = randomUUID();
    await prisma.materialUploadGrant.create({ data: { tokenHash: hashUploadTicket(token), examId, candidateId: candidate.id,
      pairingId: pair.id, deviceId: marker, expiresAt: new Date(now + 300_000) } });
    fixtures.push({ token, pairingId: pair.id, candidateId: candidate.id });
  }
  const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#ccddee' } }).jpeg().toBuffer();
  const video = await readFile(new URL('./fixtures/material-room.webm', import.meta.url));
  // A recording retry storm must not consume the separate material rate pool.
  for (const minute of [Math.floor(Date.now() / 60_000), Math.floor(Date.now() / 60_000) + 1]) {
    const id = createHash('sha256').update(`uploads:global:${minute}`).digest('hex');
    recordingRates.set(id, await prisma.requestRateBucket.findUnique({ where: { id } }));
    await prisma.requestRateBucket.upsert({ where: { id }, create: { id, count: 1200, expiresAt: new Date(Date.now() + 120_000) }, update: { count: 1200 } });
  }
  // Fill every ordinary recording slot for the entire test. Login uploads must
  // still complete, with no client retries and only two per-candidate charges.
  for (let index = 0; index < 4; index++) releaseRecordings.push(acquireUploadSlot());
  const startedAt = Date.now();
  const results = await Promise.allSettled(fixtures.map(async fixture => {
    for (const [channel, bytes, type] of [['IDENTITY_PHOTO', photo, 'image/jpeg'], ['ROOM_VIDEO', video, 'video/webm']] as const) {
      const form = new FormData();
      form.set('examId', examId); form.set('channel', channel);
      form.set('file', new File([Uint8Array.from(bytes)], channel, { type }));
      const response = await POST(new Request('http://localhost/api/client/upload', { method: 'POST',
        headers: { 'x-proctor-upload-ticket': fixture.token }, body: form }));
      const result = await response.json();
      assert.equal(response.status, 201, `${channel}: ${JSON.stringify(result)}`);
    }
  }));
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => String(result.reason)), []);
  assert.equal(await prisma.mediaSegment.count({ where: { examId, validatedAt: { not: null } } }), 60);
  for (const fixture of fixtures) {
    const ids = Array.from({ length: Math.floor(Date.now() / 60_000) - Math.floor(startedAt / 60_000) + 1 }, (_, index) =>
      createHash('sha256').update(`upload-material:${fixture.pairingId}:${fixture.candidateId}:${Math.floor(startedAt / 60_000) + index}`).digest('hex'));
    const buckets = await prisma.requestRateBucket.findMany({ where: { id: { in: ids } } });
    assert.equal(buckets.reduce((sum, bucket) => sum + bucket.count, 0), 2);
  }
  console.log(JSON.stringify({ ok: true, candidates: 30, materials: 60, recordingSlotsOccupied: 4, recordingRateSaturated: true, perCandidateRateCharges: 2, elapsedMs: Date.now() - startedAt }));
} finally {
  for (const release of releaseRecordings) release();
  for (const [id, previous] of recordingRates) {
    if (previous) await prisma.requestRateBucket.update({ where: { id }, data: { count: previous.count, expiresAt: previous.expiresAt } });
    else await prisma.requestRateBucket.deleteMany({ where: { id } });
  }
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.pairingSession.deleteMany({ where: { id: { in: pairIds } } });
  if (root && examId) await rm(path.join(root, examId), { recursive: true, force: true });
  await prisma.$disconnect();
}
