// Run explicitly against a local development database: tsx --env-file=.env tests/login-integration.ts
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { POST as credentials } from '../src/app/api/client/credential-login/route';
import { POST as qrLogin } from '../src/app/api/login-requests/route';
import { POST as verifyQr } from '../src/app/api/client/candidate-verify/route';
import { POST as materialTicket } from '../src/app/api/client/material-upload-ticket/route';
import { createPairSecret } from '../src/lib/pairing-security';
import { hashUploadTicket } from '../src/lib/upload-security';

const marker = `login-qa-${randomUUID()}`;
let examId: string | undefined;
const originalFetch = globalThis.fetch;
let expectedOjTicket = false;
if (!process.env.PROCTOR_LOGIN_TEST_BASE) globalThis.fetch = async input => {
  assert.match(String(input), /\/api\/proctor\/login-ticket$/);
  return Response.json({ ok: true, loginUrl: 'https://fixture.example.test/login' });
};
async function request(handler: (r: Request) => Promise<Response>, body: object, status: number) {
  const path = handler === credentials ? '/api/client/credential-login' : handler === qrLogin ? '/api/login-requests' : '/api/client/candidate-verify';
  const input = new Request(`${process.env.PROCTOR_LOGIN_TEST_BASE || 'http://localhost'}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const response = process.env.PROCTOR_LOGIN_TEST_BASE ? await fetch(input) : await handler(input);
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
async function newPair() {
  return prisma.pairingSession.create({ data: {
    pairCode: String(randomInt(100000, 1000000)), desktopDeviceId: marker,
    purpose: 'INITIAL', pollTokenHash: createPairSecret('POLL').hash,
    screenOk: true, desktopCameraOk: true, expiresAt: new Date(Date.now() + 300000)
  } });
}
try {
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(Date.now() - 60000), latestStartAt: new Date(Date.now() + 3600000),
    endAt: new Date(Date.now() + 7200000), durationMinutes: 120, platform: 'HYDRO',
    platformBaseUrl: 'http://localhost', platformContestId: marker, contestType: 'INDIVIDUAL',
    requireMiniProgram: false, requireFrontCamera: false, rules: 'Integration test'
  } });
  examId = exam.id;
  const identity = { name: '登录测试', examNumber: marker, password: marker, studentId: marker, school: '测试学校', college: '测试学院' };
  const candidate = await prisma.candidate.create({ data: { ...identity, examId, seatNo: 'test' } });
  const room = await prisma.examRoom.create({ data: {
    examId, name: marker, loginMode: 'SECOND_CAMERA_QR', requireSecondCamera: false,
    requireFrontCamera: false, candidates: { create: { candidateId: candidate.id } }
  } });
  assert.equal(room.loginReviewMode, 'MANUAL');
  const pair = await newPair();
  const input = { name: identity.name, examNumber: identity.examNumber, password: identity.password, examCode: exam.examCode, pairCode: pair.pairCode };
  // Reject every entry point before either consuming pairing or creating login/material records.
  await prisma.exam.update({ where: { id: examId }, data: { startAt: new Date(Date.now() + 41 * 60_000) } });
  for (const handler of [verifyQr, qrLogin]) {
    assert.match((await request(handler, input, 403)).message, /开始前 40 分钟/);
  }
  await prisma.examRoom.update({ where: { id: room.id }, data: { loginMode: 'CREDENTIALS', requireSecondCamera: true } });
  assert.match((await request(credentials, input, 403)).message, /开始前 40 分钟/);
  await prisma.examRoom.update({ where: { id: room.id }, data: { loginMode: 'SECOND_CAMERA_QR' } });
  const uploadResponse = await materialTicket(new Request('http://localhost/api/client/material-upload-ticket', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, miniProgramDeviceId: marker })
  }));
  assert.equal(uploadResponse.status, 403);
  assert.match((await uploadResponse.json()).message, /开始前 40 分钟/);
  assert.equal(await prisma.loginRequest.count({ where: { examId } }), 0);
  assert.equal(await prisma.clientSession.count({ where: { examId } }), 0);
  assert.equal(await prisma.materialUploadGrant.count({ where: { examId } }), 0);
  assert.equal((await prisma.pairingSession.findUniqueOrThrow({ where: { id: pair.id } })).claimedAt, null);
  await prisma.exam.update({ where: { id: examId }, data: { startAt: new Date(Date.now() + 39 * 60_000) } });
  await request(verifyQr, input, 200);
  await prisma.exam.update({ where: { id: examId }, data: { startAt: exam.startAt } });
  await prisma.examRoom.update({ where: { id: room.id }, data: { requireSecondCamera: false } });
  await request(credentials, { ...input, name: '错误姓名' }, 401);
  const denied = await request(credentials, input, 403);
  assert.match(denied.message, /改用二维码/);
  assert.equal(await prisma.clientSession.count({ where: { examId } }), 0);
  await request(verifyQr, input, 200);
  await request(verifyQr, { ...input, name: '错误姓名' }, 400);
  await request(verifyQr, { ...input, password: '错误密码' }, 400);
  // Team member identity is resolved from the registered name, without asking for student ID or school.
  await prisma.exam.update({ where: { id: examId }, data: { contestType: 'TEAM', teamAccountMode: 'TEAM_ACCOUNT' } });
  await prisma.candidate.update({ where: { id: candidate.id }, data: { teamName: '测试队', teamMembers: '队员甲、队员乙', teamMemberStudentIds: 'MEMBER_A、MEMBER_B' } });
  const memberLogin = await request(verifyQr, { ...input, name: '队员乙' }, 200);
  assert.equal(memberLogin.data.memberIdentity.memberStudentId, 'MEMBER_B');
  await prisma.candidate.update({ where: { id: candidate.id }, data: { teamMembers: '同名、同名' } });
  await request(verifyQr, { ...input, name: '同名' }, 400);
  await prisma.exam.update({ where: { id: examId }, data: { contestType: 'INDIVIDUAL' } });
  await prisma.examRoom.update({ where: { id: room.id }, data: { loginMode: 'CREDENTIALS' } });
  await request(verifyQr, input, 403);
  await request(qrLogin, input, 403);
  const direct = await request(credentials, input, 201);
  assert.equal(direct.data.requiresSecondCamera, false);
  assert.ok(direct.data.sessionId);
  const sameLogin = await request(credentials, input, 200);
  assert.equal(sameLogin.data.sessionId, direct.data.sessionId);
  await prisma.clientSession.updateMany({ where: { examId }, data: { status: 'FINISHED' } });
  await prisma.examRoom.update({ where: { id: room.id }, data: { requireSecondCamera: true } });
  const secondPair = await newPair();
  const pending = await request(credentials, { ...input, pairCode: secondPair.pairCode }, 200);
  assert.equal(pending.data.requiresSecondCamera, true);
  assert.equal(await prisma.clientSession.count({ where: { examId, status: 'WAITING_REVIEW' } }), 0);
  const ticket = pending.data.credentialTicket;
  await prisma.exam.update({ where: { id: examId }, data: { startAt: new Date(Date.now() + 41 * 60_000) } });
  assert.match((await request(credentials, { credentialTicket: ticket, action: 'inspect' }, 403)).message, /开始前 40 分钟/);
  await prisma.exam.update({ where: { id: examId }, data: { startAt: exam.startAt } });
  const inspection = await request(credentials, { credentialTicket: ticket, action: 'inspect' }, 200);
  assert.equal(inspection.data.name, identity.name);
  assert.equal(inspection.data.password, undefined);
  // A valid grant still cannot make invented paths into uploaded, decoded materials.
  // The complete upload-ticket HTTP flow is covered by material-upload-integration.ts.
  const uploadTicket = randomBytes(32).toString('base64url');
  await prisma.materialUploadGrant.create({ data: { tokenHash: hashUploadTicket(uploadTicket), examId, candidateId: candidate.id, pairingId: secondPair.id,
    deviceId: marker, memberName: identity.name, memberStudentId: identity.studentId, expiresAt: secondPair.expiresAt } });
  const materials = { credentialTicket: ticket, uploadTicket, miniProgramDeviceId: marker, identityPhotoPath: `${marker}/photo.jpg`, roomVideoPath: `${marker}/room.webm` };
  await prisma.examRoom.update({ where: { id: room.id }, data: { loginMode: 'SECOND_CAMERA_QR' } });
  await request(credentials, materials, 403);
  await prisma.examRoom.update({ where: { id: room.id }, data: { loginMode: 'CREDENTIALS' } });
  await request(credentials, materials, 400);
  assert.equal(await prisma.clientSession.count({ where: { examId, status: 'WAITING_REVIEW' } }), 0, 'invented material paths never create a session; legal media are covered by material-upload-integration');
  await prisma.clientSession.updateMany({ where: { examId }, data: { status: 'FINISHED' } });
  await prisma.examRoom.update({ where: { id: room.id }, data: { loginMode: 'SECOND_CAMERA_QR', requireSecondCamera: false } });
  const qrPair = await newPair();
  await request(qrLogin, { ...input, pairCode: qrPair.pairCode }, 201);
  await prisma.clientSession.updateMany({ where: { examId }, data: { status: 'FINISHED' } });
  await prisma.examRoom.update({
    where: { id: room.id },
    data: { loginMode: 'CREDENTIALS', loginReviewMode: 'AUTO', requireSecondCamera: false }
  });
  const autoPair = await newPair();
  const automatic = await request(credentials, { ...input, pairCode: autoPair.pairCode }, 201);
  expectedOjTicket = true;
  const automaticSession = await prisma.clientSession.findUniqueOrThrow({ where: { id: automatic.data.sessionId } });
  const automaticRequest = await prisma.loginRequest.findUniqueOrThrow({ where: { id: automaticSession.loginRequestId! } });
  assert.equal(automaticSession.status, 'APPROVED');
  assert.ok(automaticSession.approvedAt);
  assert.equal(automaticRequest.status, 'APPROVED');
  assert.ok(automaticRequest.reviewedAt);
  console.log('PASS: four-field individual/team login, incorrect and ambiguous names rejected, room policy, idempotent login, second-camera tickets, forged materials rejected, QR login, automatic review');
} finally {
  if (expectedOjTicket && examId) for (let attempt = 0; attempt < 100; attempt++) {
    if (await prisma.oJLoginTicket.count({ where: { examId } })) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  globalThis.fetch = originalFetch;
  await prisma.pairingSession.deleteMany({ where: { desktopDeviceId: marker } });
  if (examId) await prisma.materialUploadGrant.deleteMany({ where: { examId } });
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.$disconnect();
}
