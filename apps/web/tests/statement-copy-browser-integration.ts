// Local candidate-web only; all contest data is synthetic.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.CLIENT_QA_BASE || 'http://127.0.0.1:4342';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], extraHTTPHeaders: { 'x-proctor-client': 'desktop', 'x-proctor-session-token': 'qa-token' } });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const content = '## 输入样例\n\n```\n3\n1  2\t3\n```\n\n## 输出样例\n\n```text\n6\n```\n\n内联数据：`N = 3`\n\n```input1\n2 \n1 2\n```\n```output1\n3  \n```';
const beginAt = new Date().toISOString(), endAt = new Date(Date.now() + 3_600_000).toISOString();
await page.route('**/api/client/**', async route => {
  const pathname = new URL(route.request().url()).pathname;
  const session = { status: 'IN_EXAM', startedAt: beginAt, effectiveEndAt: endAt, canSubmit: true, canViewSubmissions: true };
  const data = pathname === '/api/client/contest' ? {
    revision: 'copy-test', session, user: { uid: 'qa', username: 'qa', displayName: '测试考生' },
    contest: { id: 'copy-test', title: '题面复制验证', rule: 'ioi', sourceRule: 'IOI', content: '', beginAt, endAt, langs: [{ id: 'cpp', name: 'C++' }] },
    problems: [{ index: 'A', pid: 1, title: '题面复制验证', score: 100, content, problemType: 'default', languages: ['cpp'] }], files: [], submissions: [],
  } : pathname === '/api/client/contest/state' ? { revision: 'copy-test', session }
    : pathname.endsWith('/submissions') ? [] : { questions: [], announcements: [] };
  await route.fulfill({ json: { ok: true, data } });
});

try {
  await page.goto(`${base}/contest/problems/1?apiBase=${encodeURIComponent(base)}&sessionId=qa&sessionToken=qa-token`);
  const blocks = page.locator('.candidate-problem-statement .code-preview-shell');
  await blocks.nth(3).waitFor();
  assert.equal(await blocks.count(), 4);
  for (const [index, expected] of ['3\n1  2\t3', '6', '2 \n1 2', '3  '].entries()) {
    await blocks.nth(index).getByRole('button', { name: '复制', exact: true }).click();
    await blocks.nth(index).getByRole('button', { name: '已复制', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected, 'copy contains only sample data, preserving whitespace');
  }
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Simulated clipboard permission rejection'); }; });
  await blocks.nth(0).getByRole('button', { name: '复制', exact: true }).click();
  await blocks.nth(0).getByRole('button', { name: '已复制', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '3\n1  2\t3', 'legacy copy works when Clipboard API rejects');
  const inline = page.locator('.candidate-problem-statement .hydro-inline-code');
  assert.equal(await inline.evaluate(element => {
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }), false, 'inline problem data allows normal copying');
  assert.deepEqual(errors, []);
  console.log('PASS: Markdown and Hydro input/output copy buttons; exact whitespace; no line numbers; legacy clipboard fallback; inline copying.');
} finally { await browser.close(); }
