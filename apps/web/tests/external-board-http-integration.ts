// Use a production fixture server and an isolated MySQL database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';

if (!process.env.DATABASE_URL?.includes('/proctor_external_board_qa')) throw new Error('Use the external-board fixture database.');
const base = process.env.EXTERNAL_BOARD_QA_BASE || 'http://localhost:4148';
const calls: Array<{ key: string; kind: string; records: any[]; at: number }> = [];
let forbidden = false;
const mock = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/proctor/languages') { response.end(JSON.stringify({ ok: true, data: [{ id: 'cc.cc17o2', name: 'C++17' }] })); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const kind = request.url?.endsWith('/problems') ? 'problems' : 'submissions';
  assert.match(request.url || '', /^\/api\/external\/board\/123\/(problems|submissions)$/);
  assert.ok(['fixture-fallback-key', 'fixture-custom-key'].includes(body.api_key));
  calls.push({ key: body.api_key, kind, records: body[kind], at: Date.now() });
  if (forbidden) { response.end(JSON.stringify({ code: 403, msg: 'fixture-custom-key must never appear in a log' })); return; }
  response.end(JSON.stringify({ code: 200, data: kind === 'problems' ? `成功更新了 ${body.problems.length} 个题目信息` : `成功处理并保存了 ${body.submissions.length} 条提交记录` }));
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address(); assert.ok(address && typeof address === 'object');
const marker = randomUUID();
const users: string[] = [], exams: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const externalLogin = { apiBase: `http://127.0.0.1:${address.port}/api`, appKey: 'fixture-fallback-key' };
  await prisma.systemSetting.upsert({ where: { key: 'externalLogin' }, create: { key: 'externalLogin', value: externalLogin }, update: { value: externalLogin } });
  const hydro = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-hydro-key', problemDomainId: 'Problems' };
  await prisma.systemSetting.upsert({ where: { key: 'hydro' }, create: { key: 'hydro', value: hydro }, update: { value: hydro } });
  const admin = await prisma.user.create({ data: { username: `board-admin-${marker}`, role: 'SUPER_ADMIN' } }); users.push(admin.id);
  const proctor = await prisma.user.create({ data: { username: `board-proctor-${marker}`, role: 'ADMIN' } }); users.push(proctor.id);
  const startAt = new Date(Date.now() - 3600_000);
  const exam = await prisma.exam.create({ data: {
    examCode: '2099010102', name: '外榜页面测试', startAt, latestStartAt: startAt, endAt: new Date(+startAt + 7200_000), durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: hydro.baseUrl, platformContestId: 'local', contestType: 'INDIVIDUAL', contestRule: 'IOI', rules: '',
    externalBoardApiKey: 'fixture-custom-key',
    problems: { create: { order: 0, hydroProblemId: '1', title: 'QA A', content: '', score: 100 } },
    rooms: { create: { name: 'QA room', proctors: { create: { userId: proctor.id } } } },
  }, include: { problems: true } }); exams.push(exam.id);
  const candidate = await prisma.candidate.create({ data: { examId: exam.id, examNumber: '0000123', password: 'fixture-password', seatNo: '1' } });
  await prisma.contestSubmission.create({ data: { examId: exam.id, candidateId: candidate.id, problemId: exam.problems[0].id, status: 1, score: 100, judgeAt: new Date(), code: '// Fixture', lang: 'cc.cc17o2', createdAt: new Date(+startAt + 60_000), updatedAt: new Date(Date.now() - 60_000) } });
  const adminHeaders = { cookie: `cwnupaa_proctor_session=${createSessionToken(admin)}` };
  const proctorHeaders = { cookie: `cwnupaa_proctor_session=${createSessionToken(proctor)}` };
  for (const path of [`/api/exams/${exam.id}`, `/api/exams/${exam.id}/state`, '/api/exams', '/api/client/exams']) {
    const response = await fetch(base + path, { headers: proctorHeaders });
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('fixture-custom-key'), `key leaked at ${path}`);
  }
  const unauthorized = await fetch(base + `/api/exams/${exam.id}/external-board`, { headers: proctorHeaders });
  assert.equal(unauthorized.status, 403);
  const credentials = await fetch(base + `/api/exams/${exam.id}/external-board`, { headers: adminHeaders });
  assert.equal((await credentials.json()).data.appKey, 'fixture-custom-key');
  assert.match(credentials.headers.get('cache-control') || '', /no-store/);
  const patch = (data: unknown) => fetch(base + `/api/exams/${exam.id}/external-board`, { method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const ordinaryPatch = (data: unknown) => fetch(base + `/api/exams/${exam.id}`, { method: 'PATCH', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await patch({ externalBoardEnabled: true })).status, 400, 'event ID is required even with the default domain');
  assert.equal((await patch({ externalBoardBaseUrl: 'https://a:b@example.com', externalBoardEventId: '123' })).status, 400);
  assert.equal((await patch({ name: 'must not change' })).status, 400, 'dedicated endpoint only accepts external configuration');
  for (const value of [0, 1.5, 86401]) assert.equal((await patch({ externalBoardIntervalSeconds: value })).status, 400);
  assert.equal((await ordinaryPatch({ externalBoardEnabled: true, externalBoardEventId: '123' })).status, 400, 'ordinary editor cannot control the live switch');
  assert.equal((await fetch(base + `/api/exams/${exam.id}/external-board`, { method: 'PATCH', headers: { ...proctorHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ externalBoardEnabled: true, externalBoardEventId: '123' }) })).status, 403);

  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(15_000);
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(admin), url: base }]);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + `/dashboard/exams/${exam.id}/settings/problems`);
  await page.getByRole('button', { name: '外榜推送', exact: true }).click();
  await page.waitForURL(`**/dashboard/exams/${exam.id}/settings/external-board`);
  const key = page.getByPlaceholder('留空使用 CWNUPAA 外部登录密钥');
  await key.waitFor();
  await waitFor(async () => await key.inputValue() === 'fixture-custom-key', 'saved key loads');
  const toggle = page.getByRole('switch', { name: '外榜推送开关' });
  // Missing event ID cannot turn the saved switch on.
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await toggle.evaluate(element => element.tagName), 'BUTTON', 'the switch is a styled toggle, not a checkbox');
  const domain = page.getByLabel('CWNUPAA 官网域名', { exact: true });
  const eventId = page.getByLabel('CWNUPAA 官网赛事 ID', { exact: true });
  const interval = page.getByLabel('推送间隔（秒）');
  assert.equal(await interval.inputValue(), '10');
  assert.equal(await domain.inputValue(), 'https://www.example.org/api');
  await domain.fill(`http://127.0.0.1:${address.port}`);
  await eventId.fill('123');
  await key.fill('');
  await interval.fill('2');
  // Status refresh preserves the user's configuration draft.
  await page.waitForResponse(response => response.url().endsWith(`/api/exams/${exam.id}/external-board`) && response.request().method() === 'GET');
  assert.equal(await domain.inputValue(), `http://127.0.0.1:${address.port}`);
  assert.equal(await key.inputValue(), '');
  const live = (action: () => Promise<unknown>) => {
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/exams/${exam.id}/external-board`) && response.request().method() === 'PATCH');
    return action().then(() => saved);
  };
  assert.equal((await live(() => toggle.click())).status(), 200);
  await waitFor(async () => await toggle.getAttribute('aria-checked') === 'true', 'switch reflects persisted enabled state');
  const updated = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
  assert.equal(updated.externalBoardEnabled, true); assert.equal(updated.externalBoardApiKey, null);
  assert.equal(updated.externalBoardIntervalSeconds, 2);
  assert.equal(updated.externalBoardBaseUrl, `http://127.0.0.1:${address.port}/api`);
  for (const field of ['name', 'rules', 'contestRule', 'durationMinutes', 'platformBaseUrl', 'requireFrontCamera'] as const) assert.equal(updated[field], exam[field], `live settings changed ${field}`);
  assert.equal(+updated.startAt, +exam.startAt); assert.equal(+updated.endAt, +exam.endAt);
  await waitFor(() => calls.some(call => call.kind === 'submissions' && call.key === 'fixture-fallback-key'), 'immediate push with fallback key');
  const firstSubmission = calls.find(call => call.kind === 'submissions')!;
  const previousCount = calls.length;
  await prisma.contestSubmission.updateMany({ where: { examId: exam.id }, data: { score: 60 } });
  await waitFor(() => calls.length > previousCount, 'configured interval causes another automatic push');
  assert.ok(calls[previousCount].at - firstSubmission.at >= 1800, 'the next automatic push waits for the configured interval');
  const logs = page.getByRole('region', { name: '推送日志' });
  await waitFor(async () => await logs.getByText('成功', { exact: true }).count() > 0, 'successful push appears in the log table');
  const concurrentSaves = await Promise.all(Array.from({ length: 6 }, (_, index) => patch({ externalBoardIntervalSeconds: 2 + index % 2 })));
  assert.ok(concurrentSaves.every(response => response.status === 200), 'concurrent configuration saves and the active worker must not deadlock');
  assert.equal((await patch({ externalBoardIntervalSeconds: 2 })).status, 200);
  await waitFor(async () => await interval.inputValue() === '2', 'configured interval remains in the UI');

  await key.fill('fixture-custom-key');
  assert.equal((await live(() => page.getByRole('button', { name: '保存外榜配置', exact: true }).click())).status(), 200);
  await waitFor(() => calls.some(call => call.kind === 'submissions' && call.key === 'fixture-custom-key'), 'custom key overrides fallback immediately');
  assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'config-only save does not change the switch');
  await interval.fill('3');
  assert.equal((await live(() => page.getByRole('button', { name: '保存外榜配置', exact: true }).click())).status(), 200);
  assert.equal((await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } })).externalBoardIntervalSeconds, 3);
  assert.equal((await ordinaryPatch({ rules: 'ordinary editor update' })).status, 200);
  const afterOrdinary = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
  assert.equal(afterOrdinary.externalBoardEnabled, true); assert.equal(afterOrdinary.externalBoardApiKey, 'fixture-custom-key');
  assert.equal(afterOrdinary.externalBoardEventId, '123');
  assert.equal(afterOrdinary.externalBoardIntervalSeconds, 3);
  forbidden = true;
  await prisma.contestSubmission.updateMany({ where: { examId: exam.id }, data: { score: 0 } });
  await waitFor(async () => {
    const response = await fetch(base + `/api/exams/${exam.id}/external-board`, { headers: adminHeaders });
    return (await response.json()).data.logs.some((log: { status: string }) => log.status === 'ERROR');
  }, 'receiver rejection is logged');
  await waitFor(async () => await logs.getByText('失败', { exact: true }).count() > 0, 'failure appears below the configuration');
  const logResponse = await fetch(base + `/api/exams/${exam.id}/external-board`, { headers: adminHeaders });
  const logged = (await logResponse.json()).data.logs;
  assert.ok(!JSON.stringify(logged).includes('fixture-custom-key'), 'remote credential echoes are never stored in logs');
  await page.screenshot({ path: '/tmp/proctor-external-board-switch.png', fullPage: true });
  // Closing always works, even with an invalid unfinished configuration draft.
  await domain.fill('https://a:b@example.com'); await eventId.fill('');
  assert.equal((await live(() => toggle.click())).status(), 200);
  await waitFor(async () => await toggle.getAttribute('aria-checked') === 'false', 'switch reflects persisted disabled state');
  const stopped = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
  assert.equal(stopped.externalBoardBaseUrl, `http://127.0.0.1:${address.port}/api`);
  assert.equal(stopped.externalBoardEventId, '123'); assert.equal(stopped.externalBoardApiKey, 'fixture-custom-key');
  const stoppedCalls = calls.length;
  await prisma.contestSubmission.updateMany({ where: { examId: exam.id }, data: { score: 0, status: 2 } });
  await new Promise(resolve => setTimeout(resolve, 11_000));
  assert.equal(calls.length, stoppedCalls, 'the worker does not POST after immediate disable');
  await page.reload();
  await waitFor(async () => await key.inputValue() === 'fixture-custom-key', 'saved config remains after reload');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await eventId.inputValue(), '123');
  assert.equal(await interval.inputValue(), '3');
  assert.ok(await logs.getByText('已关闭推送，停止后续同步').count() > 0, 'operation logs survive reload');
  await page.screenshot({ path: '/tmp/proctor-external-board-live.png', fullPage: true });
  assert.equal(((await prisma.systemSetting.findUniqueOrThrow({ where: { key: 'externalLogin' } })).value as any).appKey, 'fixture-fallback-key');
  assert.deepEqual(errors, []);
  console.log('PASS: dedicated management entry, immediate switch, required event ID, optional key/fallback, independent config save, draft-safe polling and stop, immediate HTTP pushes, ordinary edit isolation, disabled timer, proctor access denied and no credential leaks.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page && !page.isClosed()) {
    console.log('QA page:', page.url(), (await page.locator('body').innerText().catch(() => '')).slice(0, 3000));
    await page.screenshot({ path: '/tmp/proctor-external-board-settings-failure.png', fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.systemSetting.deleteMany({ where: { key: { in: ['externalLogin', 'hydro'] } } });
  mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));
  await prisma.$disconnect();
}
