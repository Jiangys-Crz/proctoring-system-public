// Run against a local production server and the disposable recording QA database.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';

if (!process.env.DATABASE_URL?.includes('/proctor_recording_qa')) throw new Error('Use the isolated recording fixture database.');
const base = process.env.RECORDING_QA_BASE || 'http://localhost:4148';
const mock = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ ok: true, data: [{ id: 'cc.cc17o2', name: 'C++17' }] }));
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address(); assert.ok(address && typeof address === 'object');
let examId = '', userId = '';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const hydro = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'recording-fixture-key', problemDomainId: 'Problems' };
  await prisma.systemSetting.upsert({ where: { key: 'hydro' }, create: { key: 'hydro', value: hydro }, update: { value: hydro } });
  const user = await prisma.user.create({ data: { username: `recording-ui-${randomUUID()}`, role: 'SUPER_ADMIN' } }); userId = user.id;
  const startAt = new Date(Date.now() - 300_000);
  const exam = await prisma.exam.create({ data: { examCode: String(randomInt(1000000000, 10000000000)), name: '录像保存页面测试', startAt, latestStartAt: startAt,
    endAt: new Date(+startAt + 7200_000), durationMinutes: 120, platform: 'HYDRO', platformBaseUrl: hydro.baseUrl,
    platformContestId: 'local', contestType: 'INDIVIDUAL', contestRule: 'IOI', rules: 'recording fixture',
    externalBoardEventId: '123', externalBoardIntervalSeconds: 45,
    problems: { create: { order: 0, hydroProblemId: '1', title: 'Recording QA', content: '', score: 100 } } } }); examId = exam.id;
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  context.setDefaultTimeout(15_000);
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(user), url: base }]);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const editUrl = `${base}/dashboard/exams/${examId}/settings`;
  await page.goto(editUrl);
  const full = page.getByRole('checkbox', { name: /保存完整考试录像/ });
  const incident = page.getByRole('checkbox', { name: /保存异常前后各 20 秒录像/ });
  await incident.waitFor();
  assert.equal(await full.isChecked(), false); assert.equal(await incident.isChecked(), false);
  const save = async () => {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/api/exams/${examId}`) && response.request().method() === 'PATCH'),
      page.getByRole('button', { name: '保存考试', exact: true }).click(),
    ]);
    assert.equal(response.status(), 200);
    await page.waitForURL('**/dashboard/exams');
    await page.goto(editUrl);
    await incident.waitFor();
  };
  await incident.check(); await save();
  let stored = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
  assert.equal(stored.saveIncidentRecording, true); assert.equal(stored.saveFullRecording, false);
  assert.equal(stored.externalBoardEventId, '123'); assert.equal(stored.externalBoardIntervalSeconds, 45);
  await page.reload(); await incident.waitFor();
  assert.equal(await incident.isChecked(), true); assert.equal(await full.isChecked(), false);
  await full.check(); await incident.uncheck(); await save();
  stored = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
  assert.equal(stored.saveFullRecording, true); assert.equal(stored.saveIncidentRecording, false);
  await full.uncheck(); await save();
  stored = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
  assert.equal(stored.saveFullRecording, false); assert.equal(stored.saveIncidentRecording, false);
  await page.goto(`${base}/dashboard/exams/new`);
  await incident.waitFor();
  assert.equal(await incident.isChecked(), false); assert.equal(await full.isChecked(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: create/edit recording checkboxes default off, independent choices save and survive reload, cancelling stops saving, external push configuration remains intact.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page && !page.isClosed()) {
    console.log('QA page:', (await page.locator('body').innerText()).slice(-2500));
    await page.screenshot({ path: '/tmp/proctor-recording-settings-failure.png', fullPage: true });
  }
  throw error;
} finally {
  await browser?.close();
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.systemSetting.deleteMany({ where: { key: 'hydro' } });
  mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));
  await prisma.$disconnect();
}
