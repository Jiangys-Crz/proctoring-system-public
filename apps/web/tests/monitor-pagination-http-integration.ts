import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Run against a disposable LOAD_ exam; never select or mutate an existing exam.
const fixturePath = process.env.TEST_MONITOR_FIXTURE;
assert(fixturePath, 'TEST_MONITOR_FIXTURE must identify a private load-test fixture');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
assert(/^LOAD_/.test(fixture.prefix) && fixture.examId && fixture.adminCookie);
const base = new URL(process.env.TEST_MONITOR_BASE_URL || 'http://127.0.0.1:4031');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
try {
  const context = await browser.newContext();
  const separator = fixture.adminCookie.indexOf('=');
  await context.addCookies([{ name: fixture.adminCookie.slice(0, separator), value: fixture.adminCookie.slice(separator + 1), url: base.origin, httpOnly: true, secure: base.protocol === 'https:' }]);
  const page = await context.newPage();
  let refreshes = 0;
  page.on('response', response => { if (response.url().endsWith(`/api/exams/${fixture.examId}/state`) && response.ok()) refreshes++; });
  await page.goto(new URL(`/dashboard/exams/${fixture.examId}/monitor`, base).toString(), { waitUntil: 'domcontentloaded' });
  const counter = page.locator('.monitor-page-count');
  await counter.waitFor();
  const results = [];
  for (const layout of ['1', '4']) {
    await page.locator('.monitor-layout-switch select').selectOption(layout);
    await page.getByTitle('下一页', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.monitor-page-count')?.textContent?.trim().startsWith('2 /'));
    const selectedPage = await counter.textContent();
    const before = refreshes;
    await page.waitForTimeout(7500);
    assert(refreshes - before >= 3, 'must exercise at least three actual status/media polls');
    const finalPage = await counter.textContent();
    results.push({ layout, selectedPage, finalPage, refreshes: refreshes - before });
    if (process.env.TEST_MONITOR_EXPECT_RESET === '1') assert(finalPage?.trim().startsWith('1 /'), 'baseline must reproduce the reset');
    else assert.equal(finalPage, selectedPage, 'polling must preserve the selected page');
    await page.getByTitle('上一页', { exact: true }).click();
  }
  console.log(JSON.stringify({ pagination: results, expectedReset: process.env.TEST_MONITOR_EXPECT_RESET === '1' }));
} finally {
  await browser.close();
}
