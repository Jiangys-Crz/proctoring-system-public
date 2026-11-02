import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statementAttachmentHref, statementDownloadTarget, sanitizeStatementHtml } from '@cwnupaa/proctor-shared';
import { attachmentDisposition, fetchStatementDownload, statementContainsLink } from '../src/lib/statement-download';

test('Hydro, relative and HTTP download links retain filenames while ordinary links remain references', () => {
  for (const href of ['file://data.zip', 'data.zip', './data.zip', '/d/Problems/p/42/file/data.zip', 'https://judge.example.test/d/Problems/p/42/file/data.zip']) {
    assert.deepEqual(statementDownloadTarget(href), { name: 'data.zip' });
  }
  assert.deepEqual(statementDownloadTarget('file://%E6%A0%B7%E4%BE%8B%20%E6%95%B0%E6%8D%AE.zip'), { name: '样例 数据.zip' });
  const url = 'https://storage.example.test/download/data.zip?signature=value';
  assert.deepEqual(statementDownloadTarget(url), { name: 'data.zip', url });
  for (const href of ['#input', 'https://example.test/help', '/contest/problems/42', 'mailto:test@example.test', 'javascript:alert(1)', 'file:///etc/passwd', 'file://%2Fetc%2Fpasswd', '//evil.example.test/file.zip', 'file://..', 'file://bad%00.zip']) assert.equal(statementDownloadTarget(href), null);
});

test('HTML and Markdown attachment links can be rewritten before URL sanitization without enabling executable schemes', () => {
  const safe = sanitizeStatementHtml('<a href="file://data.zip" onclick="steal()">下载</a><a href="javascript:alert(1)">坏链接</a>', {
    rewriteLinkUrl: href => statementAttachmentHref(href, '42'),
  });
  assert.match(safe, /href="\/api\/problems\/42\/file\/data.zip\?download=1"/);
  assert.doesNotMatch(safe, /file:|javascript:|onclick/);
  assert.match(attachmentDisposition('样例 数据.zip'), /filename\*=UTF-8''/);
  assert.doesNotMatch(attachmentDisposition('a\r\nb.zip'), /[\r\n]/);
});

test('declared links include HTML, reference Markdown, autolinks and translated statements', () => {
  const url = 'https://judge.example.test/file/data.zip?x=1&y=2';
  for (const content of [`[下载](${url})`, `[下载][data]\n\n[data]: ${url}`, `<${url}>`, `<a href="${url.replace('&', '&amp;')}">下载</a>`, JSON.stringify({ 'zh-CN': `[下载](${url})` })]) {
    assert.equal(statementContainsLink(content, url), true);
  }
  assert.equal(statementContainsLink('https://judge.example.test/file/other.zip', url), false);
  assert.equal(statementContainsLink(`\`[download](${url})\``, url), false);
});

test('remote downloads require a declared link and approved origin and never forward session credentials or follow redirects', async t => {
  const url = 'https://judge.example.test/file/data.zip';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal([...new Headers(init.headers)].length, 0);
    return new Response('fixture-file', { headers: { 'content-type': 'application/zip' } });
  });
  await assert.rejects(fetchStatementDownload('', url, 'https://judge.example.test'), /不属于/);
  await assert.rejects(fetchStatementDownload('[x](http://127.0.0.1/private.zip)', 'http://127.0.0.1/private.zip', 'https://judge.example.test'), /允许的来源/);
  assert.equal(calls, 0);
  const result = await fetchStatementDownload(`[下载](${url})`, url, 'https://judge.example.test');
  assert.equal(await result.text(), 'fixture-file'); assert.equal(calls, 1);
});
