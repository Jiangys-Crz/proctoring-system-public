import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/proctor_[a-z_]*qa$/);
const base = new URL(process.env.MONITOR_NOTIFICATIONS_QA_BASE || 'http://127.0.0.1:43319');
assert.equal(base.hostname, '127.0.0.1');
const marker = `monitor-notices-${randomUUID()}`;
let examId = '', userId = '';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const owner = await prisma.user.create({ data: { username: marker, role: 'ADMIN' } }); userId = owner.id;
  const now = Date.now();
  const exam = await prisma.exam.create({ data: {
    name: '异常提醒回归测试', createdById: userId, examCode: String(randomInt(1_000_000_000, 10_000_000_000)),
    startAt: new Date(now - 600_000), latestStartAt: new Date(now), endAt: new Date(now + 3_600_000), durationMinutes: 60,
    platform: 'HYDRO', platformBaseUrl: 'https://judge.invalid', platformContestId: marker,
    contestType: 'INDIVIDUAL', contestRule: 'XCPC', rules: '', requireMiniProgram: false, requireFrontCamera: false,
  } }); examId = exam.id;
  const candidate = await prisma.candidate.create({ data: { examId, examNumber: '001', seatNo: '001', name: '提醒测试考生', password: marker,
    abnormal: true, status: 'ONLINE_ABNORMAL', startedAt: new Date(now - 500_000) } });
  const session = await prisma.clientSession.create({ data: { examId, candidateId: candidate.id, status: 'IN_EXAM',
    startedAt: new Date(now - 500_000), lastDesktopSeenAt: new Date(now + 600_000) } });
  const other = await prisma.candidate.create({ data: { examId, examNumber: '002', seatNo: '002', name: '另一个考生', password: marker,
    status: 'ONLINE_NORMAL', startedAt: new Date(now - 500_000) } });
  await prisma.clientSession.create({ data: { examId, candidateId: other.id, status: 'IN_EXAM',
    startedAt: new Date(now - 500_000), lastDesktopSeenAt: new Date(now + 600_000) } });
  const duplicates = Array.from({ length: 4 }, (_, index) => ({ id: `${marker}-${index}`, examId, candidateId: candidate.id, sessionId: session.id,
    type: 'PROCESS_POLICY' as const, message: '检测到禁止的进程', severity: 3, createdAt: new Date(now - 240_000 + index * 10_000) }));
  await prisma.alert.createMany({ data: [...duplicates,
    { ...duplicates[0], id: `${marker}-severe`, severity: 5, createdAt: new Date(now - 200_000) },
    ...Array.from({ length: 90 }, (_, index) => ({ ...duplicates[0], id: `${marker}-handled-${index}`, acknowledgedAt: new Date(now), createdAt: new Date(now - index * 1000) }))] });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  context.setDefaultTimeout(20_000);
  await context.addInitScript({ content: `
    const voiceTestState = { stops: 0, delay: false, release: null, sends: [], ends: [], current: null };
    window.__voiceTest = voiceTestState;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin === location.origin && url.pathname === '/api/voice/calls' && method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.action === 'START') {
          voiceTestState.sends.push({ sessionId: body.sessionId, target: body.target });
          voiceTestState.current = { id: 'qa-call-' + voiceTestState.sends.length, sessionId: body.sessionId, target: 'DESKTOP', status: 'RINGING', callerName: '监考老师' };
        }
        if (body.action === 'END') {
          voiceTestState.ends.push(body);
          if (voiceTestState.current) voiceTestState.current = { ...voiceTestState.current, status: 'ENDED', endReason: body.reason };
        }
        return new Response(JSON.stringify({ ok: true, data: { call: voiceTestState.current } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(input, init);
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      if (voiceTestState.delay) await new Promise(resolve => { voiceTestState.release = resolve; });
      const track = { id: 'qa-microphone', kind: 'audio', enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; voiceTestState.stops++; } };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } });
  ` });
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(owner), url: base.origin }]);
  // Defense in depth: fake audio must never reach storage if a future client
  // stops using fetch. This context route survives page.unrouteAll below.
  await context.route(url => url.origin === base.origin && url.pathname === '/api/voice', route =>
    route.request().method() === 'POST' ? route.abort('blockedbyclient') : route.continue());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/media/whep**', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/media/hls/**', route => route.fulfill({ status: 404, body: '' }));
  let voiceReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/voice') voiceReads++; });
  await page.goto(new URL(`/dashboard/exams/${examId}/monitor`, base).href);
  await page.getByTitle('异常提醒', { exact: true }).click();
  const panel = page.locator('.monitor-alert-panel');
  await panel.getByText('相同异常 4 次', { exact: true }).waitFor();
  assert.equal(await panel.locator('article').count(), 2, 'severity escalation stays separate from the collapsed burst');
  assert.equal(await page.locator('.monitor-alert-button b').textContent(), '2');
  await panel.getByRole('button', { name: '展开其余 3 条', exact: true }).click();
  assert.equal(await panel.locator('article').count(), 5, 'all original records remain inspectable');
  await panel.getByRole('button', { name: '收起重复记录', exact: true }).click();
  await page.screenshot({ path: '/tmp/proctor-monitor-notifications-qa.png', fullPage: true });

  // A new alert arriving during a group acknowledgement is not part of the
  // reviewed snapshot and must remain pending.
  let injected = false;
  await page.route('**/api/alerts/*/ack', async route => {
    if (!injected) {
      injected = true;
      await prisma.alert.create({ data: { ...duplicates[0], id: `${marker}-new-during-ack`, createdAt: new Date(now - 195_000) } });
    }
    await route.continue();
  });
  await panel.getByRole('button', { name: '本组全部标记已处理', exact: true }).click();
  await panel.getByRole('button', { name: '本组全部标记已处理', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.monitor-alert-button b')?.textContent === '2');
  assert.equal((await prisma.alert.count({ where: { candidateId: candidate.id, acknowledgedAt: null } })), 2);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).abnormal, true, 'the separate severe alert still requires handling');
  await panel.getByRole('button', { name: '标记已处理', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('.monitor-alert-button b')?.textContent === '1');
  await panel.getByRole('button', { name: '标记已处理', exact: true }).click();
  await panel.getByText('暂无待处理异常提醒', { exact: true }).waitFor();
  await page.locator('.candidate-feed').getByText('状态：考试中', { exact: true }).waitFor();
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).abnormal, false);
  assert.equal(await page.locator('.monitor-alert-button b').count(), 0);
  await panel.getByRole('button', { name: '全部', exact: true }).click();
  assert.ok(await panel.locator('.handled').count() > 0, 'acknowledgement does not remove evidence/history');

  await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'LOCKED', lockdown: true,
    lockdownReason: 'USB 外设检测不可用或结果已过期，请恢复检测后联系监考员解锁' } });
  await prisma.candidate.update({ where: { id: candidate.id }, data: { status: 'ONLINE_ABNORMAL', abnormal: true } });
  await panel.getByTitle('关闭', { exact: true }).click();
  await page.getByRole('button', { name: 'USB异常处理', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('处理原因（必填）').fill('测试夹具：检测已恢复，现场核查完成');
  page.on('dialog', dialog => void dialog.accept());
  await dialog.getByRole('button', { name: '取消锁定', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('.candidate-feed').getByText('状态：考试中', { exact: true }).waitFor();
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } })).lockdown, false);

  // Delay actual state responses past the two-second polling interval. A
  // slow server must see one outstanding read, never a growing request queue.
  let activeReads = 0, maxReads = 0, reads = 0;
  await page.route(`**/api/exams/${examId}/state`, async route => {
    reads++; activeReads++; maxReads = Math.max(maxReads, activeReads);
    try {
      const response = await route.fetch();
      await new Promise(resolve => setTimeout(resolve, 4500));
      if (!page.isClosed()) await route.fulfill({ response });
    } finally { activeReads--; }
  });
  await page.waitForTimeout(10_000);
  assert.ok(reads >= 2); assert.equal(maxReads, 1);
  assert.equal(voiceReads, 0, 'closed voice panels do not poll for messages');
  assert.deepEqual(errors, []);
  await page.unrouteAll({ behavior: 'wait' });
  const voiceSends = () => page.evaluate(() => (window as any).__voiceTest.sends as Array<{ sessionId: string; target: string }>);
  await page.getByRole('button', { name: '语音通话', exact: true }).click();
  const voice = page.locator('.voice-panel');
  await voice.getByText('正在呼叫电脑客户端…', { exact: true }).waitFor();
  assert.equal(await voice.locator('select').count(), 0, 'call recipient remains fixed while the monitor selection changes');
  await page.getByTitle('下一页', { exact: true }).click();
  await page.locator('.candidate-feed > strong').getByText('另一个考生', { exact: true }).waitFor();
  assert.equal(await voice.locator('.call-recipient > strong').textContent(), '提醒测试考生');
  await voice.getByRole('button', { name: '挂断', exact: true }).click();
  await page.waitForFunction(() => (window as any).__voiceTest.sends.length === 1);
  assert.deepEqual(await voiceSends(), [{ sessionId: session.id, target: 'DESKTOP' }],
    'the call must target the original computer, even after switching the monitor card');
  await voice.getByTitle('关闭', { exact: true }).click();
  await page.getByTitle('上一页', { exact: true }).click();
  await page.getByRole('button', { name: '语音通话', exact: true }).click();
  await voice.getByText('正在呼叫电脑客户端…', { exact: true }).waitFor();
  await voice.getByTitle('挂断并关闭', { exact: true }).click();
  await page.waitForFunction(() => (window as any).__voiceTest.ends.length >= 2);
  assert.equal((await voiceSends()).length, 2, 'closing a ringing call cancels it');
  const stops = await page.evaluate(() => (window as any).__voiceTest.stops);
  await page.evaluate(() => { (window as any).__voiceTest.delay = true; });
  await page.getByRole('button', { name: '语音通话', exact: true }).click();
  await voice.getByTitle('挂断并关闭', { exact: true }).click();
  await page.evaluate(() => (window as any).__voiceTest.release());
  await page.waitForFunction(previous => (window as any).__voiceTest.stops > previous, stops);
  assert.equal((await voiceSends()).length, 2, 'late microphone permission after closing never dials');
  const beforeLeaving = await page.evaluate(() => { (window as any).__voiceTest.delay = false; return (window as any).__voiceTest.stops; });
  await page.getByRole('button', { name: '语音通话', exact: true }).click();
  await voice.getByText('正在呼叫电脑客户端…', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回详情', exact: true }).click();
  await page.waitForURL(`**/dashboard/exams/${examId}/status`);
  await page.waitForFunction(previous => (window as any).__voiceTest.stops > previous, beforeLeaving);
  assert.equal((await voiceSends()).length, 3, 'leaving the monitor closes its last call');
  assert.equal(voiceReads, 0, 'real-time calls never upload or poll old voice-message clips');
  console.log(JSON.stringify({ pendingRecords: 5, visibleGroups: 2, newAlertPreserved: injected, recoveredStatus: 'ONLINE_NORMAL', slowPollMaxInFlight: maxReads, voiceRecipientFixed: true, defaultVoiceTarget: 'DESKTOP', voiceClipsUploaded: 0 }));
} finally {
  await browser?.close();
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
}
