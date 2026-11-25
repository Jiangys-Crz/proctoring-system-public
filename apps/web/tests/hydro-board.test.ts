import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readHydroBoardPage, HydroBoardError } from '../src/lib/hydro-board';
import { normalizeExamSettings } from '../src/lib/exam-settings';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';

const tid = '691000000000000000000001';
const exam = { id: 'exam-hydro', platformBaseUrl: 'https://hydro.example/d/xcpc', platformContestId: tid,
  startAt: new Date('2026-11-09T00:00:00Z'), endAt: new Date('2026-11-10T00:00:00Z') };
const connection = { baseUrl: 'https://hydro.example', apiKey: 'source-secret' };
const row = (n: number, status = 1) => ({ id: `6af00000${n.toString(16).padStart(16, '0')}`, username: 'team01', problemId: '9',
  status, score: 200, language: 'cpp', code: '// source', runtime: 12, memory: 4096, createdAt: '2026-11-09T03:00:01.000Z' });
const data = () => ({ contestId: tid, rule: 'acm', problems: [9, 10].map((pid, i) => ({ id: String(pid), label: i ? 'B' : 'A',
  title: 'Same title', score: 100, hydroScore: 200, timeLimitMs: 1000, memoryLimitMb: 256 })), records: [row(1)], nextAfter: null as string | null });
const read = (after: string | null = null) => readHydroBoardPage(exam, connection, { after, until: exam.endAt }, new Set(['team01']), new AbortController().signal);

test('Hydro browser exams support the existing opt-in external-board configuration', () => {
  const input = CreateExamSchema.parse({ name: 'Hydro', platform: 'HYDRO_BROWSER', platformBaseUrl: exam.platformBaseUrl,
    platformContestId: tid, contestRule: 'XCPC', contestType: 'INDIVIDUAL', startAt: exam.startAt, latestStartAt: exam.startAt,
    endAt: exam.endAt, durationMinutes: 180, externalBoardEventId: '123' });
  assert.equal(normalizeExamSettings(input).externalBoardEnabled, false);
  assert.equal(normalizeExamSettings({ ...input, externalBoardEnabled: true }).externalBoardEnabled, true);
  assert.throws(() => normalizeExamSettings({ ...input, externalBoardEnabled: true, externalBoardEventId: null }), /赛事 ID/);
});

test('Hydro reveal requests the metadata-only broadcast and the legacy export strips submission code', async t => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    requests.push(body);
    const page = { ...data(), records: [row(1), { ...row(2), username: 'other' }],
      ...(body.broadcast ? { broadcast: { frozenAt: null } } : {}) };
    return Response.json({ ok: true, data: page });
  });
  const cursor = { after: null, until: exam.endAt };
  const usernames = new Set(['team01']);
  const signal = new AbortController().signal;
  const direct = await readHydroBoardPage(exam, connection, cursor, usernames, signal, 'revealed-broadcast');
  assert.equal(requests[0].broadcast, true);
  assert.equal(requests[0].reveal, true);
  assert.equal(direct.broadcastPage?.broadcast?.frozenAt, null);
  const legacy = await readHydroBoardPage(exam, connection, cursor, usernames, signal, 'export-metadata');
  assert.equal(requests[1].broadcast, undefined);
  assert.equal(requests[1].reveal, undefined);
  assert.deepEqual(legacy.submissionMetadata, [{ id: row(1).id, username: 'team01', problemId: '9', status: 1, score: 200, createdAt: row(1).createdAt, language: 'cpp' }]);
  assert.doesNotMatch(JSON.stringify(legacy), /\/\/ source/);
});
test('domain routing, API key, identical titles, units, Beijing timestamps and stable rejudge IDs', async t => {
  let page = data();
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, `https://hydro.example/d/xcpc/api/proctor/board-contest/${tid}`);
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    assert.equal(new Headers(options.headers).get('x-proctor-api-key'), connection.apiKey);
    assert.deepEqual(JSON.parse(String(options.body)).usernames, ['team01']);
    return Response.json({ ok: true, data: page });
  });
  page.records.push({ ...row(2, 2), problemId: '10' });
  const first = await read();
  assert.deepEqual(first.records.map(r => [r.payload.problem, r.payload.score]), [['A', 100], ['B', 0]]);
  assert.equal(first.records[0].payload.raw_max_score, undefined);
  assert.equal(first.records[0].payload.submit_time, '2026-11-09 11:00:01');
  assert.equal(first.records[0].payload.memory, '4096'); assert.equal(first.records[0].payload.code, '// source');
  const rid = first.records[0].payload.rid;
  page.records[0].status = 2;
  assert.equal((await read()).records[0].payload.rid, rid);
  assert.equal((await read()).records[0].payload.status, 'Wrong Answer');
  page = { ...page, rule: 'oi' }; page.records[0].score = 50;
  page.problems[0].score = 125;
  page.problems[0].hydroScore = 400;
  const weighted = await read();
  assert.equal(weighted.problems[0].score, 125);
  assert.deepEqual([weighted.records[0].payload.score, weighted.records[0].payload.raw_score, weighted.records[0].payload.raw_max_score],
    [13, 50, 400]);
});
test('only judged in-window roster records are exported and ignored verdicts neutralize previous AC', async t => {
  const page = data();
  page.records = [0, 1, 2, 7, 9, 20, 22, 30, 31].map((status, i) => row(i + 1, status));
  page.records.push({ ...row(10), username: 'outside' }, { ...row(11), createdAt: '2026-11-08T23:59:59.000Z' },
    { ...row(12), createdAt: exam.endAt.toISOString() });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, data: page }));
  const result = await read();
  assert.deepEqual(result.records.map(r => [r.payload.status, r.payload.score]), [['Accepted', 100], ['Wrong Answer', 0],
    ['Compile Error', 0], ['Compile Error', 0], ['Compile Error', 0], ['Compile Error', 0]]);
});
test('invalid sources cannot receive the API key; remote errors never echo secrets', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => { count++; return Response.json({ secret: connection.apiKey }, { status: 403 }); });
  await assert.rejects(readHydroBoardPage({ ...exam, platformBaseUrl: 'https://other.example' }, connection,
    { after: null, until: exam.endAt }, new Set(['team01']), new AbortController().signal), /同一站点/);
  assert.equal(count, 0);
  await assert.rejects(read(), error => error instanceof HydroBoardError && /API-Key/.test(error.message) && !error.message.includes(connection.apiKey));
});

test('an independent Hydro board uses the exam-scoped plugin key', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, `https://other-hydro.example/d/xcpc/api/proctor/board-contest/${tid}`);
    assert.equal(new Headers(options.headers).get('x-proctor-api-key'), 'exam-board-key');
    return Response.json({ ok: true, data: data() });
  });
  const result = await readHydroBoardPage({ ...exam, platformBaseUrl: 'https://other-hydro.example/d/xcpc', hydroBrowserApiKey: 'exam-board-key' },
    connection, { after: null, until: exam.endAt }, new Set(['team01']), new AbortController().signal);
  assert.equal(result.records.length, 1);
});
test('rejects mismatched contests, stuck or unordered cursors, duplicate problems and unknown verdicts', async t => {
  let page: any = data();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, data: page }));
  page.contestId = '691000000000000000000002'; await assert.rejects(read(), /不匹配/);
  page = data(); page.nextAfter = row(1).id; await assert.rejects(read(row(1).id), /分页/);
  page = data(); page.records = [row(2), row(1)]; await assert.rejects(read(), /顺序/);
  page = data(); page.problems[1].label = 'A'; await assert.rejects(read(), /重复/);
  page = data(); page.records[0].status = 999; await assert.rejects(read(), /未知/);
  page = data(); page.records = []; page.nextAfter = row(10).id;
  assert.equal((await read()).nextAfter, page.nextAfter, 'empty filtered pages still advance');
});
test('oversized responses are bounded', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(' '.repeat(5_000_001)));
  await assert.rejects(read(), /过大/);
});
