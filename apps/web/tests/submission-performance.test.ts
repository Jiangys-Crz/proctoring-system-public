import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { syncContestSubmissionStatuses } from '../src/lib/contest-submission-sync';
import { POST as submissions } from '../src/app/api/client/contest/submissions/route';
import { POST as leaderboard } from '../src/app/api/client/contest/leaderboard/route';

const token = createClientSessionToken();
const exam = { id: 'exam', published: true, platformContestId: 'local', contestRule: 'IOI',
  startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 3600_000),
  showObjectiveScore: true, showTestCaseCount: true,
  problems: [{ id: 'problem', order: 0, title: 'A', problemType: 'default', scorePercent: 100, score: 100, hydroScore: 100 }] };
const session = { id: 'session', examId: exam.id, candidateId: 'owner', status: 'IN_EXAM',
  desktopTokenHash: token.tokenHash, revokedAt: null, exam, candidate: { id: 'owner', startedAt: null } };
const row = { id: 'submission', candidateId: 'owner', actorKey: 'actor', problemId: 'problem',
  status: 22, statusText: 'Waiting', score: 0, totalTestCases: 0, passedTestCases: 0,
  time: 0, memory: 0, code: 'secret code', lang: 'cpp', testCases: [], subtasks: {},
  createdAt: new Date(), hydroRecordId: 'remote', judgeAt: null, deferredJudge: true,
  judgeClaimedAt: null, judgeError: null };
const remote = { id: 'remote', pid: 1, lang: 'cpp', code: 'secret code', status: 22, statusText: 'Waiting',
  score: 0, time: 0, memory: 0, testCases: [], subtasks: {}, judgeAt: null, createdAt: row.createdAt.toISOString() };

function replace(t: TestContext, target: object, key: string, implementation: unknown) {
  const record = target as Record<string, unknown>;
  const original = record[key];
  record[key] = implementation;
  t.after(() => { record[key] = original; });
}

function settings(t: TestContext) {
  replace(t, prisma.systemSetting, 'findUnique', async ({ where }: any) => where.key === 'hydro'
    ? { value: { baseUrl: 'https://judge.example.org', apiKey: 'test-only', problemDomainId: 'Problems' } }
    : null);
}

function request(auth = token.token, input: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/client/contest/submissions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proctor-session-token': auth },
    body: JSON.stringify({ sessionId: session.id, ...input }) });
}

test('30 simultaneous history polls read local results without Hydro calls or database writes', async t => {
  settings(t);
  const queries: any[] = [];
  const authentication: any[] = [];
  replace(t, prisma.clientSession, 'findUnique', async (query: any) => {
    authentication.push(query);
    return { ...session, exam: { ...exam, contestRule: 'KS' } };
  });
  replace(t, prisma.contestSubmission, 'findMany', async (query: any) => { queries.push(query); return [row]; });
  replace(t, prisma.contestSubmission, 'updateMany', async () => { assert.fail('history poll must never write'); });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('history poll must not wait for Hydro'); });
  const responses = await Promise.all(Array.from({ length: 30 }, () => submissions(request())));
  assert.equal(queries.length, 30, 'private history is fetched exactly once per poll');
  for (const response of responses) {
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data[0].code, row.code);
    assert.equal(data[0].canViewDetail, true);
    assert.equal(data[0].score, null, 'KS score visibility remains enforced');
  }
  assert.ok(queries.every(query => query.where.candidateId === 'owner'));
  assert.ok(authentication.every(query => query.include.exam.include.problems.select.content === undefined));
  assert.ok(authentication.every(query => query.include.exam.include.problems.select.config === undefined));
  assert.equal(authentication.length, 30, 'every poll still validates fresh session/token state');
});

test('default history never loads or exposes other candidates for any scoring rule', async t => {
  settings(t);
  let contestRule = 'IOI';
  replace(t, prisma.clientSession, 'findUnique', async () => ({ ...session, exam: { ...exam, contestRule } }));
  replace(t, prisma.contestSubmission, 'findMany', async (query: any) => {
    assert.deepEqual(query.where, { examId: exam.id, candidateId: 'owner' });
    return [row];
  });
  replace(t, prisma.candidate, 'findMany', async () => { assert.fail('private history must not scan other candidates'); });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('unexpected remote call'); });
  for (contestRule of ['IOI', 'OI', 'XCPC', 'ACM', 'GPLT', 'LANQIAO', 'KS']) {
    const response = await submissions(request());
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].id, row.id);
    assert.equal(data[0].canViewDetail, true);
    assert.equal(data[0].isOwn, true);
  }
});

test('revoked and invalid tokens cannot query history after a successful poll', async t => {
  settings(t);
  let revoked = false;
  replace(t, prisma.clientSession, 'findUnique', async () => ({ ...session, revokedAt: revoked ? new Date() : null }));
  let reads = 0;
  replace(t, prisma.contestSubmission, 'findMany', async () => { reads++; return []; });
  assert.equal((await submissions(request())).status, 200);
  const before = reads;
  revoked = true;
  assert.equal((await submissions(request())).status, 401);
  revoked = false;
  assert.equal((await submissions(request('wrong-token'))).status, 401);
  assert.equal(reads, before);
});

test('leaderboards query scoring fields without reading source code or identity credentials', async t => {
  settings(t);
  replace(t, prisma.clientSession, 'findUnique', async () => session);
  replace(t, prisma.candidate, 'findMany', async (query: any) => {
    assert.equal(query.select.password, undefined);
    return [{ id: 'owner', examNumber: '001', name: 'Owner', teamName: null }];
  });
  replace(t, prisma.contestSubmission, 'findMany', async (query: any) => {
    assert.equal(query.select.code, undefined);
    assert.equal(query.select.testCases, undefined);
    return [{ ...row, status: 1, score: 100 }];
  });
  const response = await leaderboard(request());
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.rows[0].score, 100);
});

test('candidate history and leaderboard APIs preserve percentages for non-100 Hydro problems', async t => {
  settings(t);
  const weightedExam = { ...exam, problems: [{ ...exam.problems[0], hydroScore: 75, scorePercent: 25, score: 25 }] };
  replace(t, prisma.clientSession, 'findUnique', async (query: any) => {
    assert.equal(query.include.exam.include.problems.select.scorePercent, true);
    return { ...session, exam: weightedExam };
  });
  replace(t, prisma.candidate, 'findMany', async () => [{ id: 'owner', examNumber: '001', name: 'Owner', teamName: null }]);
  replace(t, prisma.contestSubmission, 'findMany', async () => [{ ...row, status: 2, score: 68 }]);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('score reads must use the stored Hydro points'); });
  const history = await submissions(request());
  const board = await leaderboard(request());
  assert.equal(history.status, 200);
  assert.equal(board.status, 200);
  assert.equal((await history.json()).data[0].score, 22.67);
  const ranked = (await board.json()).data.rows[0];
  assert.equal(ranked.score, 22.67);
  assert.deepEqual(ranked.problemScores, [22.67]);
});

test('30 overlapping leaderboard polls share database reads and still authenticate every caller', async t => {
  settings(t);
  let authentications = 0, candidateReads = 0, submissionReads = 0, score = 25;
  replace(t, prisma.clientSession, 'findUnique', async () => { authentications++; return session; });
  replace(t, prisma.candidate, 'findMany', async () => {
    candidateReads++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return [{ id: 'owner', examNumber: '001', name: 'Owner', teamName: null }];
  });
  replace(t, prisma.contestSubmission, 'findMany', async () => {
    submissionReads++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return [{ ...row, status: 2, score }];
  });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('leaderboard must never wait on Hydro'); });
  const responses = await Promise.all(Array.from({ length: 30 }, () => leaderboard(request())));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.rows[0].score, 25);
  }
  assert.equal(authentications, 30);
  assert.equal(candidateReads, 1);
  assert.equal(submissionReads, 1);
  score = 75;
  const next = await leaderboard(request());
  assert.equal((await next.json()).data.rows[0].score, 75, 'finished results are not cached');
  assert.equal(candidateReads, 2);
  assert.equal(submissionReads, 2);
});

test('shared leaderboard inputs do not share snapshots, freeze state or objective visibility', async t => {
  settings(t);
  const startAt = new Date(Date.now() - 120_000);
  const at = (seconds: number) => new Date(+startAt + seconds * 1000);
  const frozenExam = { ...exam, contestRule: 'XCPC', startAt, scoreboardFrozenAt: at(30),
    problems: [...exam.problems, { ...exam.problems[0], id: 'objective', order: 1, problemType: 'objective' }] };
  replace(t, prisma.clientSession, 'findUnique', async ({ where }: any) => ({ ...session,
    exam: { ...frozenExam, showObjectiveScore: where.id === 'shown' } }));
  let reads = 0;
  replace(t, prisma.candidate, 'findMany', async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return [{ id: 'owner', examNumber: '001', name: 'Owner', teamName: null }];
  });
  replace(t, prisma.contestSubmission, 'findMany', async () => {
    reads++;
    return [
      { ...row, id: 'late-ac', status: 1, score: 100, createdAt: at(50) },
      { ...row, id: 'objective-ac', problemId: 'objective', status: 1, score: 100, createdAt: at(15) },
    ];
  });
  const [past, hidden, shown] = await Promise.all([
    leaderboard(request(token.token, { sessionId: 'shown', timePoint: +at(10) })),
    leaderboard(request(token.token, { sessionId: 'hidden' })),
    leaderboard(request(token.token, { sessionId: 'shown' })),
  ]);
  const pastBoard = (await past.json()).data;
  const hiddenBoard = (await hidden.json()).data;
  const shownBoard = (await shown.json()).data;
  assert.equal(reads, 1);
  assert.equal(pastBoard.frozen, false);
  assert.equal(pastBoard.rows[0].solved, 0);
  assert.equal(hiddenBoard.frozen, true);
  assert.equal(hiddenBoard.rows[0].solved, 0);
  assert.equal(hiddenBoard.rows[0].cells[0].pending, 1);
  assert.equal(shownBoard.rows[0].solved, 1);
  assert.equal(shownBoard.rows[0].cells[1].firstBlood, true);
});

test('unavailable OI and pre-start snapshots skip full leaderboard scans', async t => {
  settings(t);
  let currentExam = { ...exam, contestRule: 'OI' };
  replace(t, prisma.clientSession, 'findUnique', async () => ({ ...session, exam: currentExam }));
  replace(t, prisma.candidate, 'findMany', async () => { assert.fail('hidden leaderboard must not load all candidates'); });
  replace(t, prisma.contestSubmission, 'findMany', async () => { assert.fail('hidden leaderboard must not load all submissions'); });
  assert.equal((await (await leaderboard(request())).json()).data.available, false);
  currentExam = { ...exam, contestRule: 'IOI' };
  const beforeStart = await leaderboard(request(token.token, { timePoint: +exam.startAt - 1 }));
  assert.equal((await beforeStart.json()).data.available, false);
});

test('failed leaderboard reads are released and session revocation takes effect before the next read', async t => {
  settings(t);
  let failed = true, revoked = false, reads = 0;
  replace(t, prisma.clientSession, 'findUnique', async () => ({ ...session, revokedAt: revoked ? new Date() : null }));
  replace(t, prisma.candidate, 'findMany', async () => []);
  replace(t, prisma.contestSubmission, 'findMany', async () => {
    reads++;
    if (failed) throw new Error('transient database failure');
    return [];
  });
  assert.equal((await leaderboard(request())).status, 502);
  failed = false;
  assert.equal((await leaderboard(request())).status, 200);
  assert.equal(reads, 2, 'a failed request cannot poison later polls');
  revoked = true;
  assert.equal((await leaderboard(request())).status, 401);
  assert.equal(reads, 2, 'revoked sessions never reach shared scoring data');
});

test('concurrent leaderboards from separate exams cannot share scoring inputs', async t => {
  settings(t);
  replace(t, prisma.clientSession, 'findUnique', async ({ where }: any) => ({ ...session,
    examId: where.id, exam: { ...exam, id: where.id } }));
  replace(t, prisma.candidate, 'findMany', async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return [{ id: 'owner', examNumber: '001', name: 'Owner', teamName: null }];
  });
  const scopes: string[] = [];
  replace(t, prisma.contestSubmission, 'findMany', async ({ where }: any) => {
    scopes.push(where.examId);
    return [{ ...row, status: 2, score: where.examId === 'first-exam' ? 10 : 90 }];
  });
  const responses = await Promise.all(['first-exam', 'second-exam'].map(sessionId => leaderboard(request(token.token, { sessionId }))));
  assert.deepEqual(await Promise.all(responses.map(async response => (await response.json()).data.rows[0].score)), [10, 90]);
  assert.deepEqual(scopes.sort(), ['first-exam', 'second-exam']);
});

test('30 overlapping status syncs share one Hydro batch and skip writes for unchanged results', async t => {
  settings(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return Response.json({ ok: true, data: [remote] }); });
  replace(t, prisma.contestSubmission, 'updateMany', async () => { assert.fail('unchanged pending results must not produce writes'); });
  await Promise.all(Array.from({ length: 30 }, () => syncContestSubmissionStatuses({ platformBaseUrl: 'https://judge.example.org' }, [row])));
  assert.equal(calls, 1);
});

test('changed status preserves complete results and cannot overwrite a replaced/cancelled remote record', async t => {
  settings(t);
  const result = { ...remote, status: 1, statusText: 'Accepted', score: 100, testCases: [{ status: 1 }], judgeAt: new Date().toISOString() };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, data: [result] }));
  const updates: any[] = [];
  replace(t, prisma.contestSubmission, 'updateMany', async (query: any) => { updates.push(query); return { count: 1 }; });
  await syncContestSubmissionStatuses({ platformBaseUrl: 'https://judge.example.org' }, [row]);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].where, { id: row.id, hydroRecordId: row.hydroRecordId, judgeAt: null, status: { not: 30 } });
  assert.equal(updates[0].data.passedTestCases, 1);
  assert.equal(updates[0].data.deferredJudge, false);
  assert.deepEqual(updates[0].data.testCases, result.testCases);
});

test('Hydro overload and timeouts never fan out into individual status requests', async t => {
  settings(t);
  const pending = Array.from({ length: 30 }, (_, index) => ({ ...row, id: `local-${index}`, hydroRecordId: `remote-${index}` }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ ok: false, message: 'Overloaded' }, { status: 503 }); });
  await assert.rejects(syncContestSubmissionStatuses({ platformBaseUrl: 'https://judge.example.org' }, pending), /Overloaded/);
  assert.equal(calls, 1);
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('timeout'); });
  await assert.rejects(syncContestSubmissionStatuses({ platformBaseUrl: 'https://judge.example.org' }, pending), /timeout/);
  assert.equal(calls, 2);
});

test('old Hydro plugins retain compatible status queries with at most five concurrent requests', async t => {
  settings(t);
  let active = 0, peak = 0, singleCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/judge-status')) return Response.json({ ok: false }, { status: 404 });
    active++; singleCalls++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return Response.json({ ok: true, data: { ...remote, id: path.split('/').pop() } });
  });
  replace(t, prisma.contestSubmission, 'updateMany', async () => { assert.fail('unchanged fallback results must not write'); });
  const pending = Array.from({ length: 23 }, (_, index) => ({ ...row, id: `local-${index}`, hydroRecordId: `remote-${index}` }));
  await syncContestSubmissionStatuses({ platformBaseUrl: 'https://judge.example.org' }, pending);
  assert.equal(singleCalls, 23);
  assert.equal(peak, 5);
});
