// Explicit local database test. Creates only disposable exam records and files; never contacts Hydro.
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prisma } from '../src/lib/db';
import { getStorageSettings } from '../src/lib/settings';
import { createPairSecret } from '../src/lib/pairing-security';
import { POST as issueTicket } from '../src/app/api/client/material-upload-ticket/route';
import { POST as upload } from '../src/app/api/client/upload/route';
import { POST as qrLogin } from '../src/app/api/login-requests/route';
import { POST as credentials } from '../src/app/api/client/credential-login/route';
import { assertReviewMaterials, consumeRateLimit, hashUploadTicket, reserveUploadBytes, UploadSecurityError, validatedLoginMaterials } from '../src/lib/upload-security';
import type { Prisma } from '@prisma/client';

const marker = `materials-qa-${randomUUID()}`;
const examIds: string[] = [];
const reservationIds = new Set<string>();
const budgetScopes = new Set<string>();
const rateChanges = new Map<string, { previous: boolean; increments: number }>();
const rateSnapshots = new Map<string, Promise<void>>();
const original = { fetch: globalThis.fetch, rateUpsert: prisma.requestRateBucket.upsert, rateUpdate: prisma.requestRateBucket.update };
let uploadRoot = '';
let expectedOjTickets = 0;

// Observe real database calls solely to undo this test's counters without resetting other clients' buckets.
async function rateSnapshot(id: string) {
  if (!rateSnapshots.has(id)) rateSnapshots.set(id, (async () => {
    const previous = Boolean(await prisma.requestRateBucket.findUnique({ where: { id } }));
    rateChanges.set(id, { previous, increments: 0 });
  })());
  await rateSnapshots.get(id);
}
prisma.requestRateBucket.upsert = (async (args: any) => {
  await rateSnapshot(args.where.id);
  const result = await original.rateUpsert(args);
  rateChanges.get(args.where.id)!.increments++;
  return result;
}) as typeof original.rateUpsert;
prisma.requestRateBucket.update = (async (args: any) => {
  await rateSnapshot(args.where.id);
  const result = await original.rateUpdate(args);
  rateChanges.get(args.where.id)!.increments++;
  return result;
}) as typeof original.rateUpdate;
globalThis.fetch = async input => {
  assert.match(String(input), /\/api\/proctor\/login-ticket$/);
  return Response.json({ ok: true, loginUrl: 'https://fixture.example.test/login' });
};

async function post(handler: (request: Request) => Promise<Response>, body: object, status: number) {
  const response = await handler(new Request('http://localhost:4031/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const result = await response.json();
  assert.equal(response.status, status, result.message || 'Unexpected status');
  return result.data;
}
async function newPair() {
  return prisma.pairingSession.create({ data: { pairCode: String(randomInt(100000, 1000000)), desktopDeviceId: marker,
    purpose: 'INITIAL', pollTokenHash: createPairSecret('POLL').hash, screenOk: true, desktopCameraOk: true, expiresAt: new Date(Date.now() + 300_000) } });
}
async function material(ticket: string | undefined, examId: string, channel: string, bytes: Buffer, type: string, status: number, candidateId?: string) {
  const form = new FormData();
  form.append('file', new File([Uint8Array.from(bytes)], channel === 'ROOM_VIDEO' ? 'room.webm' : 'identity.jpg', { type }));
  form.append('examId', examId); form.append('channel', channel);
  if (candidateId) form.append('candidateId', candidateId);
  const response = await upload(new Request('http://localhost:4031/api/client/upload', { method: 'POST', headers: ticket ? { 'x-proctor-upload-ticket': ticket } : {}, body: form }));
  const result = await response.json();
  if (response.ok && result.data?.segment) {
    const stored = await readFile(path.join(uploadRoot, result.data.segment.objectPath));
    reservationIds.add(`${result.data.segment.id}:${createHash('sha256').update(stored).digest('hex')}`);
  }
  assert.equal(response.status, status, result.message || 'Unexpected upload status');
  return result.data;
}

async function reserveFixture(scope: string, bytes: number, limit: number, reservationId: string) {
  budgetScopes.add(scope); reservationIds.add(reservationId);
  return reserveUploadBytes(scope, bytes, limit, reservationId);
}

try {
  const settings = await getStorageSettings();
  assert.equal(settings.provider, 'LOCAL', 'Use a local development database with LOCAL storage; do not alter shared settings for this test');
  uploadRoot = path.resolve(process.cwd(), settings.localUploadDir);
  const video = await readFile(new URL('./fixtures/material-room.webm', import.meta.url));
  const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#c5d8ef' } }).jpeg().toBuffer();
  const exam = await prisma.exam.create({ data: { examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(Date.now() - 60_000), latestStartAt: new Date(Date.now() + 3_600_000), endAt: new Date(Date.now() + 7_200_000), durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker, contestType: 'TEAM', teamAccountMode: 'TEAM_ACCOUNT', requireMiniProgram: true, requireFrontCamera: false, rules: 'Disposable material security integration' } });
  examIds.push(exam.id);
  const identityA = { examCode: exam.examCode!, examNumber: `${marker}-a`, password: marker, name: '材料甲', studentId: `${marker}-student-a`, school: '测试学校', college: '测试学院', teamName: '测试甲队' };
  const identityB = { ...identityA, examNumber: `${marker}-b`, name: '材料乙', studentId: `${marker}-student-b`, teamName: '测试乙队' };
  const { examCode: _codeA, ...candidateDataA } = identityA;
  const { examCode: _codeB, ...candidateDataB } = identityB;
  const candidateA = await prisma.candidate.create({ data: { ...candidateDataA, examId: exam.id, seatNo: 'QA-A',
    teamMembers: '材料甲、甲队员', teamMemberStudentIds: `${identityA.studentId}、${marker}-student-a2` } });
  const candidateB = await prisma.candidate.create({ data: { ...candidateDataB, examId: exam.id, seatNo: 'QA-B' } });
  const room = await prisma.examRoom.create({ data: { examId: exam.id, name: marker, loginMode: 'SECOND_CAMERA_QR', loginReviewMode: 'AUTO', requireSecondCamera: true, requireFrontCamera: false,
    candidates: { create: [{ candidateId: candidateA.id }, { candidateId: candidateB.id }] } } });
  const [pairA, pairB] = await Promise.all([newPair(), newPair()]);
  budgetScopes.add(`materials:${pairA.id}:${candidateA.id}`);
  budgetScopes.add(`materials:${pairB.id}:${candidateB.id}`);
  const identityInputA = { ...identityA, pairCode: pairA.pairCode, miniProgramDeviceId: `${marker}-phone-a` };
  const identityInputB = { ...identityB, pairCode: pairB.pairCode, miniProgramDeviceId: `${marker}-phone-b` };
  await post(issueTicket, { ...identityInputA, password: 'incorrect' }, 401);
  const issuedA = await post(issueTicket, identityInputA, 200);
  assert.equal(issuedA.candidateId, candidateA.id);
  const persistedGrant = await prisma.materialUploadGrant.findUniqueOrThrow({ where: { tokenHash: hashUploadTicket(issuedA.uploadTicket) } });
  assert.equal(persistedGrant.pairingId, pairA.id); assert.equal(persistedGrant.deviceId, identityInputA.miniProgramDeviceId);
  assert.equal(persistedGrant.memberStudentId, identityA.studentId);
  assert.notEqual(persistedGrant.tokenHash, issuedA.uploadTicket);
  await material(undefined, exam.id, 'ROOM_VIDEO', video, 'video/webm', 401);
  await material(issuedA.uploadTicket, exam.id, 'IDENTITY_PHOTO', Buffer.from('fake image'), 'image/jpeg', 400);
  await material(issuedA.uploadTicket, exam.id, 'ROOM_VIDEO', Buffer.from('fake video'), 'video/webm', 400);
  await material(issuedA.uploadTicket, exam.id, 'IDENTITY_PHOTO', photo, 'image/jpeg', 403, candidateB.id);
  const imageA = await material(issuedA.uploadTicket, exam.id, 'IDENTITY_PHOTO', photo, 'image/jpeg', 201);
  const videoA = await material(issuedA.uploadTicket, exam.id, 'ROOM_VIDEO', video, 'video/webm', 201);
  assert.ok(imageA.segment.validatedAt); assert.ok(videoA.segment.durationSeconds >= 3 && videoA.segment.durationSeconds <= 15);
  assert.equal(imageA.segment.candidateId, candidateA.id); assert.equal(videoA.segment.uploadGrantId, persistedGrant.id);
  const materialsA = { uploadTicket: issuedA.uploadTicket, identityPhotoPath: imageA.stored.objectPath, roomVideoPath: videoA.stored.objectPath };
  assert.ok(videoA.segment.durationSeconds >= 3 && videoA.segment.durationSeconds < 4, 'a real short recording is accepted');
  for (const durationSeconds of [2.9, 15.1]) {
    await prisma.mediaSegment.update({ where: { id: videoA.segment.id }, data: { durationSeconds } });
    await assert.rejects(validatedLoginMaterials(prisma as unknown as Prisma.TransactionClient, { ...identityInputA, ...materialsA },
      exam.id, candidateA.id, pairA.id, new Date(), { memberStudentId: identityA.studentId, memberName: identityA.name }), /3–15 秒/);
  }
  await prisma.mediaSegment.update({ where: { id: videoA.segment.id }, data: { durationSeconds: videoA.segment.durationSeconds } });
  await post(qrLogin, { ...identityInputB, ...materialsA, miniProgramDeviceId: identityInputA.miniProgramDeviceId }, 403);
  await post(qrLogin, { ...identityInputA, ...materialsA, pairCode: pairB.pairCode }, 403);
  await post(qrLogin, { ...identityInputA, ...materialsA, name: '甲队员', studentId: `${marker}-student-a2` }, 403);
  await post(qrLogin, { ...identityInputA, ...materialsA, miniProgramDeviceId: `${marker}-other-phone` }, 403);
  await post(qrLogin, { ...identityInputA, ...materialsA, identityPhotoPath: `${exam.id}/forged.jpg`, roomVideoPath: `${exam.id}/forged.webm` }, 400);
  assert.equal(await prisma.clientSession.count({ where: { examId: exam.id } }), 0, 'AUTO review cannot accept invented material paths');
  // The ninth authenticated upload fails before reading or decoding its body.
  for (let index = 0; index < 3; index++) await material(issuedA.uploadTicket, exam.id, 'IDENTITY_PHOTO', photo, 'image/jpeg', 200);
  await material(issuedA.uploadTicket, exam.id, 'IDENTITY_PHOTO', photo, 'image/jpeg', 429);
  const auto = await post(qrLogin, { ...identityInputA, ...materialsA }, 201); expectedOjTickets++;
  const autoSession = await prisma.clientSession.findUniqueOrThrow({ where: { id: auto.sessionId } });
  assert.equal(autoSession.status, 'APPROVED'); assert.ok(auto.miniProgramSessionToken);
  assert.equal(await prisma.mediaSegment.count({ where: { sessionId: auto.sessionId, uploadGrantId: persistedGrant.id } }), 2);
  assert.ok((await prisma.materialUploadGrant.findUniqueOrThrow({ where: { id: persistedGrant.id } })).consumedAt);
  await assert.rejects(validatedLoginMaterials(prisma as unknown as Prisma.TransactionClient, { ...identityInputA, ...materialsA }, exam.id, candidateA.id, pairA.id, new Date(), { memberStudentId: identityA.studentId, memberName: identityA.name }), error => error instanceof Error && /凭据已失效/.test(error.message));
  await material(issuedA.uploadTicket, exam.id, 'ROOM_VIDEO', video, 'video/webm', 401);

  // Credential-first login uses its signed identity ticket for the same grant and media validation chain.
  await prisma.examRoom.update({ where: { id: room.id }, data: { loginMode: 'CREDENTIALS', loginReviewMode: 'MANUAL' } });
  const credential = await post(credentials, identityInputB, 200);
  assert.ok(credential.requiresSecondCamera);
  await post(issueTicket, { credentialTicket: credential.credentialTicket, pairCode: pairA.pairCode, miniProgramDeviceId: identityInputB.miniProgramDeviceId }, 403);
  const issuedB = await post(issueTicket, { credentialTicket: credential.credentialTicket, pairCode: pairB.pairCode, miniProgramDeviceId: identityInputB.miniProgramDeviceId }, 200);
  const imageB = await material(issuedB.uploadTicket, exam.id, 'IDENTITY_PHOTO', photo, 'image/jpeg', 201);
  const videoB = await material(issuedB.uploadTicket, exam.id, 'ROOM_VIDEO', video, 'video/webm', 201);
  const manual = await post(credentials, { credentialTicket: credential.credentialTicket, miniProgramDeviceId: identityInputB.miniProgramDeviceId, uploadTicket: issuedB.uploadTicket,
    identityPhotoPath: imageB.stored.objectPath, roomVideoPath: videoB.stored.objectPath }, 201);
  assert.equal((await prisma.loginRequest.findUniqueOrThrow({ where: { id: manual.id } })).status, 'REQUESTING');
  await prisma.$transaction(tx => assertReviewMaterials(tx, manual.id, candidateB.id, exam.id));
  for (const durationSeconds of [2.9, 15.1]) {
    await prisma.mediaSegment.update({ where: { id: videoB.segment.id }, data: { durationSeconds } });
    await assert.rejects(prisma.$transaction(tx => assertReviewMaterials(tx, manual.id, candidateB.id, exam.id)), /材料缺失/);
  }
  await prisma.mediaSegment.update({ where: { id: videoB.segment.id }, data: { durationSeconds: videoB.segment.durationSeconds } });
  await prisma.loginRequest.update({ where: { id: manual.id }, data: { identityPhotoPath: `${exam.id}/invented.jpg` } });
  await assert.rejects(prisma.$transaction(tx => assertReviewMaterials(tx, manual.id, candidateB.id, exam.id)), /材料缺失/);
  await prisma.loginRequest.update({ where: { id: manual.id }, data: { identityPhotoPath: imageB.stored.objectPath } });
  await prisma.$transaction(tx => assertReviewMaterials(tx, manual.id, candidateB.id, exam.id));

  // Real concurrent database updates: duplicate content is charged once; a different digest must be charged again.
  const quotaScope = `${marker}:quota`;
  const sameId = `${marker}:id:digest-a`, differentId = `${marker}:id:digest-b`;
  await Promise.all(Array.from({ length: 4 }, () => reserveFixture(quotaScope, 3, 100, sameId)));
  assert.equal((await prisma.uploadBudget.findUniqueOrThrow({ where: { scope: quotaScope } })).bytes, 3n);
  await Promise.all(Array.from({ length: 2 }, () => reserveFixture(quotaScope, 7, 100, differentId)));
  assert.equal((await prisma.uploadBudget.findUniqueOrThrow({ where: { scope: quotaScope } })).bytes, 10n);
  await assert.rejects(reserveFixture(quotaScope, 91, 100, `${marker}:over-limit`), error => error instanceof UploadSecurityError && error.status === 413);
  const raceScope = `${marker}:quota-race`;
  const race = await Promise.allSettled(['a', 'b'].map(id => reserveFixture(raceScope, 60, 100, `${marker}:race:${id}`)));
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await prisma.uploadBudget.findUniqueOrThrow({ where: { scope: raceScope } })).bytes, 60n);
  const limited = await Promise.allSettled(Array.from({ length: 3 }, () => consumeRateLimit(`${marker}:rate`, 2, 3_600_000)));
  assert.equal(limited.filter(item => item.status === 'fulfilled').length, 2);
  assert.ok(limited.some(item => item.status === 'rejected' && item.reason instanceof UploadSecurityError && item.reason.status === 429));
  console.log('PASS: real material grants, actual decoded media, candidate/pair/device/team binding, forged-path AUTO/manual rejection, single-use grants, rate limits and concurrent digest-bound quotas');
} finally {
  // Finish the only mocked asynchronous OJ-ticket task before removing its disposable foreign keys.
  if (expectedOjTickets) for (let attempt = 0; attempt < 100; attempt++) {
    if (await prisma.oJLoginTicket.count({ where: { examId: { in: examIds } } }) >= expectedOjTickets) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  prisma.requestRateBucket.upsert = original.rateUpsert; prisma.requestRateBucket.update = original.rateUpdate;
  globalThis.fetch = original.fetch;
  await prisma.pairingSession.deleteMany({ where: { desktopDeviceId: marker } });
  await prisma.materialUploadGrant.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.uploadReservation.deleteMany({ where: { id: { in: [...reservationIds] } } });
  await prisma.uploadBudget.deleteMany({ where: { scope: { in: [...budgetScopes] } } });
  for (const [id, change] of rateChanges) {
    if (!change.previous && (await prisma.requestRateBucket.deleteMany({ where: { id, count: change.increments } })).count) continue;
    await prisma.requestRateBucket.updateMany({ where: { id, count: { gte: change.increments } }, data: { count: { decrement: change.increments } } });
  }
  await prisma.exam.deleteMany({ where: { id: { in: examIds }, name: marker } });
  for (const id of examIds) if (uploadRoot) await rm(path.join(uploadRoot, id), { recursive: true, force: true });
  assert.equal(await prisma.exam.count({ where: { name: marker } }), 0);
  assert.equal(await prisma.materialUploadGrant.count({ where: { examId: { in: examIds } } }), 0);
  assert.equal(await prisma.uploadBudget.count({ where: { scope: { in: [...budgetScopes] } } }), 0);
  assert.equal(await prisma.uploadReservation.count({ where: { id: { in: [...reservationIds] } } }), 0);
  await prisma.$disconnect();
}
