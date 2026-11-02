// Local candidate-web only; exercise the real contest serializer with synthetic problems.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { serializeLocalContest } from '../src/lib/local-contest';

const base = process.env.CLIENT_QA_BASE || 'http://127.0.0.1:4342';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const now = new Date(), end = new Date(+now + 3_600_000);
const fixtures = [
  { title: '未配置限制的编程题', config: {}, time: '1000 ms', memory: '256 MB' },
  { title: '自定义限制的编程题', config: { time: '2.5s', memory: '512m' }, time: '2500 ms', memory: '512 MB' },
  { title: '测试点继承限制', config: { subtasks: [{ time: '1s', memory: '128m', cases: [{}, { time: '3s', memory: '768m' }] }] }, time: '3000 ms', memory: '768 MB' },
  { title: '客观题不显示运行限制', config: { type: 'objective' }, time: '—', memory: '—' },
];
const contest = serializeLocalContest({
  exam: { id: 'limits-test', name: '题目限制验证', contestRule: 'IOI', contestType: 'INDIVIDUAL',
    startAt: new Date(+now - 60_000), latestStartAt: end, endAt: end, durationMinutes: 60,
    allowedLanguages: [], showTestCaseCount: true, showObjectiveScore: true,
    problems: fixtures.map((fixture, order) => ({ id: `problem-${order}`, order, hydroProblemId: String(order + 1), title: fixture.title,
      score: 100, content: 'Synthetic statement.', html: false, problemType: fixture.config.type || 'default', config: fixture.config,
      files: [], timeLimitMs: null, memoryLimitMb: null, languages: [] })),
  },
  candidate: { id: 'candidate', examNumber: 'qa', name: '测试考生', startedAt: now },
  session: { id: 'qa', status: 'IN_EXAM', startedAt: now, lockdown: false, lockdownReason: null, latestStartAt: end },
  languages: [{ id: 'cpp', name: 'C++' }], submissions: [],
} as any);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const page = await browser.newPage({ extraHTTPHeaders: { 'x-proctor-client': 'desktop', 'x-proctor-session-token': 'qa-token' } });
page.setDefaultTimeout(15_000);
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/client/**', async route => {
  const pathname = new URL(route.request().url()).pathname;
  const session = { status: 'IN_EXAM', startedAt: now.toISOString(), effectiveEndAt: end.toISOString(), canSubmit: true, canViewSubmissions: true };
  const data = pathname === '/api/client/contest' ? { ...contest, revision: 'limits-test', session }
    : pathname === '/api/client/contest/state' ? { revision: 'limits-test', session }
      : pathname.endsWith('/submissions') ? [] : { questions: [], announcements: [] };
  await route.fulfill({ json: { ok: true, data } });
});
const query = `?apiBase=${encodeURIComponent(base)}&sessionId=qa&sessionToken=qa-token`;
try {
  for (const fixture of fixtures) {
    await page.goto(`${base}/contest/problems${query}`);
    await page.getByRole('heading', { name: '题目列表', exact: true }).waitFor();
    const headers = await page.locator('.exam-problem-table th').allTextContents();
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: fixture.title, exact: true }) });
    assert.equal(await row.getByRole('cell').nth(headers.indexOf('时间限制')).innerText(), fixture.time);
    assert.equal(await row.getByRole('cell').nth(headers.indexOf('空间限制')).innerText(), fixture.memory);
    await row.getByRole('button', { name: '查看题目', exact: true }).click();
    const metadata = page.locator('.candidate-problem-meta');
    if (fixture.config.type === 'objective') {
      assert.equal(await metadata.getByText(/时间限制：|空间限制：/).count(), 0);
    } else {
      await metadata.getByText(`时间限制：${fixture.time}`, { exact: true }).waitFor();
      await metadata.getByText(`空间限制：${fixture.memory}`, { exact: true }).waitFor();
      const sidebar = page.locator('.candidate-problem-subnav .nova-problem-info');
      assert.equal(await sidebar.getByText(fixture.time, { exact: true }).count(), 1);
      assert.equal(await sidebar.getByText(fixture.memory, { exact: true }).count(), 1);
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: problem list, detail heading and sidebar show consistent default/custom/testcase limits; objective questions keep runtime limits hidden.');
} finally { await browser.close(); }
