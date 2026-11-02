// Run against the local database. Only generated test candidates and their own records are removed.
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../src/lib/db';
import { ensurePublicTestExam, getPublicTestExam, cleanupPublicTestState, enrollPublicTest as enrollVerifiedPublicTest, publicTestEnrollmentKey } from '../src/lib/public-test';
import { createPairSecret } from '../src/lib/pairing-security';
import { POST as oldEnrollment, GET as metadata } from '../src/app/api/public-test/route';
import { POST as scan } from '../src/app/api/client/public-test-login/route';
import { GET as studentExams } from '../src/app/api/client/exams/route';
import { POST as loginRequest } from '../src/app/api/login-requests/route';
import { POST as credentialLogin } from '../src/app/api/client/credential-login/route';
import { GET as poll } from '../src/app/api/client/pair/route';
import { POST as disconnect } from '../src/app/api/client/test-disconnect/route';
import { POST as reconnect } from '../src/app/api/client/reconnect/route';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';
import { POST as start } from '../src/app/api/client/session/start/route';
import { POST as upload } from '../src/app/api/client/upload/route';
import { POST as alerts } from '../src/app/api/client/alerts/route';
import { authorizeAuxiliaryUpload } from '../src/lib/upload-security';
import { hashClientSessionToken } from '../src/lib/client-auth';

const enrollPublicTest = (token: string, mode: 'secondCamera') => enrollVerifiedPublicTest(String(BigInt('0x' + createHash('sha256').update(token).digest('hex').slice(0, 12))), mode);

const photoBytes = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#7390bc' } }).jpeg().toBuffer();
const videoBytes = await readFile(new URL('./fixtures/material-room.webm', import.meta.url));
const ids: string[] = [];
const pairs: string[] = [];
const enrollmentKeys: string[] = [];
async function call(handler: (request: any) => Promise<Response>, path: string, body?: object, token = '', headers: Record<string, string> = {}) {
  let payload: BodyInit | undefined = body ? JSON.stringify(body) : undefined;
  const baseHeaders: Record<string, string> = { 'content-type': 'application/json' };
  if (handler === scan && body) {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) if (value !== undefined) form.set(key, String(value));
    form.set('identityPhoto', new Blob([new Uint8Array(photoBytes)], { type: 'image/jpeg' }), 'photo.jpg');
    form.set('roomVideo', new Blob([new Uint8Array(videoBytes)], { type: 'video/webm' }), 'room.webm');
    payload = form; delete baseHeaders['content-type'];
  }
  const request = new NextRequest(`http://localhost:4031${path}`, { method: body ? 'POST' : 'GET',
    headers: { ...baseHeaders, ...(token ? { 'x-proctor-session-token': token } : {}), ...headers },
    ...(body ? { body: payload } : {}) });
  const response = await handler(request);
  return { status: response.status, body: await response.json() };
}
try {
  const [examId, other] = await Promise.all([ensurePublicTestExam(), ensurePublicTestExam()]);
  assert.equal(examId, other);
  assert.equal((await prisma.exam.findUniqueOrThrow({ where: { id: examId } })).requireMiniProgram, true);
  assert.equal((await prisma.examRoom.findMany({ where: { examId } })).every(room => room.requireSecondCamera && room.requireFrontCamera), true);
  const problem = await prisma.examProblem.findFirstOrThrow({ where: { examId } });
  assert.equal(problem.problemType, 'default'); assert.ok(problem.title);
  const enrollmentToken = randomBytes(32).toString('base64url');
  enrollmentKeys.push('public-test.account.' + String(BigInt('0x' + createHash('sha256').update(enrollmentToken).digest('hex').slice(0, 12))));
  const a = await enrollPublicTest(enrollmentToken, 'secondCamera');
  assert.deepEqual(await enrollPublicTest(enrollmentToken, 'secondCamera'), a);
  const enrolled = await prisma.candidate.findFirstOrThrow({ where: { examId, examNumber: a.examNumber } });
  ids.push(enrolled.id);
  assert.equal((await call(oldEnrollment, '/api/public-test', { mode: 'secondCamera' }, '', { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await call(oldEnrollment, '/api/public-test', { mode: 'secondCamera', examId: 'real' }, '', { origin: 'http://localhost:4031' })).status, 400);
  const listing = await call(studentExams, '/api/client/exams');
  assert.equal(listing.body.data.some((exam: { id: string }) => exam.id === examId), false);
  // The system repairs an accidental closure and retains its singleton identity.
  await prisma.exam.update({ where: { id: examId }, data: { published: false, endAt: new Date(0), latestStartAt: new Date(0) } });
  const repaired = await getPublicTestExam();
  assert.equal(repaired.id, examId); assert.ok(repaired.endAt.getFullYear() > 2099); assert.equal(repaired.published, true);
  assert.equal((await metadata()).status, 200);
  const pollSecret = createPairSecret('POLL'), testSecret = createPairSecret('RECOVERY');
  const pair = await prisma.pairingSession.create({ data: { pairCode: String(randomInt(100000, 1000000)), desktopDeviceId: `test-device-${randomBytes(8).toString('hex')}`,
    purpose: 'TEST_INITIAL', pollTokenHash: pollSecret.hash, recoveryTokenHash: testSecret.hash, screenOk: true, desktopCameraOk: true, expiresAt: new Date(Date.now() + 300000) } });
  pairs.push(pair.id);
  const phoneDevice = `test-phone-${randomBytes(8).toString('hex')}`;
  const scanInput = { examCode: a.examCode, name: a.name, examNumber: a.examNumber, password: a.password, pairCode: pair.pairCode, testSecret: testSecret.secret, deviceId: phoneDevice };
  assert.equal((await call(scan, '/api/client/public-test-login', { ...scanInput, testSecret: randomBytes(32).toString('base64url') })).status, 403);
  assert.equal((await call(scan, '/api/client/public-test-login', { ...scanInput, examId: 'real-exam' })).status, 400);
  assert.equal((await call(scan, '/api/client/public-test-login', { ...scanInput, password: 'incorrect' })).status, 401);
  const logins = await Promise.all([call(scan, '/api/client/public-test-login', scanInput), call(scan, '/api/client/public-test-login', scanInput)]);
  assert.equal(logins.filter(item => item.status === 201).length, 1);
  const login = logins.find(item => item.status === 201)!;
  const sessionId = login.body.data.sessionId;
  assert.match(sessionId, /^test_/);
  const session = await prisma.clientSession.findUniqueOrThrow({ where: { id: sessionId } });
  assert.equal(session.candidateId, enrolled.id);
  assert.equal(session.loginRequestId, null);
  assert.equal(await prisma.loginRequest.count({ where: { candidateId: session.candidateId } }), 0);
  const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: session.candidateId } });
  assert.equal(candidate.ranked, false);
  const credentials = { examCode: repaired.examCode, name: candidate.name, examNumber: candidate.examNumber, password: candidate.password, pairCode: pair.pairCode };
  assert.equal((await call(credentialLogin, '/api/client/credential-login', credentials)).status, 403);
  assert.equal((await call(loginRequest, '/api/login-requests', credentials)).status, 403);
  assert.equal((await call(poll, `/api/client/pair?pairCode=${pair.pairCode}&deviceId=${pair.desktopDeviceId}`)).status, 401);
  const polled = await call(poll, `/api/client/pair?pairCode=${pair.pairCode}&deviceId=${pair.desktopDeviceId}`, undefined, '', { 'x-proctor-pair-poll-token': pollSecret.secret });
  assert.equal(polled.status, 200); assert.equal(polled.body.data.testLogin.requirements.isPublicTest, true);
  assert.equal(polled.body.data.loginRequest, null);
  assert.equal(JSON.stringify(polled.body).includes(candidate.password), false);
  const desktopToken = polled.body.data.desktopSessionToken;
  assert.ok(desktopToken);
  const again = await call(poll, `/api/client/pair?pairCode=${pair.pairCode}&deviceId=${pair.desktopDeviceId}`, undefined, '', { 'x-proctor-pair-poll-token': pollSecret.secret });
  assert.equal(again.body.data.desktopSessionToken, desktopToken, 'retrying a lost token response returns the same credential');
  // The QR cannot be re-used or swapped into a formal/recovery pair.
  assert.equal((await call(scan, '/api/client/public-test-login', scanInput)).status, 410);
  const formalSecret = createPairSecret('RECOVERY');
  const formalPair = await prisma.pairingSession.create({ data: { pairCode: String(randomInt(100000, 1000000)), desktopDeviceId: pair.desktopDeviceId, purpose: 'RECOVERY', recoveryTokenHash: formalSecret.hash, pollTokenHash: pollSecret.hash, screenOk: true, expiresAt: new Date(Date.now() + 300000) } });
  pairs.push(formalPair.id);
  assert.equal((await call(scan, '/api/client/public-test-login', { ...scanInput, pairCode: formalPair.pairCode, testSecret: formalSecret.secret })).status, 403);
  const secondEnrollmentToken = randomBytes(32).toString('base64url');
  enrollmentKeys.push('public-test.account.' + String(BigInt('0x' + createHash('sha256').update(secondEnrollmentToken).digest('hex').slice(0, 12))));
  const b = await enrollPublicTest(secondEnrollmentToken, 'secondCamera');
  const secondCandidate = await prisma.candidate.findFirstOrThrow({ where: { examId, examNumber: b.examNumber } });
  ids.push(secondCandidate.id);
  const normalSecret = createPairSecret('RECOVERY');
  const normalQr = await prisma.pairingSession.create({ data: { pairCode: String(randomInt(100000, 1000000)), desktopDeviceId: pair.desktopDeviceId, purpose: 'INITIAL', recoveryTokenHash: normalSecret.hash, pollTokenHash: pollSecret.hash, screenOk: true, desktopCameraOk: true, expiresAt: new Date(Date.now() + 300000) } });
  pairs.push(normalQr.id);
  const normalLogin = await call(scan, '/api/client/public-test-login', { ...scanInput, examCode: b.examCode, name: b.name, examNumber: b.examNumber, password: b.password, pairCode: normalQr.pairCode, testSecret: normalSecret.secret });
  assert.equal(normalLogin.status, 201);
  const normalPoll = await call(poll, `/api/client/pair?pairCode=${normalQr.pairCode}&deviceId=${normalQr.desktopDeviceId}`, undefined, '', { 'x-proctor-pair-poll-token': pollSecret.secret });
  assert.equal(normalPoll.body.data.loginRequest, null); assert.equal(normalPoll.body.data.testLogin.requirements.isPublicTest, true); assert.ok(normalPoll.body.data.desktopSessionToken);
  assert.equal(await prisma.loginRequest.count({ where: { candidateId: secondCandidate.id } }), 0);
  const manualEnrollmentToken = randomBytes(32).toString('base64url');
  enrollmentKeys.push('public-test.account.' + String(BigInt('0x' + createHash('sha256').update(manualEnrollmentToken).digest('hex').slice(0, 12))));
  const c = await enrollPublicTest(manualEnrollmentToken, 'secondCamera');
  const manualCandidate = await prisma.candidate.findFirstOrThrow({ where: { examId, examNumber: c.examNumber } });
  ids.push(manualCandidate.id);
  const manualQr = await prisma.pairingSession.create({ data: { pairCode: String(randomInt(100000, 1000000)), desktopDeviceId: pair.desktopDeviceId, purpose: 'INITIAL', pollTokenHash: pollSecret.hash, screenOk: true, desktopCameraOk: true, expiresAt: new Date(Date.now() + 300000) } });
  pairs.push(manualQr.id);
  const manualInput = { examCode: c.examCode, name: c.name, examNumber: c.examNumber, password: c.password, pairCode: manualQr.pairCode, deviceId: phoneDevice };
  assert.equal((await scan(new Request('http://localhost:4031/api/client/public-test-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manualInput) }))).status, 400);
  const invalidPhoto = new FormData();
  for (const [key, value] of Object.entries(manualInput)) invalidPhoto.set(key, value);
  invalidPhoto.set('identityPhoto', new Blob(['invalid photo'], { type: 'image/jpeg' }), 'photo.jpg');
  invalidPhoto.set('roomVideo', new Blob([new Uint8Array(videoBytes)], { type: 'video/webm' }), 'room.webm');
  assert.equal((await scan(new Request('http://localhost:4031/api/client/public-test-login', { method: 'POST', body: invalidPhoto }))).status, 400);
  const manualLogin = await call(scan, '/api/client/public-test-login', manualInput);
  assert.equal(manualLogin.status, 201);
  assert.equal(await prisma.loginRequest.count({ where: { candidateId: manualCandidate.id } }), 0);
  assert.equal((await call(scan, '/api/client/public-test-login', manualInput)).status, 410);
  const notConnected = await call(start, '/api/client/session/start', { sessionId, confirm: true }, desktopToken);
  assert.equal(notConnected.status, 409); assert.match(notConnected.body.message, /全部通过推流检测/);
  const hb = await call(heartbeat, '/api/client/heartbeat', { sessionId, deviceId: pair.desktopDeviceId, side: 'DESKTOP', capture: { screenOk: false, desktopCameraOk: false },
    system: { processes: ['test-forbidden'], peripheralsFingerprint: 'changed' } }, desktopToken);
  assert.equal(hb.status, 200); assert.equal(hb.body.data.session.lockdown, false); assert.equal(hb.body.data.alertsCreated, 0);
  assert.equal((await call(alerts, '/api/client/alerts', { sessionId, type: 'SCREEN_CAPTURE_LOST', severity: 4, message: 'test' }, desktopToken)).status, 200);
  assert.equal((await call(upload, '/api/client/upload', {}, desktopToken)).status, 403);
  await assert.rejects(authorizeAuxiliaryUpload(new Request('http://localhost', { headers: { 'x-proctor-session-token': desktopToken } })), /环境测试不保存/);
  const detached = await call(disconnect, '/api/client/test-disconnect', { sessionId, deviceId: pair.desktopDeviceId, side: 'DESKTOP' }, desktopToken);
  assert.equal(detached.status, 200);
  const grant = detached.body.data;
  pairs.push((await prisma.pairingSession.findUniqueOrThrow({ where: { pairCode: grant.pairCode } })).id);
  const beforeScan = await call(poll, `/api/client/pair?pairCode=${grant.pairCode}&deviceId=${pair.desktopDeviceId}`, undefined, '', { 'x-proctor-pair-poll-token': grant.pollToken });
  assert.equal(beforeScan.body.data.testLogin, null); assert.equal(beforeScan.body.data.loginRequest, null); assert.equal(beforeScan.body.data.desktopSessionToken, null);
  assert.equal((await call(disconnect, '/api/client/test-disconnect', { sessionId, deviceId: pair.desktopDeviceId, side: 'DESKTOP' }, desktopToken)).status, 401);
  const restored = await call(reconnect, '/api/client/reconnect', { pairCode: grant.pairCode, recoverySecret: grant.recoverySecret, deviceId: phoneDevice });
  assert.equal(restored.status, 200); assert.equal(restored.body.data.requirements.isPublicTest, true);
  assert.equal((await call(reconnect, '/api/client/reconnect', { pairCode: grant.pairCode, recoverySecret: grant.recoverySecret, deviceId: 'attacker' })).status, 403);
  const afterScan = await call(poll, `/api/client/pair?pairCode=${grant.pairCode}&deviceId=${pair.desktopDeviceId}`, undefined, '', { 'x-proctor-pair-poll-token': grant.pollToken });
  assert.ok(afterScan.body.data.desktopSessionToken); assert.notEqual(afterScan.body.data.desktopSessionToken, desktopToken);
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: sessionId } })).desktopTokenHash, hashClientSessionToken(afterScan.body.data.desktopSessionToken));
  const mobileToken = restored.body.data.miniProgramSessionToken;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ ready: true, bytesReceived: 0 });
    const noMedia = await call(start, '/api/client/session/start', { sessionId, confirm: true }, afterScan.body.data.desktopSessionToken);
    assert.equal(noMedia.status, 409); assert.match(noMedia.body.message, /全部通过推流检测/);
    globalThis.fetch = async () => Response.json({ ready: true, bytesReceived: 128 });
    assert.equal((await call(start, '/api/client/session/start', { sessionId, confirm: true }, afterScan.body.data.desktopSessionToken)).status, 200);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal((await call(disconnect, '/api/client/test-disconnect', { sessionId, deviceId: phoneDevice, side: 'MINIPROGRAM' }, mobileToken)).status, 200);
  assert.equal((await call(heartbeat, '/api/client/heartbeat', { sessionId, deviceId: phoneDevice, side: 'MINIPROGRAM' }, mobileToken)).status, 401);
  assert.equal(await prisma.materialUploadGrant.count({ where: { candidateId: { in: ids } } }), 0);
  assert.equal(await prisma.mediaSegment.count({ where: { examId } }), 0);
  assert.equal(await prisma.alert.count({ where: { examId } }), 0);
  assert.equal(await prisma.oJLoginTicket.count({ where: { examId } }), 0);
  await prisma.candidate.update({ where: { id: candidate.id }, data: { status: 'FINISHED', updatedAt: new Date(Date.now() - 120000) } });
  await cleanupPublicTestState();
  assert.equal(await prisma.pairingSession.findUnique({ where: { id: pair.id } }), null);
  assert.equal(await prisma.clientSession.findUnique({ where: { id: sessionId } }), null);
  console.log('PASS: permanent hidden test using shared QR/manual pairing, no login requests, one-use concurrent claim/poll, credential and scope rejection, real stream gate, desktop/mobile reconnect, real temporary photo/video validation without storage or grants, no media/events, full temporary state cleanup.');
} finally {
  await prisma.pairingSession.deleteMany({ where: { id: { in: pairs } } });
  await prisma.candidate.deleteMany({ where: { id: { in: ids } } });
  await prisma.systemSetting.deleteMany({ where: { key: { in: enrollmentKeys } } });
  await prisma.$disconnect();
}
