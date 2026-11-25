// Headless UI + production worker. Use only the isolated external-board QA DB.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';

if (new URL(process.env.DATABASE_URL || 'http://invalid').pathname !== '/proctor_external_board_qa') throw new Error('Use the external-board fixture database.');
const base = process.env.EXTERNAL_BOARD_QA_BASE || 'http://localhost:4148';
const tid = '691000000000000000000001';
const startAt = new Date(Date.now() - 3600_000);
const row = { id: Math.floor((Date.now() - 60_000) / 1000).toString(16) + '0000000000000001', username: 'team01', problemId: '9',
  status: 1, score: 100, language: 'cpp', code: '// native fixture', runtime: 1, memory: 1024, createdAt: new Date(Date.now() - 60_000).toISOString() };
let reads = 0;
const received: any[] = [];
const mock = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader('content-type', 'application/json');
  if (req.url === `/d/xcpc/api/proctor/board-contest/${tid}`) {
    assert.equal(req.headers['x-proctor-api-key'], 'fixture-hydro-key'); reads++;
    res.end(JSON.stringify({ ok: true, data: { contestId: tid, rule: 'acm', problems: [{ id: '9', label: 'A', title: 'Native A',
      score: 100, hydroScore: 100, timeLimitMs: 1000, memoryLimitMb: 256 }], records: [row], nextAfter: null } })); return;
  }
  assert.match(req.url || '', /^\/api\/external\/board\/123\/(problems|submissions)$/);
  assert.equal(body.api_key, 'fixture-board-key');
  if (body.submissions) received.push(...body.submissions);
  res.end(JSON.stringify({ code: 200, data: body.submissions ? `成功处理并保存了 ${body.submissions.length} 条提交记录` : 'OK' }));
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address(); assert.ok(address && typeof address === 'object');
const source = `http://127.0.0.1:${address.port}`;
let examId = '', userId = '';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  for (let n = 0; n < 120; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  await prisma.systemSetting.upsert({ where: { key: 'hydro' }, create: { key: 'hydro', value: { baseUrl: source, apiKey: 'fixture-hydro-key' } },
    update: { value: { baseUrl: source, apiKey: 'fixture-hydro-key' } } });
  const admin = await prisma.user.create({ data: { username: `hydro-board-ui-${Date.now()}`, role: 'SUPER_ADMIN' } }); userId = admin.id;
  const exam = await prisma.exam.create({ data: { examCode: '2099010111', name: 'Hydro 网页比赛外榜测试', startAt, latestStartAt: startAt,
    endAt: new Date(Date.now() + 3600_000), durationMinutes: 120, platform: 'HYDRO_BROWSER', platformBaseUrl: `${source}/d/xcpc`,
    platformContestId: tid, contestRule: 'XCPC', contestType: 'INDIVIDUAL', rules: '',
    candidates: { create: { examNumber: 'team01', password: 'fixture-password', seatNo: '1' } },
  } }); examId = exam.id;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(admin), url: base }]);
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/dashboard/exams/${examId}/settings/problems`);
  await page.getByRole('button', { name: '外榜推送', exact: true }).click();
  await page.waitForURL('**/settings/external-board');
  const toggle = page.getByRole('switch', { name: '外榜推送开关' });
  await waitFor(() => toggle.isEnabled(), 'external-board form');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false'); assert.equal(reads, 0);
  await page.getByLabel('CWNUPAA 官网域名', { exact: true }).fill(source);
  await page.getByLabel('CWNUPAA 官网赛事 ID', { exact: true }).fill('123');
  await page.getByPlaceholder('留空使用 CWNUPAA 外部登录密钥').fill('fixture-board-key');
  await page.getByLabel('推送间隔（秒）').fill('1');
  const patch = (action: () => Promise<unknown>) => {
    const response = page.waitForResponse(r => r.url().endsWith(`/api/exams/${examId}/external-board`) && r.request().method() === 'PATCH');
    return action().then(() => response);
  };
  assert.equal((await patch(() => toggle.click())).status(), 200);
  await waitFor(() => received.length === 1, 'automatic native submission push');
  assert.equal(received[0].problem, 'A'); assert.equal(received[0].status, 'Accepted'); assert.equal(received[0].code, row.code);
  row.status = 2; row.score = 0;
  await waitFor(() => received.length === 2, 'automatic old rejudge update');
  assert.equal(received[0].rid, received[1].rid); assert.equal(received[1].status, 'Wrong Answer');
  await waitFor(async () => await page.getByRole('region', { name: '推送日志' }).getByText('HydroOJ 外榜同步完成').count() > 0, 'Hydro success log');
  await page.getByLabel('CWNUPAA 官网赛事 ID', { exact: true }).fill('');
  assert.equal((await patch(() => toggle.click())).status(), 200, 'stop works even with an invalid draft');
  const stoppedReads = reads, stoppedPosts = received.length;
  row.status = 1; await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(reads, stoppedReads); assert.equal(received.length, stoppedPosts);
  await page.reload(); await waitFor(() => toggle.isEnabled(), 'saved state after reload');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await page.getByLabel('CWNUPAA 官网赛事 ID', { exact: true }).inputValue(), '123');
  if (process.env.EXTERNAL_BOARD_SCREENSHOT) await page.screenshot({ path: process.env.EXTERNAL_BOARD_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: Hydro management entry, persisted switch, independent config save, native automatic push, stable rejudge update, visible logs, draft-safe stop and reload persistence.');
} finally {
  await browser?.close();
  if (examId) await prisma.exam.deleteMany({ where: { id: examId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.systemSetting.deleteMany({ where: { key: 'hydro' } });
  mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));
  await prisma.$disconnect();
}
