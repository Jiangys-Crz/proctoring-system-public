import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { chromium, type Page } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { digestPasswordForStorage } from '../src/lib/password-crypto';

// Run against a local web server using the same DATABASE_URL. Only this run's exam and user are modified.
const base = process.env.CONTEST_LIVE_QA_BASE || 'http://127.0.0.1:4031';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const manager = await browser.newContext({ baseURL: base });
const team = 'Visual QA Team';
const config = {
  CONTEST_COLOR: '#184a6c', SCOREBOARD_HEADER_NAME_TITLE: 'Registered teams',
  SCOREBOARD_ROW_FONT_SIZE: '29px', EXTRA_CSS: '[data-widget="scoreboard"] { --qa-accent: teal }',
  WIDGET_POSITIONS: { scoreboard: { positionX: 82 }, scoreboardFullScreen: { positionX: 96 } },
  SCENES: { venue: { WIDGET_POSITIONS: { scoreboardFullScreen: { positionX: 114 } } } },
};
let examId: string | undefined;
let userId: string | undefined;

async function checkScreen(page: Page, customized: boolean, x: number) {
  const board = page.locator('[data-widget="scoreboard"]');
  const header = board.getByText(customized ? config.SCOREBOARD_HEADER_NAME_TITLE : 'Name', { exact: true });
  await header.waitFor();
  const name = board.getByText(team, { exact: true });
  await name.waitFor();
  assert.equal(await header.evaluate(el => getComputedStyle(el).backgroundColor), customized ? 'rgb(24, 74, 108)' : 'rgb(76, 131, 195)');
  assert.equal(await name.evaluate(el => getComputedStyle(el).fontSize), customized ? '29px' : '22px');
  assert.equal(await board.evaluate(el => getComputedStyle(el).left), x + 'px');
  assert.equal(await board.evaluate(el => getComputedStyle(el).getPropertyValue('--qa-accent').trim()), customized ? 'teal' : '');
}

try {
  const password = randomBytes(24).toString('hex');
  const username = 'visual-qa-' + randomUUID();
  const user = await prisma.user.create({ data: { username, passwordHash: await bcrypt.hash(digestPasswordForStorage(password), 10) } });
  userId = user.id;
  const startAt = new Date(Date.now() + 3_600_000);
  const exam = await prisma.exam.create({ data: {
    name: 'Visual config QA', examCode: randomBytes(5).toString('hex'), createdById: user.id,
    platform: 'HYDRO', platformBaseUrl: base, platformContestId: 'local', contestType: 'INDIVIDUAL', contestRule: 'XCPC', rules: '',
    startAt, latestStartAt: startAt, endAt: new Date(+startAt + 3_600_000), durationMinutes: 60,
    candidates: { create: { name: team, examNumber: 'qa', seatNo: '1', password: randomUUID() } },
    problems: { create: { order: 0, hydroProblemId: '1', title: 'Unreleased problem', content: 'QA' } },
  } });
  examId = exam.id;
  const api = '/api/exams/' + exam.id + '/contest-live';
  const login = await manager.request.post('/api/auth/login', { data: { account: username, password } });
  assert.equal(login.status(), 200);
  assert.equal((await manager.request.patch(api, { data: {
    freeze: { at: new Date(+startAt + 1_800_000).toISOString() },
    widgets: { scoreboard: true, clock: false, queue: false, statistics: false },
  } })).status(), 200);
  const granted = await manager.request.post(api + '/access');
  assert.equal(granted.status(), 200);
  const { data: { key } } = await granted.json();

  const admin = await manager.newPage();
  const preview = await manager.newPage();
  const obs = await browser.newPage();
  const screen = await browser.newPage();
  const url = base + '/contest-live/' + exam.id;
  await Promise.all([
    admin.goto('/dashboard/live/contests/' + exam.id + '?tab=settings#visual-config'), preview.goto(url + '?preview=1'),
    obs.goto(url + '?noStatus&key=' + key), screen.goto(url + '?view=scoreboard&visualConfigScene=venue&noStatus&key=' + key),
  ]);
  const screens = [preview, obs, screen];
  await Promise.all(screens.map(page => checkScreen(page, false, 16)));
  const getSettings = async () => (await (await manager.request.get(api)).json()).data;
  const initial = await getSettings();
  assert.equal(initial.contest.teams.length, 1);
  assert.equal(initial.contest.problems.length, 0);
  assert.deepEqual(initial.settings.visualConfig, {});

  const editor = admin.getByLabel('visual-config.json', { exact: true });
  const save = admin.getByRole('button', { name: '保存外观配置' });
  await editor.fill('{"WIDGET_POSITIONS":{"queue":{"sizeY":-2}}}');
  await admin.getByRole('alert').filter({ hasText: 'WIDGET_POSITIONS.queue.sizeY' }).waitFor();
  assert.ok(await save.isDisabled());
  await editor.fill('{"SCOREBOARD_ROW_FONT_SIZE":"29pixels"}');
  await admin.getByRole('alert').filter({ hasText: 'font-size' }).waitFor();
  assert.ok(await save.isDisabled());
  assert.equal((await manager.request.patch(api, { data: { visualConfig: { SCOREBOARD_ROW_HEIGHT: 0 } } })).status(), 400);

  await admin.bringToFront();
  const source = JSON.stringify(config, null, 2);
  await admin.getByLabel('导入 JSON').setInputFiles({ name: 'visual-config.json', mimeType: 'application/json', buffer: Buffer.from(source) });
  await admin.waitForResponse(response => new URL(response.url()).pathname === api && response.request().method() === 'GET' && response.ok());
  assert.equal(await editor.inputValue(), source);
  await save.click();
  await admin.getByText('已保存本场直播外观', { exact: true }).waitFor();
  assert.deepEqual((await getSettings()).settings.visualConfig, config);
  await Promise.all(screens.map(page => checkScreen(page, true, page === screen ? 114 : 82)));

  await admin.reload();
  await editor.waitFor();
  assert.deepEqual(JSON.parse(await editor.inputValue()), config);
  await admin.getByRole('button', { name: '填入默认配置 {}' }).click();
  await save.click();
  await admin.getByText('已保存本场直播外观', { exact: true }).waitFor();
  await Promise.all(screens.map(page => checkScreen(page, false, 16)));
  assert.deepEqual((await getSettings()).settings.visualConfig, {});
  console.log('PASS · editor validation, file import, draft polling, persisted save/reset, preview, private OBS and scoreboard computed styles');
} finally {
  await browser.close();
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
}
