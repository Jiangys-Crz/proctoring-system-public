import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent as AdminMarkdown } from '../src/components/MarkdownComposer';
import { prisma } from '../src/lib/db';
import { hashClientSessionToken } from '../src/lib/client-auth';
import { GET } from '../src/app/api/client/contest/route';

test('exam descriptions render headings, lists, tables, math and arbitrary-site links in administrator pages', () => {
  const content = '## 考试说明\n\n**独立完成**\n\n- 请按时提交\n\n|项目|说明|\n|---|---|\n|时长|120 分钟|\n\n公式 $x^2$\n\n[参考页面](https://any.example/guide?topic=1)\n\n<script>alert(1)</script>';
  const html = renderToStaticMarkup(createElement(AdminMarkdown, { content }));
  assert.match(html, /<h2>考试说明<\/h2>/); assert.match(html, /<strong>独立完成<\/strong>/);
  assert.match(html, /<li>请按时提交<\/li>/); assert.match(html, /<table>/); assert.match(html, /class="katex"/);
  assert.match(html, /href="https:\/\/any.example\/guide\?topic=1" target="_blank" rel="noreferrer noopener"/);
  assert.doesNotMatch(html, /<script>/);
});

test('Hydro-backed exams deliver the administrator Markdown description, retaining Hydro text only when none was set', async t => {
  const now = new Date();
  const session = { id: 's', examId: 'exam', status: 'IN_EXAM', revokedAt: null, startedAt: now, desktopTokenHash: hashClientSessionToken('test-token'),
    candidate: { id: 'candidate', examNumber: 'A001', startedAt: now }, exam: { id: 'exam', rules: '## 管理员考试说明\n\n[参考](https://any.example/guide)',
      problems: [], contestRule: 'IOI', platformContestId: 'hydro-contest', platformBaseUrl: 'https://judge.example', contestType: 'INDIVIDUAL',
      startAt: new Date(+now - 60000), latestStartAt: new Date(+now + 600000), endAt: new Date(+now + 3600000), durationMinutes: 60 } };
  const replace = (target: object, key: string, implementation: unknown) => {
    const object = target as Record<string, unknown>, previous = object[key]; object[key] = implementation; t.after(() => { object[key] = previous; });
  };
  replace(prisma.clientSession, 'findUnique', async () => session);
  replace(prisma.candidate, 'count', async () => 1);
  replace(prisma.examRoom, 'findFirst', async () => null);
  replace(prisma.systemSetting, 'findUnique', async ({ where }: { where: { key: string } }) => where.key === 'public-test.exam.v1' ? null
    : { value: { baseUrl: 'https://judge.example', apiKey: 'fixture-key', problemDomainId: 'Problems', judgeUsername: 'judge' } });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, data: {
    contest: { content: 'Hydro 原说明', endAt: session.exam.endAt.toISOString() }, files: [], problems: [],
  } }));
  const request = () => new Request('https://client.example/api/client/contest?sessionId=s', { headers: { 'x-proctor-session-token': 'test-token' } });
  const response = await GET(request()); assert.equal(response.status, 200);
  assert.equal((await response.json()).data.contest.content, session.exam.rules);
  session.exam.rules = '   ';
  const fallback = await GET(request()); assert.equal(fallback.status, 200);
  assert.equal((await fallback.json()).data.contest.content, 'Hydro 原说明');
});
