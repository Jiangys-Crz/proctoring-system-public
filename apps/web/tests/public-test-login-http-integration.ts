// Run with the production Next server already listening on 4031. This catches
// native executable paths and student-page forwarding that break after bundling.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { prisma } from '../src/lib/db';
import { getDesktopReleases } from '../src/lib/desktop-releases';
import { enrollPublicTest as enrollVerifiedPublicTest, publicTestEnrollmentKey } from '../src/lib/public-test';

const enrollPublicTest = (token: string, mode: 'secondCamera') => enrollVerifiedPublicTest(String(BigInt('0x' + createHash('sha256').update(token).digest('hex').slice(0, 12))), mode);

const base = process.env.PROCTOR_PUBLIC_TEST_HTTP_BASE || 'http://localhost:4031';
const candidates: string[] = [], pairCodes: string[] = [], enrollmentKeys: string[] = [];
const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#7389ad' } }).jpeg().toBuffer();
const webm = await readFile(new URL('./fixtures/material-room.webm', import.meta.url));
const mp4 = await readFile(new URL('./fixtures/material-room.mp4', import.meta.url));
assert.ok(mp4.indexOf(Buffer.from('moov')) > mp4.indexOf(Buffer.from('mdat')), 'phone MP4 fixture requires random access');

async function account() {
  const token = randomBytes(32).toString('base64url');
  enrollmentKeys.push('public-test.account.' + String(BigInt('0x' + createHash('sha256').update(token).digest('hex').slice(0, 12))));
  const credentials = await enrollPublicTest(token, 'secondCamera');
  candidates.push((await prisma.candidate.findFirstOrThrow({ where: { examNumber: credentials.examNumber } })).id);
  return { examCode: credentials.examCode, name: credentials.name, examNumber: credentials.examNumber, password: credentials.password };
}
async function pair() {
  const version = (await getDesktopReleases('public')).find(item => item.target === 'mac-arm64')?.version;
  assert.ok(version, 'publish a client version before running the production HTTP integration');
  const deviceId = `http-login-${randomBytes(12).toString('hex')}`;
  const response = await fetch(`${base}/api/client/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, os: 'darwin 24.0.0', clientVersion: version, screenOk: true, desktopCameraOk: true }) });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  pairCodes.push(data.pairCode);
  return { ...data, deviceId };
}
async function login(identity: object, pairing: { pairCode: string }, video: Buffer, secret?: string) {
  const form = new FormData();
  Object.entries({ ...identity, pairCode: pairing.pairCode, deviceId: `http-phone-${randomBytes(12).toString('hex')}` }).forEach(([key, value]) => form.set(key, String(value)));
  if (secret) form.set('testSecret', secret);
  form.set('identityPhoto', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'photo.jpg');
  form.set('roomVideo', new Blob([new Uint8Array(video)], { type: video === mp4 ? 'video/mp4' : 'video/webm' }), video === mp4 ? 'room.mp4' : 'room.webm');
  const response = await fetch(`${base}/api/client/public-test-login`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}
try {
  const identity = await account(), qr = await pair();
  const rejected = await login(identity, qr, webm.subarray(0, 32), qr.qrLoginSecret);
  assert.equal(rejected.status, 400);
  assert.equal((await prisma.pairingSession.findUniqueOrThrow({ where: { pairCode: qr.pairCode } })).claimedAt, null);
  const accepted = await login(identity, qr, webm, qr.qrLoginSecret);
  assert.equal(accepted.status, 201, accepted.body.message);
  assert.equal((await login(identity, qr, webm, qr.qrLoginSecret)).status, 410, 'used QR must not become a misleading invalid-code error');
  const polled = await fetch(`${base}/api/client/pair?pairCode=${qr.pairCode}&deviceId=${qr.deviceId}`, { headers: { 'x-proctor-pair-poll-token': qr.pollToken } });
  const { data } = await polled.json();
  assert.equal(polled.status, 200); assert.ok(data.desktopSessionToken); assert.equal(data.loginRequest, null);
  assert.equal(data.testLogin.requirements.isPublicTest, true);
  const sessionId = data.testLogin.session.id;
  const desktopHeaders = { 'x-proctor-client': 'desktop', 'x-proctor-session-token': data.desktopSessionToken };
  const page = await fetch(`${base}/contest?sessionId=${sessionId}&apiBase=${encodeURIComponent(base)}`, { headers: desktopHeaders });
  assert.equal(page.status, 200, 'backend must forward the authorized contest document to the student service');
  const html = await page.text();
  assert.match(html, /比赛答题/);
  const resources = [...new Set([...html.matchAll(/(?:src|href)="([^"<>]+\.(?:js|css)(?:\?[^"<>]*)?)"/g)].map(match => match[1]))];
  assert.ok(resources.length > 0, 'contest document must include compiled student resources');
  for (const resource of resources) {
    assert.ok(resource.startsWith('/candidate-assets/_next/static/'), 'student resources must not collide with backend chunks');
    const response = await fetch(new URL(resource, base));
    assert.equal(response.status, 200, `student resource failed: ${resource}`);
  }
  const contest = await fetch(`${base}/api/client/contest?sessionId=${sessionId}`, { headers: desktopHeaders });
  assert.equal(contest.status, 200);
  const beforeStart = (await contest.json()).data;
  assert.ok(beforeStart.problems.length > 0);
  assert.ok(beforeStart.problems.every((problem: { content: string }) => problem.content === ''), 'login must not expose questions before the exam starts');
  // Advance only this disposable fixture to exercise the post-start answer page.
  const startedAt = new Date();
  await prisma.$transaction([
    prisma.candidate.update({ where: { id: candidates[0] }, data: { startedAt } }),
    prisma.clientSession.update({ where: { id: sessionId }, data: { startedAt, status: 'IN_EXAM' } }),
  ]);
  const startedContest = await fetch(`${base}/api/client/contest?sessionId=${sessionId}`, { headers: desktopHeaders });
  assert.equal(startedContest.status, 200);
  const content = (await startedContest.json()).data;
  assert.ok(content.problems.some((problem: { title: string }) => /A\s*\+\s*B/i.test(problem.title)), 'public test must expose its A+B problem');
  assert.equal((await fetch(`${base}/contest`)).status, 403, 'unauthorized browsers must still be blocked');
  assert.equal((await fetch(`${base}/candidate`)).status, 200, 'shared-domain QR login must reach the student page');
  assert.equal((await fetch(`${base}/candidate-assets/brand/logo.png`)).status, 200);

  const manualIdentity = await account(), manual = await pair();
  const mismatch = await login(manualIdentity, manual, mp4, randomBytes(32).toString('base64url'));
  assert.equal(mismatch.status, 403); assert.match(mismatch.body.message, /不匹配/);
  assert.equal((await login(manualIdentity, manual, mp4)).status, 201, 'manual pairing accepts real MP4 without an old scanned proof');

  const expired = await pair();
  await prisma.pairingSession.update({ where: { pairCode: expired.pairCode }, data: { expiresAt: new Date(0) } });
  const expiredResult = await login(manualIdentity, expired, webm, expired.qrLoginSecret);
  assert.equal(expiredResult.status, 410); assert.match(expiredResult.body.message, /过期/);
  const recovery = await pair();
  await prisma.pairingSession.update({ where: { pairCode: recovery.pairCode }, data: { purpose: 'RECOVERY' } });
  const recoveryResult = await login(manualIdentity, recovery, webm);
  assert.equal(recoveryResult.status, 403); assert.match(recoveryResult.body.message, /恢复连接/);
  assert.equal(await prisma.loginRequest.count({ where: { candidateId: { in: candidates } } }), 0);
  assert.equal(await prisma.materialUploadGrant.count({ where: { candidateId: { in: candidates } } }), 0);
  assert.equal(await prisma.mediaSegment.count({ where: { candidateId: { in: candidates } } }), 0);
  console.log('PASS: production QR/WebM and manual/MP4 login, material and pairing validation, authorized contest forwarding with all static resources and A+B, browser access gate, shared-domain phone login, no stored test materials or login requests.');
} finally {
  await prisma.pairingSession.deleteMany({ where: { pairCode: { in: pairCodes } } });
  await prisma.candidate.deleteMany({ where: { id: { in: candidates } } });
  await prisma.systemSetting.deleteMany({ where: { key: { in: enrollmentKeys } } });
  await prisma.$disconnect();
}
