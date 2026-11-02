// Run against the disposable local monitor QA database and a production server
// with MEDIA_API_INTERNAL_BASE=http://127.0.0.1:43119. Own fixtures only.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { mediaStreamPath } from '../src/lib/media-read-token';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_monitor_freeze_qa');
const base = process.env.MONITOR_SEARCH_QA_BASE || 'http://127.0.0.1:43118';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const marker = `monitor-search-${randomUUID()}`;
const userIds: string[] = [];
let examId = '', browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let mediaUnavailable = false;
const readySessions = new Set<string>();
const media = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (!request.url?.startsWith('/v3/paths/list') || mediaUnavailable) {
    response.statusCode = 503; response.end('{}'); return;
  }
  response.end(JSON.stringify({ pageCount: 1, items: [...readySessions].map(id => ({
    name: mediaStreamPath(id, 'DESKTOP_SCREEN').slice(1), ready: true, bytesReceived: 1024
  })) }));
});
await new Promise<void>((resolve, reject) => { media.once('error', reject); media.listen(43119, '127.0.0.1', resolve); });

try {
  const owner = await prisma.user.create({ data: { username: `${marker}-owner`, role: 'ADMIN' } }); userIds.push(owner.id);
  const proctor = await prisma.user.create({ data: { username: `${marker}-proctor`, role: 'ADMIN' } }); userIds.push(proctor.id);
  const now = new Date();
  const exam = await prisma.exam.create({ data: {
    name: marker, createdById: owner.id, examCode: String(randomInt(1_000_000_000, 10_000_000_000)),
    startAt: new Date(+now - 60_000), latestStartAt: now, endAt: new Date(+now + 3_600_000), durationMinutes: 60,
    platform: 'HYDRO', platformBaseUrl: 'https://judge.invalid', platformContestId: marker,
    contestType: 'INDIVIDUAL', contestRule: 'XCPC', rules: '', requireMiniProgram: false, requireFrontCamera: false,
  } }); examId = exam.id;
  const candidates = Array.from({ length: 13 }, (_, index) => ({
    id: `${marker}-${index}`, examId, name: index === 5 ? '2026004' : `监考姓名${String(index).padStart(2, '0')}`,
    studentId: `2026${String(index).padStart(3, '0')}`, examNumber: String(index), seatNo: String(index).padStart(2, '0'),
    password: marker, status: index === 0 ? 'FINISHED' as const : 'ONLINE_NORMAL' as const,
  }));
  await prisma.candidate.createMany({ data: candidates });
  await prisma.examRoom.create({ data: { examId, name: '授权考室', requireSecondCamera: false, requireFrontCamera: false,
    proctors: { create: { userId: proctor.id } }, candidates: { create: candidates.slice(0, 12).map(item => ({ candidateId: item.id })) } } });
  await prisma.clientSession.createMany({ data: candidates.filter((_, index) => index !== 3).map((candidate, index) => ({
    id: `${candidate.id}-session`, examId, candidateId: candidate.id, status: index === 0 ? 'FINISHED' as const : 'IN_EXAM' as const,
    startedAt: new Date(+now - 30_000), lastDesktopSeenAt: new Date(+now + 120_000),
  })) });
  // Include an unauthorized and a finished session in MediaMTX: state must
  // exclude both, while all eight active ready candidates fill the first pages.
  for (const index of [0, 4, 5, 6, 7, 8, 9, 10, 11, 12]) readySessions.add(`${candidates[index].id}-session`);
  await prisma.loginRequest.create({ data: { examId, candidateId: candidates[1].id } });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(15_000);
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(proctor), url: base }]);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // This test exercises readiness/sorting, not video decoding. Do not create
  // test WHEP peers on a real media service.
  await page.route('**/api/media/whep**', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/media/hls/**', route => route.fulfill({ status: 404, body: '' }));
  const statePath = `/api/exams/${examId}/state`;
  const stateResponse = page.waitForResponse(response => response.url().endsWith(statePath) && response.ok());
  await page.goto(`${base}/dashboard/exams/${examId}/monitor`);
  const initial = (await (await stateResponse).json()).data;
  assert.equal(initial.candidates.length, 12);
  assert.equal(initial.loginRequests.length, 1);
  assert.equal(initial.liveStatusAvailable, true);
  assert.equal(initial.liveReadySessionIds.length, 8);
  assert.ok(!initial.liveReadySessionIds.includes(`${candidates[12].id}-session`));
  assert.ok(!initial.liveReadySessionIds.includes(`${candidates[0].id}-session`));
  const names = () => page.locator('.candidate-feed > strong').allTextContents();
  const expectNames = async (indices: number[]) => {
    const expected = indices.map(index => candidates[index].name);
    await page.waitForFunction(values => JSON.stringify([...document.querySelectorAll('.candidate-feed > strong')].map(item => item.textContent)) === JSON.stringify(values), expected);
    assert.deepEqual(await names(), expected);
  };
  const counter = page.locator('.monitor-page-count');
  await expectNames([4]); assert.equal((await counter.textContent())?.trim(), '1 / 12');
  await page.getByTitle('下一页', { exact: true }).click();
  await expectNames([5]); assert.equal((await counter.textContent())?.trim(), '2 / 12');
  for (let i = 0; i < 3; i++) await page.waitForResponse(response => response.url().endsWith(statePath) && response.ok());
  await expectNames([5]); assert.equal((await counter.textContent())?.trim(), '2 / 12');

  await page.locator('.monitor-layout-switch select').selectOption('4');
  await expectNames([4, 5, 6, 7]);
  await page.getByTitle('下一页', { exact: true }).click(); await expectNames([8, 9, 10, 11]);
  assert.equal((await counter.textContent())?.trim(), '2 / 3');
  for (let i = 0; i < 3; i++) await page.waitForResponse(response => response.url().endsWith(statePath) && response.ok());
  await expectNames([8, 9, 10, 11]);

  mediaUnavailable = true;
  await page.waitForResponse(async response => response.url().endsWith(statePath) && response.ok() && (await response.json()).data.liveStatusAvailable === false);
  await expectNames([8, 9, 10, 11]);
  assert.equal((await counter.textContent())?.trim(), '2 / 3', 'media status failure must retain known ready ordering and page');
  mediaUnavailable = false;
  readySessions.add(`${candidates[1].id}-session`);
  await expectNames([7, 8, 9, 10]);
  assert.equal((await counter.textContent())?.trim(), '2 / 3', 'a newly ready feed moves forward without resetting the current page');
  readySessions.delete(`${candidates[1].id}-session`);
  await expectNames([8, 9, 10, 11]);

  await page.getByLabel('按姓名搜索', { exact: true }).fill('2026004');
  await expectNames([5]); assert.equal((await counter.textContent())?.trim(), '1 / 1');
  await page.getByLabel('搜索方式', { exact: true }).selectOption('studentId');
  await expectNames([4]);
  const whileSearching = (await (await page.waitForResponse(response => response.url().endsWith(statePath) && response.ok())).json()).data;
  assert.equal(whileSearching.loginRequests.length, 1, 'monitor search must not filter the shared login-review collection');
  await page.getByLabel('按学号搜索', { exact: true }).fill('2026001');
  await expectNames([1]); assert.equal((await counter.textContent())?.trim(), '1 / 1', 'search includes candidates without a feed');
  await page.getByLabel('按学号搜索', { exact: true }).fill('2026012');
  await page.getByText('当前筛选下暂无考生画面', { exact: true }).waitFor();
  assert.equal((await counter.textContent())?.trim(), '0 / 0', 'search cannot reveal another room');
  await page.getByLabel('按学号搜索', { exact: true }).fill('');
  await expectNames([4, 5, 6, 7]);
  await page.getByTitle('下一页', { exact: true }).click();
  await page.getByTitle('下一页', { exact: true }).click();
  await expectNames([1, 2, 3, 0]);
  assert.equal(await page.getByTitle('下一页', { exact: true }).isDisabled(), true);

  await page.getByTitle('上一页', { exact: true }).click();
  await page.getByTitle('上一页', { exact: true }).click();
  await expectNames([4, 5, 6, 7]);
  await prisma.clientSession.update({ where: { id: `${candidates[4].id}-session` }, data: { status: 'FINISHED' } });
  await prisma.candidate.update({ where: { id: candidates[4].id }, data: { status: 'FINISHED' } });
  await expectNames([5, 6, 7, 8]);
  assert.equal((await counter.textContent())?.trim(), '1 / 3', 'finishing the selected candidate must not jump to the last page');
  await page.screenshot({ path: '/tmp/proctor-monitor-search-qa.png', fullPage: true });
  await page.setViewportSize({ width: 900, height: 1000 });
  const stage = await page.locator('.monitor-stage').boundingBox();
  const nextPage = await page.getByTitle('下一页', { exact: true }).boundingBox();
  assert.ok(stage && nextPage && nextPage.y >= stage.y + stage.height, 'narrow pagination stays outside candidate controls');
  await page.screenshot({ path: '/tmp/proctor-monitor-search-qa-narrow.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: real authorized state + MediaMTX readiness; eight ready feeds fill first pages; 1/4-person pagination survives polling; name/student-ID search resets page and respects room scope; media outage retains order; finished candidates move last without a page jump.');
} finally {
  await browser?.close();
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  await new Promise<void>(resolve => media.close(() => resolve()));
}
