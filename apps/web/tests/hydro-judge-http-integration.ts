// Only an isolated production web server / fixture MySQL. The judge is a local HTTP stub.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { createClientSessionToken } from '../src/lib/client-auth';
import { enrollPublicTest } from '../src/lib/public-test';
import { publicTestProblemId } from '../src/lib/public-test-config';

if (!process.env.DATABASE_URL?.includes('proctor_association_qa')) throw new Error('Use the isolated fixture database.');
const base = process.env.PROCTOR_ASSOCIATION_HTTP_BASE || 'http://localhost:4141';
const marker = randomUUID();
const languages = ['c.c11', 'cc.cc20o2', 'py3', 'py.pypy3', 'java17', 'js', 'rs', 'go'].map(id => ({ id, name: id === 'py3' ? 'Python 3.12' : id }));
const requests: Array<{ path: string; body: any; headers: object }> = [];
const records = new Map<string, any>();
const mock = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); const path = request.url || '';
    assert.equal(request.headers['x-proctor-api-key'], 'fixture-api-key');
    assert.equal(request.headers['x-proctor-signature'], undefined);
    assert.equal(request.headers['x-proctor-timestamp'], undefined);
    requests.push({ path, body, headers: request.headers });
    let data: any;
    if (path.endsWith('/languages')) data = languages;
    else if (path.endsWith('/judge')) {
      assert.deepEqual(Object.keys(body).sort(), ['code', 'lang', 'pid']);
      assert.equal(body.lang, 'py3');
      const id = randomBytes(12).toString('hex');
      data = { id, pid: body.pid, lang: body.lang, code: body.code, status: 1, statusText: 'Accepted', score: 100, time: 2, memory: 1024,
        testCases: [{ status: 1 }], subtasks: {}, judgeAt: new Date().toISOString(), createdAt: new Date().toISOString() };
      records.set(id, data);
    } else if (path.endsWith('/judge-status')) data = body.ids.map((id: string) => records.get(id));
    else if (path.includes('/judge/')) data = records.get(path.split('/').pop() || '');
    else if (path.endsWith('/problems')) data = [{ id: '7', pid: publicTestProblemId(), title: 'A+B', config: {} }];
    else if (path.endsWith('/problem/7')) data = { id: '7', pid: 'P7', title: 'Python 试运行', content: 'A+B', config: { type: 'default' }, tags: [], files: [] };
    else throw new Error(`Unexpected endpoint ${path}`);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, data }));
  } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ ok: false, message: String(error) })); }
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address(); assert.ok(address && typeof address === 'object');
const setting = await prisma.systemSetting.findUnique({ where: { key: 'hydro' } });
const examIds: string[] = [], userIds: string[] = [], candidateIds: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function http(path: string, method: string, body?: object, headers: object = {}) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); assert.ok(response.ok && result.ok, JSON.stringify(result)); return result.data;
}
try {
  await prisma.systemSetting.upsert({ where: { key: 'hydro' }, create: { key: 'hydro', value: {} }, update: {} });
  await prisma.systemSetting.update({ where: { key: 'hydro' }, data: { value: { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-api-key', problemDomainId: 'Problems', sharedSecret: '', judgeUsername: '', judgePassword: '' } } });
  const admin = await prisma.user.create({ data: { username: `judge-${marker}`, realName: '甲', numberId: marker, role: 'SUPER_ADMIN' } }); userIds.push(admin.id);
  const other = await prisma.user.create({ data: { username: `other-${marker}`, realName: '乙', numberId: marker, role: 'SUPER_ADMIN' } }); userIds.push(other.id);
  const cookie = { cookie: `cwnupaa_proctor_session=${createSessionToken(admin)}` };
  assert.deepEqual((await http('/api/hydro/languages', 'GET', undefined, cookie)).map((item: any) => item.id), languages.map(item => item.id));
  const code = 'a,b=map(int,input().split())\nprint(a+b)';
  const trial = await http('/api/problems/7', 'POST', { lang: 'py3', code }, cookie);
  assert.equal(trial.status, 1); assert.equal(trial.lang, 'py3'); assert.equal(trial.recordExamId, null);
  const otherRecords = await http('/api/problems/7/records', 'GET', undefined, { cookie: `cwnupaa_proctor_session=${createSessionToken(other)}` });
  assert.equal(otherRecords.length, 0, 'same student ID must not share source records');
  const now = new Date();
  const formal = await prisma.exam.create({ data: { examCode: randomBytes(5).toString('hex'), name: 'Judge fixture', startAt: new Date(+now - 60_000), latestStartAt: new Date(+now + 60_000), endAt: new Date(+now + 3600_000), durationMinutes: 60, platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: 'local', contestType: 'INDIVIDUAL', contestRule: 'IOI', published: true, rules: '', problems: { create: { order: 0, hydroProblemId: '7', hydroDomain: 'Problems', title: 'A+B', problemType: 'default', content: 'A+B', timeLimitMs: 1000, memoryLimitMb: 256 } } } }); examIds.push(formal.id);
  const formalCandidate = await prisma.candidate.create({ data: { examId: formal.id, name: 'Fixture student', examNumber: marker, password: 'fixture', seatNo: '1', startedAt: now, status: 'APPROVED' } }); candidateIds.push(formalCandidate.id);
  const publicAccount = await enrollPublicTest(BigInt('0x' + randomBytes(6).toString('hex')).toString(), 'secondCamera');
  const publicCandidate = await prisma.candidate.findFirstOrThrow({ where: { exam: { examCode: publicAccount.examCode }, examNumber: publicAccount.examNumber } }); candidateIds.push(publicCandidate.id);
  for (const candidate of [formalCandidate, publicCandidate]) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { startedAt: now, status: 'APPROVED' } });
    const token = createClientSessionToken();
    const session = await prisma.clientSession.create({ data: { examId: candidate.examId, candidateId: candidate.id, desktopTokenHash: token.tokenHash, status: 'IN_EXAM', startedAt: now } });
    const headers = { 'x-proctor-session-token': token.token };
    const contest = await http(`/api/client/contest?sessionId=${session.id}`, 'GET', undefined, headers);
    assert.deepEqual(contest.contest.langs.map((item: any) => item.id), languages.map(item => item.id));
    assert.ok(contest.problems[0].languages.includes('py3'));
    const result = await http('/api/client/contest/submit', 'POST', { sessionId: session.id, pid: contest.problems[0].pid, lang: 'py3', code }, headers);
    for (let index = 0; index < 40; index++) {
      const saved = await prisma.contestSubmission.findUniqueOrThrow({ where: { id: result.submissionId } });
      if (saved.judgeAt) { assert.equal(saved.status, 1); assert.equal(saved.lang, 'py3'); break; }
      if (index === 39) assert.fail(saved.judgeError || 'Judge timeout');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const denied = await fetch(base + '/api/client/contest/submit', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, pid: contest.problems[0].pid, lang: 'python', code }) });
    assert.equal(denied.status, 400, 'new clients must send actual language IDs');
  }
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(admin), url: base }]);
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/dashboard/problems/7/submit');
  await page.getByRole('option', { name: 'Python 3.12 (py3)', exact: true }).waitFor({ state: 'attached' });
  assert.deepEqual(await page.locator('optgroup').evaluateAll(groups => groups.map(group => group.getAttribute('label'))), ['C', 'C++', 'Python', 'Java', 'JavaScript', 'Rust', 'Go']);
  await page.goto(base + '/dashboard/exams/new');
  await page.getByText('Rust', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.getByText('Go', { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: API-Key-only trial/public/formal Python submission HTTP flows, actual language IDs, all enabled families, browser trial/version and exam restriction selectors, isolated local ownership. Judge is an HTTP stub, not production Judger.');
} finally {
  await browser?.close();
  await prisma.candidate.deleteMany({ where: { id: { in: candidateIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  await prisma.problemSubmission.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (setting) await prisma.systemSetting.update({ where: { key: 'hydro' }, data: { value: setting.value as any } });
  else await prisma.systemSetting.deleteMany({ where: { key: 'hydro' } });
  await new Promise<void>(resolve => mock.close(() => resolve()));
  await prisma.$disconnect();
}
