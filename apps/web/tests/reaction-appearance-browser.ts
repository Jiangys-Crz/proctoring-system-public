/** Actual browser acceptance; creates an isolated exam and never edits a user exam. */
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { deleteStoredObject } from '../src/lib/storage';

const base = process.env.REACTION_TEST_BASE || 'http://localhost:4031';
const output = path.resolve(process.env.REACTION_APPEARANCE_TEST_OUTPUT || '.local/reaction-appearance-browser');
const db = new URL(process.env.DATABASE_URL || 'mysql://invalid/invalid');
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname) && /reaction/i.test(db.pathname));
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname));
const checks: { test: string; result: string; evidence?: unknown }[] = [];
const assets: string[] = [];
let examId = '', userId = '';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function check(test: string, action: () => Promise<unknown>) {
  try { const evidence = await action(); checks.push({ test, result: 'PASS', evidence }); console.log('PASS ' + test); }
  catch (error) { checks.push({ test, result: 'FAIL', evidence: error instanceof Error ? error.message : String(error) }); throw error; }
}
try {
  await fs.mkdir(output, { recursive: true });
  const owner = await prisma.user.create({ data: { username: 'appearance-ui-' + randomBytes(6).toString('hex'), role: 'ADMIN' } }); userId = owner.id;
  const exam = await prisma.exam.create({ data: { examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: 'Reaction 背景预览验收（隔离）', startAt: new Date(), latestStartAt: new Date(Date.now() + 3600000), endAt: new Date(Date.now() + 3600000), durationMinutes: 60, platform: 'NOVAJUDGE', platformBaseUrl: 'http://127.0.0.1:3001', platformContestId: 'appearance-ui-not-connected', contestType: 'TEAM', rules: 'Synthetic UI fixture', createdById: owner.id } }); examId = exam.id;
  await prisma.candidate.create({ data: { examId, examNumber: 'preview_team', name: '背景预览测试队伍', teamName: '背景预览测试队伍', school: '隔离界面测试组织', password: randomBytes(32).toString('hex'), seatNo: '1' } });
  const endpoint = base + '/api/exams/' + examId + '/reactions';
  const cookie = 'cwnupaa_proctor_session=' + createSessionToken(owner);
  const read = (url: string) => fetch(url, { headers: { cookie } });
  browser = await chromium.launch({ executablePath: process.env.REACTION_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: cookie.slice(cookie.indexOf('=') + 1), url: base, httpOnly: true }]);
  const page = await context.newPage(); const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base + '/dashboard/exams/' + examId + '/reactions');
  const appearance = page.locator('section[aria-label="视频外观设置"]');
  await page.getByLabel('预览队伍', { exact: true }).waitFor();
  await check('Exam appearance contains background and typography, no badge management', async () => {
    assert.equal(await appearance.getByLabel('上传背景图片', { exact: true }).count(), 1);
    assert.equal(await appearance.locator('input[type=file]').count(), 1);
    assert.equal(await appearance.getByText('按队伍绑定校徽', { exact: true }).count(), 0);
    assert((await appearance.innerText()).includes('1080 × 1920'));
    assert((await appearance.innerText()).includes('4 MiB'));
  });
  await check('Authenticated default background and badge render as valid PNG; cross-team denied', async () => {
    for (const kind of ['background', 'logo']) {
      const url = endpoint + '/appearance-preview?kind=' + kind + '&teamId=preview_team';
      assert.equal((await fetch(url)).status, 401);
      const response = await read(url); assert.equal(response.status, 200);
      const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata(); assert.equal(meta.format, 'png');
      if (kind === 'background') { assert.equal(meta.width, 1080); assert.equal(meta.height, 1920); }
    }
    assert.equal((await read(endpoint + '/appearance-preview?kind=logo&teamId=other_exam_team')).status, 404);
  });
  await check('Default full composition preview follows official coordinates', async () => {
    await page.getByText('与输出比例一致。', { exact: false }).waitFor();
    const svg = appearance.getByRole('img', { name: 'Reaction 竖屏背景与视频位置预览', exact: true });
    assert.equal(await svg.getAttribute('viewBox'), '0 0 1080 1920');
    const camera = svg.locator('rect[x="40"][y="194.5"]'); assert.equal(await camera.getAttribute('height'), '562.5');
    assert.equal(await svg.locator('rect[x="40"][y="1163"]').getAttribute('width'), '1000');
    await appearance.screenshot({ path: path.join(output, 'appearance-default.png') });
  });
  await check('Landscape upload previews center crop, persists, and returns to built-in background', async () => {
    const buffer = await sharp(Buffer.from('<svg width="1600" height="900"><rect width="1600" height="900" fill="#e4d4fa"/><rect width="550" height="900" fill="#f77474"/><rect x="1050" width="550" height="900" fill="#75bcda"/><text x="800" y="120" text-anchor="middle" font-size="50">CENTER / TEST</text></svg>')).png().toBuffer();
    const uploaded = page.waitForResponse(r => r.url() === endpoint + '/assets' && r.request().method() === 'POST');
    await page.getByLabel('上传背景图片', { exact: true }).setInputFiles({ name: 'landscape-test.png', mimeType: 'image/png', buffer });
    const response = await uploaded; assert.equal(response.status(), 200); const asset = (await response.json()).data; assets.push(asset.path);
    await page.getByText('当前比例会居中裁切，预览已显示裁切结果。', { exact: false }).waitFor();
    const svg = appearance.getByRole('img', { name: 'Reaction 竖屏背景与视频位置预览', exact: true });
    assert.equal(await svg.locator('image').first().getAttribute('preserveAspectRatio'), 'xMidYMid slice');
    await page.getByLabel('预览判题状态', { exact: true }).selectOption('AC');
    await appearance.screenshot({ path: path.join(output, 'appearance-custom-cropped.png') });
    await page.getByRole('button', { name: '保存视频外观', exact: true }).click();
    await page.getByText('Reaction 配置已保存', { exact: true }).waitFor();
    const data = await (await read(endpoint)).json(); assert.equal(data.data.config.presentation.backgroundPath, asset.path);
    await page.getByLabel('背景来源', { exact: true }).selectOption('default');
    await page.getByLabel('背景来源', { exact: true }).selectOption('custom');
    assert((await svg.locator('image').first().getAttribute('href'))?.includes(asset.assetId));
    await page.getByLabel('背景来源', { exact: true }).selectOption('default');
    await page.getByRole('button', { name: '保存视频外观', exact: true }).click();
    await page.getByText('Reaction 配置已保存', { exact: true }).waitFor();
    await page.reload(); await page.getByLabel('预览队伍', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('背景来源', { exact: true }).inputValue(), 'default');
    return { uploadedDimensions: '1600x900', previewCrop: 'center cover', savedAndRestored: true };
  });
  await check('Background-only view and narrow viewport remain usable', async () => {
    await page.getByLabel('显示视频与信息卡位置', { exact: true }).uncheck();
    const svg = appearance.getByRole('img', { name: 'Reaction 竖屏背景与视频位置预览', exact: true });
    assert.equal(await svg.locator('text').count(), 0);
    await page.getByLabel('显示视频与信息卡位置', { exact: true }).check();
    await page.setViewportSize({ width: 480, height: 1000 });
    const widths = await appearance.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
    assert(widths.scroll <= widths.client + 1, JSON.stringify(widths));
    await appearance.screenshot({ path: path.join(output, 'appearance-mobile.png') });
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    return { widths, pageErrors };
  });
} finally {
  await browser?.close();
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  for (const asset of assets) await deleteStoredObject(asset);
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: checks.length >= 5 && checks.every(item => item.result === 'PASS'), checks, fixtureRemoved: true, userExamModified: false }, null, 2));
  await prisma.$disconnect();
}
