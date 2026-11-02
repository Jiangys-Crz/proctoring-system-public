import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/db';
import { publicTestProblemId } from '../src/lib/public-test-config';
import { syncPublicTestProblem, publicTestJudgeProblem } from '../src/lib/public-test-judge';
import { requestHydroLanguages } from '../src/lib/hydro-contest';
import { serializeLocalContest } from '../src/lib/local-contest';
import { judgeLanguageList } from '../../../hydro-plugin/cwnupaa-proctor-auth/judge-language-list';

function configure(t: TestContext, value?: string) {
  const old = process.env.PUBLIC_TEST_PROBLEM_ID;
  if (value === undefined) delete process.env.PUBLIC_TEST_PROBLEM_ID;
  else process.env.PUBLIC_TEST_PROBLEM_ID = value;
  t.after(() => { if (old === undefined) delete process.env.PUBLIC_TEST_PROBLEM_ID; else process.env.PUBLIC_TEST_PROBLEM_ID = old; });
}

const problem = { id: '42', pid: 'A1', title: 'Configured exercise', content: 'Use the configured statement.', html: false,
  config: { type: 'default', time: '2s', memory: '128m', langs: ['cc.cc17o2', 'py3'] }, files: [], tags: [], difficulty: 0, score: 100 };

function fixture(t: TestContext, examId: string, remote = problem) {
  const calls: string[] = [], writes: any[] = [];
  function replace(target: object, key: string, implementation: unknown) {
    const record = target as Record<string, unknown>;
    const original = record[key]; record[key] = implementation;
    t.after(() => { record[key] = original; });
  }
  replace(prisma.systemSetting, 'findUnique', async ({ where }: any) => ({ value: where.key === 'hydro'
    ? { baseUrl: 'https://judge.example.org', apiKey: examId, problemDomainId: 'Problems' } : { examId } }));
  replace(prisma.examProblem, 'upsert', async (input: any) => {
    writes.push(input);
    return { id: 'permanent-local-row', ...input.create };
  });
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path === '/api/proctor/problems') {
      const { query } = JSON.parse(init.body);
      return Response.json({ ok: true, data: [{ ...remote, pid: `${query}-partial`, id: '100' }, ...(remote.pid === query ? [remote] : [])] });
    }
    if (path === `/api/proctor/problem/${remote.id}`) return Response.json({ ok: true, data: remote });
    if (path === '/api/proctor/languages') return Response.json({ ok: true, data: judgeLanguageList({ 'cc.cc17o2': { display: 'C++17' }, py3: { display: 'Python 3' }, java17: {} }, [{}]) });
    throw new Error(`Unexpected remote write or request: ${path}`);
  });
  return { calls, writes };
}

test('test problem defaults to A1, trims configured IDs and rejects path-like values', t => {
  configure(t);
  assert.equal(publicTestProblemId(), 'A1');
  for (const [value, expected] of [['', 'A1'], ['  ', 'A1'], [' B2 ', 'B2'], ['123', '123']]) {
    process.env.PUBLIC_TEST_PROBLEM_ID = value; assert.equal(publicTestProblemId(), expected);
  }
  for (const value of ['../A1', 'A1/subpath', 'A 1', 'a'.repeat(101)]) {
    process.env.PUBLIC_TEST_PROBLEM_ID = value; assert.throws(publicTestProblemId, /配置无效/);
  }
});

test('default A1 resolves by exact PID, synchronizes metadata and shares concurrent reads without creating a Hydro problem', async t => {
  configure(t);
  const f = fixture(t, 'default-test');
  const [a, b] = await Promise.all([syncPublicTestProblem('default-test'), syncPublicTestProblem('default-test')]);
  assert.equal(a, b); assert.equal(a.hydroProblemId, '42'); assert.equal(a.title, problem.title);
  assert.equal(a.content, problem.content); assert.equal(a.timeLimitMs, 2000); assert.equal(a.memoryLimitMb, 128);
  assert.deepEqual(a.languages, problem.config.langs);
  assert.equal(await publicTestJudgeProblem('default-test'), 42);
  assert.deepEqual(f.calls, ['/api/proctor/problems', '/api/proctor/problem/42']);
  assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0].where, { examId_order: { examId: 'default-test', order: 0 } });
});

test('a new configured PID replaces the test cache and numeric docIds also work', async t => {
  configure(t, 'B2');
  const f = fixture(t, 'configured-test', { ...problem, pid: 'B2' });
  assert.equal((await syncPublicTestProblem('configured-test')).hydroProblemId, '42');
  process.env.PUBLIC_TEST_PROBLEM_ID = '42';
  assert.equal(await publicTestJudgeProblem('configured-test'), 42);
  assert.equal(f.writes.length, 2);
});

test('missing IDs never use partial matches and failed lookups can be retried', async t => {
  configure(t, 'MISSING'); const f = fixture(t, 'missing-test');
  await assert.rejects(syncPublicTestProblem('missing-test'), /不存在/);
  await assert.rejects(syncPublicTestProblem('missing-test'), /不存在/);
  assert.equal(f.calls.length, 2); assert.equal(f.writes.length, 0);
});

test('test setup rejects non-programming problems and cannot modify a formal exam', async t => {
  configure(t); const f = fixture(t, 'objective-test', { ...problem, config: { ...problem.config, type: 'objective' } });
  await assert.rejects(syncPublicTestProblem('formal-exam'), /不是系统测试考试/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(syncPublicTestProblem('objective-test'), /编程题/); assert.equal(f.writes.length, 0);
});

test('missing compiler-version reports retain enabled languages while explicit compiler failures and disabled languages are excluded', () => {
  const languages = { cpp: { display: 'C++' }, py3: {}, java17: { disabled: true }, _: {} };
  for (const reports of [[], [{}], [null, [], 'invalid'], [{ cpp: '' }]]) {
    assert.deepEqual(judgeLanguageList(languages, reports).map(language => language.id), ['cpp', 'py3']);
  }
  assert.deepEqual(judgeLanguageList(languages, [{ cpp: 'execve: no such file', py3: 'Python 3.12' }]).map(language => language.id), ['py3']);
  assert.deepEqual(judgeLanguageList(languages, [{ cpp: 'not found' }, { cpp: 'g++ 14' }]).map(language => language.id), ['cpp', 'py3']);
});

test('test contest presents real enabled language versions and applies the configured problem restrictions', async t => {
  configure(t); fixture(t, 'languages-test');
  const [saved, languages] = await Promise.all([syncPublicTestProblem('languages-test'), requestHydroLanguages()]);
  const now = new Date();
  const contest = serializeLocalContest({
    exam: { id: 'languages-test', name: 'Test', contestRule: 'IOI', contestType: 'INDIVIDUAL', flexible: true,
      startAt: new Date(+now - 1000), latestStartAt: new Date(+now + 60_000), endAt: new Date(+now + 60_000), durationMinutes: 30,
      allowedLanguages: [], showObjectiveScore: true, showTestCaseCount: true, problems: [saved] } as any,
    candidate: { id: 'candidate', examNumber: 'TEST', startedAt: now } as any,
    session: { id: 'session', status: 'IN_EXAM', startedAt: now, lockdown: false, lockdownReason: null, latestStartAt: new Date(+now + 60_000) },
    languages, submissions: [],
  });
  assert.deepEqual(contest.contest.langs.map(language => language.id), ['cc.cc17o2', 'py3']);
  assert.deepEqual(contest.problems[0].languages, ['cc.cc17o2', 'py3']);
  assert.equal(contest.problems[0].pid, 42); assert.equal(contest.problems[0].content, problem.content);
});
