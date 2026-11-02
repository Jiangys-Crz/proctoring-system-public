// Use a disposable local database and production web server; fixtures are removed in finally.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { createClientSessionToken } from '../src/lib/client-auth';
import { createPairSecret } from '../src/lib/pairing-security';

if (!process.env.DATABASE_URL?.includes('/proctor_late_start_qa')) throw new Error('Use the isolated late-start fixture database.');
const base = process.env.LATE_START_QA_BASE || 'http://localhost:4148';
const marker = `late-start-${randomUUID()}`;
const examIds: string[] = [], userIds: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const mock = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(request.url?.includes('login-ticket') ? { ok: true, loginUrl: 'http://localhost/qa-login' }
    : { ok: true, data: [{ id: 'cc.cc17o2', name: 'C++17' }] }));
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address(); assert.ok(address && typeof address === 'object');

async function api(path: string, expected: number, body?: object, auth?: { cookie?: string; token?: string }) {
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(auth?.cookie ? { cookie: auth.cookie } : {}), ...(auth?.token ? { authorization: `Bearer ${auth.token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`); return result.data;
}

try {
  const hydro = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'late-start-fixture-key', problemDomainId: 'Problems' };
  await prisma.systemSetting.upsert({ where: { key: 'hydro' }, create: { key: 'hydro', value: hydro }, update: { value: hydro } });
  const proctor = await prisma.user.create({ data: { username: `${marker}-proctor`, role: 'ADMIN', realName: '迟到测试监考' } }); userIds.push(proctor.id);
  const outsider = await prisma.user.create({ data: { username: `${marker}-outsider`, role: 'ADMIN' } }); userIds.push(outsider.id);
  const auth = { cookie: `cwnupaa_proctor_session=${createSessionToken(proctor)}` };
  const foreignAuth = { cookie: `cwnupaa_proctor_session=${createSessionToken(outsider)}` };
  const now = Date.now();
  async function createExam(flexible = false) {
    const exam = await prisma.exam.create({ data: {
      examCode: String(randomInt(1000000000, 10000000000)), name: marker, startAt: new Date(now - 3600_000),
      latestStartAt: new Date(now - 900_000), endAt: new Date(now + (flexible ? 600_000 : 3600_000)), durationMinutes: flexible ? 30 : 120,
      flexible, published: true, platform: 'HYDRO', platformBaseUrl: hydro.baseUrl, platformContestId: 'local', contestType: 'INDIVIDUAL', contestRule: 'IOI', rules: '',
      problems: { create: { order: 0, hydroProblemId: '1', title: 'Late start QA', content: 'QA', score: 100 } },
    } }); examIds.push(exam.id); return exam;
  }
  const exam = await createExam();
  const late = await prisma.candidate.create({ data: { examId: exam.id, name: '李迟到', studentId: 'qa-1', examNumber: 'qa-1', password: marker, seatNo: '01' } });
  const other = await prisma.candidate.create({ data: { examId: exam.id, name: '未授权', studentId: 'qa-2', examNumber: 'qa-2', password: marker, seatNo: '02' } });
  const room = await prisma.examRoom.create({ data: { examId: exam.id, name: '迟到测试考室', loginMode: 'CREDENTIALS', loginReviewMode: 'AUTO', requireSecondCamera: false, requireFrontCamera: false,
    proctors: { create: { userId: proctor.id } }, candidates: { create: [{ candidateId: late.id }, { candidateId: other.id }] } } });
  const pairing = async () => prisma.pairingSession.create({ data: { pairCode: String(randomInt(100000, 1000000)), purpose: 'INITIAL',
    pollTokenHash: createPairSecret('POLL').hash, desktopDeviceId: `${marker}-${randomUUID()}`, screenOk: true, expiresAt: new Date(Date.now() + 300_000) } });
  let pair = await pairing();
  const credentials = { examCode: exam.examCode, name: late.name, examNumber: late.examNumber, password: marker, pairCode: pair.pairCode };
  await api('/api/client/credential-login', 403, credentials);
  await api(`/api/candidates/${late.id}/resume`, 401, {});
  await api(`/api/candidates/${late.id}/resume`, 403, {}, foreignAuth);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: late.id } })).lateStartAllowedAt, null);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(15_000);
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(proctor), url: base }]);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`${base}/dashboard/exams/${exam.id}/monitor`);
  const card = page.locator('.monitor-card').filter({ hasText: '李迟到' });
  const resume = card.getByRole('button', { name: '继续考试', exact: true });
  await resume.waitFor(); assert.equal(await resume.isEnabled(), true, 'no-session late candidates have a usable monitor action');
  const [grant] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/candidates/${late.id}/resume`) && response.request().method() === 'POST'), resume.click()
  ]);
  assert.equal(grant.status(), 200);
  await card.getByText('已允许继续考试，可登录并确认开始', { exact: true }).waitFor();
  await page.reload(); await card.getByText('已允许继续考试，可登录并确认开始', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: late.id } })).startedAt, null, 'permission does not start the clock');
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: other.id } })).lateStartAllowedAt, null);
  await browser.close(); browser = undefined;

  // QR identity validation and material-ticket issuance use the same individual permission.
  await prisma.examRoom.update({ where: { id: room.id }, data: { loginMode: 'SECOND_CAMERA_QR', requireSecondCamera: true } });
  await api('/api/client/candidate-verify', 200, credentials);
  await api('/api/client/candidate-verify', 403, { ...credentials, name: other.name, examNumber: other.examNumber });
  await api('/api/client/material-upload-ticket', 200, { ...credentials, miniProgramDeviceId: `${marker}-phone` });
  await prisma.examRoom.update({ where: { id: room.id }, data: { loginMode: 'CREDENTIALS', requireSecondCamera: false } });
  await api('/api/client/credential-login', 401, { ...credentials, password: 'incorrect' });
  const login = await api('/api/client/credential-login', 201, credentials);
  const token = createClientSessionToken();
  await prisma.clientSession.update({ where: { id: login.sessionId }, data: { desktopTokenHash: token.tokenHash, lastDesktopSeenAt: new Date() } });
  const clientAuth = { token: token.token };
  const contest = await api(`/api/client/contest?sessionId=${login.sessionId}`, 200, undefined, clientAuth);
  assert.equal(contest.session.status, 'APPROVED'); assert.equal(+new Date(contest.contest.latestStartAt), +exam.endAt);
  const starts = await Promise.all([0, 1].map(() => api('/api/client/session/start', 200, { sessionId: login.sessionId, confirm: true }, clientAuth)));
  assert.equal(starts[0].startedAt, starts[1].startedAt); assert.equal(+new Date(starts[0].effectiveEndAt), +exam.endAt);
  const firstStart = starts[0].startedAt;

  await api(`/api/sessions/${login.sessionId}/force-finish`, 200, {}, auth);
  await api(`/api/sessions/${login.sessionId}/resume`, 200, {}, auth);
  await api('/api/client/session/start', 409, { sessionId: login.sessionId, confirm: true }, clientAuth);
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: login.sessionId } })).status, 'FINISHED');
  pair = await pairing();
  const relogin = await api('/api/client/credential-login', 201, { ...credentials, pairCode: pair.pairCode });
  const relogged = await prisma.clientSession.findUniqueOrThrow({ where: { id: relogin.sessionId } });
  assert.equal(relogged.status, 'IN_EXAM'); assert.equal(relogged.startedAt?.toISOString(), firstStart);

  // An already approved, connected candidate can start without losing the current session.
  const liveToken = createClientSessionToken();
  const live = await prisma.clientSession.create({ data: { examId: exam.id, candidateId: other.id, status: 'APPROVED', approvedAt: new Date(),
    desktopTokenHash: liveToken.tokenHash, desktopDeviceId: `${marker}-live`, lastDesktopSeenAt: new Date() } });
  await prisma.candidate.update({ where: { id: other.id }, data: { status: 'APPROVED' } });
  await api('/api/client/session/start', 400, { sessionId: live.id, confirm: true }, { token: liveToken.token });
  const permitted = await api(`/api/candidates/${other.id}/resume`, 200, {}, auth);
  assert.equal(permitted.requiresRelogin, false);
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: live.id } })).status, 'APPROVED');
  await api('/api/client/session/start', 200, { sessionId: live.id, confirm: true }, { token: liveToken.token });

  const flexible = await createExam(true);
  const fresh = await prisma.candidate.create({ data: { examId: flexible.id, name: '灵活迟到', examNumber: 'flex', password: marker, seatNo: '01' } });
  const expired = await prisma.candidate.create({ data: { examId: flexible.id, name: '个人超时', examNumber: 'expired', password: marker, seatNo: '02', startedAt: new Date(Date.now() - 1800_001), status: 'FINISHED' } });
  await prisma.examRoom.create({ data: { examId: flexible.id, name: '灵活测试', proctors: { create: { userId: proctor.id } }, candidates: { create: [{ candidateId: fresh.id }, { candidateId: expired.id }] } } });
  await api(`/api/candidates/${expired.id}/resume`, 400, {}, auth);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: expired.id } })).status, 'FINISHED');
  await api(`/api/candidates/${fresh.id}/resume`, 200, {}, auth);
  const flexToken = createClientSessionToken();
  const flexSession = await prisma.clientSession.create({ data: { examId: flexible.id, candidateId: fresh.id, status: 'APPROVED', approvedAt: new Date(), desktopDeviceId: `${marker}-flex`, desktopTokenHash: flexToken.tokenHash } });
  const flexStarted = await api('/api/client/session/start', 200, { sessionId: flexSession.id, confirm: true }, { token: flexToken.token });
  assert.equal(+new Date(flexStarted.effectiveEndAt), +flexible.endAt, 'late flexible starts remain capped by the original exam end');
  await prisma.exam.update({ where: { id: flexible.id }, data: { endAt: new Date(Date.now() - 1) } });
  await api(`/api/candidates/${fresh.id}/resume`, 400, {}, auth);
  await api('/api/client/session/start', 400, { sessionId: flexSession.id, confirm: true }, { token: flexToken.token });
  await prisma.exam.update({ where: { id: flexible.id }, data: { startAt: new Date(Date.now() + 60_000), endAt: new Date(Date.now() + 3600_000) } });
  await api(`/api/candidates/${fresh.id}/resume`, 400, {}, auth);
  const audit = await prisma.alert.findMany({ where: { candidateId: late.id, type: 'MANUAL_NOTE' } });
  assert.ok(audit.some(row => /迟到测试监考.*允许超过最晚开考时间/.test(row.message)));
  console.log('PASS: monitor permission for late candidates without sessions; isolated authorization; credentials/QR/material tickets; live approval retained; concurrent first-start clock; ended-session relogin; original deadlines and audit trail.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page && !page.isClosed()) console.log('QA page:', (await page.locator('body').innerText()).slice(-2000));
  throw error;
} finally {
  await browser?.close();
  await prisma.pairingSession.deleteMany({ where: { desktopDeviceId: { startsWith: marker } } });
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.systemSetting.deleteMany({ where: { key: 'hydro' } });
  mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));
  await prisma.$disconnect();
}
