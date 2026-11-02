// Run against a local production candidate-web server. All exam APIs are synthetic.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base = process.env.CLIENT_QA_BASE || 'http://127.0.0.1:43120';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ extraHTTPHeaders: { 'x-proctor-client': 'desktop', 'x-proctor-session-token': 'qa-token' } });
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const createdAt = new Date().toISOString();
const session = { status: 'IN_EXAM', startedAt: createdAt, effectiveEndAt: new Date(Date.now() + 3_600_000).toISOString(), canSubmit: true, canViewSubmissions: true };
let revision = 'v1';
let shared = true;
let version = 1;
let casesVisible = true;
let failFirstDetail = true;
let objectiveMode = false;
let detailDelay = 0;
let legacyMode = false;
let fullReads = 0;
let stateReads = 0;
let summaryReads = 0;
let detailReads = 0;
const makeRow = (id: string, isOwn: boolean) => ({ id, problemIndex: 'A', problemTitle: 'Synthetic problem', status: 1, statusText: 'Accepted', score: 100, time: 10, memory: 1024, lang: objectiveMode ? '_' : 'cpp', code: '', testCases: [], totalTestCases: casesVisible ? 1 : null, passedTestCases: casesVisible ? 1 : null, createdAt, updatedAt: String(version), canViewDetail: true, detailsLoaded: false, isOwn, submittedBy: { username: isOwn ? 'own' : 'team', displayName: isOwn ? '本人' : '队友' } });
const rows = () => objectiveMode ? [makeRow('team-record', false), makeRow('own-record', true)] : [makeRow('own-record', true), ...(shared ? [makeRow('team-record', false)] : [])];
await page.route('**/api/client/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const fulfill = (data: unknown) => route.fulfill({ json: { ok: true, data } });
  if (url.pathname === '/api/client/contest') {
    fullReads++;
    assert.equal(url.searchParams.get('summaryOnly'), 'true');
    return fulfill({ revision, session, user: { uid: 'own', username: 'own', displayName: '本人' },
      contest: { id: 'fixture', title: '提交权限验证', rule: 'ioi', sourceRule: 'IOI', content: 'QA fixture', beginAt: createdAt, endAt: session.effectiveEndAt, langs: [{ id: 'cpp', name: 'C++' }], allowTeamSubmissionView: shared },
      problems: [{ index: 'A', pid: 1, title: 'Synthetic problem', score: 100, content: objectiveMode ? '{{input(q1)}}' : 'Synthetic statement', problemType: objectiveMode ? 'objective' : 'default', languages: ['cpp'] }], files: [], submissions: rows() });
  }
  if (url.pathname === '/api/client/contest/state') { stateReads++; return fulfill({ revision, session: legacyMode ? { ...session, effectiveEndAt: new Date(0).toISOString() } : session, ...(legacyMode ? { requiresFullRefresh: true } : {}) }); }
  if (url.pathname === '/api/client/contest/submissions') {
    const input = request.postDataJSON();
    if (input.submissionId) {
      detailReads++;
      if (failFirstDetail) { failFirstDetail = false; return route.fulfill({ status: 503, json: { ok: false, message: 'temporary outage' } }); }
      if (detailDelay) await new Promise(resolve => setTimeout(resolve, detailDelay));
      const row = rows().find(item => item.id === input.submissionId);
      if (!row) return route.fulfill({ status: 404, json: { ok: false, message: '提交记录不存在或无权访问' } });
      return fulfill({ ...row, detailsLoaded: true, code: objectiveMode ? `q1: ${row.isOwn ? 'own answer' : 'teammate answer'}` : `// PRIVATE ${row.id} v${version}`, testCases: casesVisible ? [{ status: 1, message: `case-v${version}` }] : [] });
    }
    assert.equal(input.summaryOnly, true); summaryReads++; return fulfill(rows());
  }
  if (url.pathname === '/api/client/qa') return fulfill({ questions: [], announcements: [] });
  if (url.pathname === '/api/client/qa/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: connected\ndata: {}\n\n' });
  return fulfill({});
});
try {
  await page.goto(`${base}/contest/submissions?apiBase=${encodeURIComponent(base)}&sessionId=qa&sessionToken=qa-token`);
  await page.getByRole('link', { name: '查看提交 team-record' }).waitFor();
  assert.equal(detailReads, 0, 'list must not fetch code/test cases');
  await page.getByRole('link', { name: '查看提交 team-record' }).click();
  await page.getByText('// PRIVATE team-record v1', { exact: false }).first().waitFor();
  assert.equal(detailReads, 2, 'transient detail failure automatically retries');
  await page.waitForTimeout(6200);
  assert.equal(fullReads, 1, 'unchanged lightweight state must not reload full statements');
  assert.ok(stateReads >= 1);
  assert.equal(detailReads, 2, 'unchanged summaries must not download detail again');
  version++;
  await page.getByText('// PRIVATE team-record v2', { exact: false }).first().waitFor({ timeout: 8000 });
  assert.equal(detailReads, 3, 'new judge revision must refresh detail');
  casesVisible = false; revision = 'visibility-changed';
  await page.waitForFunction(() => !document.querySelector('.submission-detail-tests'), { timeout: 10_000 });
  await page.getByText('// PRIVATE team-record v2', { exact: false }).first().waitFor();
  assert.equal(detailReads, 4, 'settings-only visibility changes invalidate open details');
  shared = false; revision = 'v2';
  await page.getByText('仅显示本考试账号的提交记录', { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole('link', { name: '查看提交 team-record' }).count(), 0);
  assert.equal(await page.getByText('// PRIVATE team-record v2', { exact: false }).count(), 0, 'revoked teammate detail must close');
  await page.getByRole('link', { name: '查看提交 own-record' }).click();
  await page.getByText('// PRIVATE own-record v2', { exact: false }).first().waitFor();
  legacyMode = true;
  const stateCountBeforeLegacy = stateReads;
  const fullCountBeforeLegacy = fullReads;
  await page.waitForTimeout(5700);
  assert.ok(stateReads > stateCountBeforeLegacy);
  assert.ok(fullReads > fullCountBeforeLegacy, 'legacy contests retain full refresh');
  assert.ok(await page.getByRole('heading', { name: '提交记录', exact: true }).count(), 'an unverified legacy deadline must never replace the full response deadline');
  legacyMode = false;
  objectiveMode = true; shared = true; revision = 'objective';
  await page.goto(`${base}/contest/problems/1?apiBase=${encodeURIComponent(base)}&sessionId=qa&sessionToken=qa-token`);
  await page.waitForFunction(() => (document.querySelector('input[placeholder="请输入答案"]') as HTMLInputElement)?.value === 'own answer');
  assert.equal(await page.getByPlaceholder('请输入答案').inputValue(), 'own answer', 'restore only the current account even when teammate record appears first');
  await page.evaluate(() => localStorage.removeItem('proctor.contest.objective.qa.1'));
  detailDelay = 2000;
  await page.reload();
  await page.getByPlaceholder('请输入答案').fill('new unsaved answer');
  await page.waitForTimeout(2600);
  assert.equal(await page.getByPlaceholder('请输入答案').inputValue(), 'new unsaved answer', 'delayed recovery cannot overwrite current edits');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ fullReads, stateReads, summaryReads, detailReads, privacyRevocation: 'passed', unchangedDetailCache: 'passed' }));
} catch (error) { console.error({ url: page.url(), errors, body: (await page.locator('body').innerText()).slice(0, 2000), fullReads, stateReads, summaryReads }); throw error; } finally { await browser.close(); }
