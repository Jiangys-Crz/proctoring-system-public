import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { prisma } from '../src/lib/db';
import { acceptReactionEvent } from '../src/lib/reaction-events';
import { fetchHydroReactionPage, hydroReactionEvents, hydroReactionVerdict, type HydroReactionRecord } from '../src/lib/reaction-hydro';
import { createHydroReactionPollState, pollHydroReactions } from '../src/lib/reaction-hydro-recorder';
import { hydroReactionConnection, reactionSource, sameReactionSource } from '../src/lib/reaction-source';
import { hydroCcsRankContext, parseReactionRankContext } from '../src/lib/reaction-ranking';
import { consumeHydroCcsFeed, normalizeHydroCcsEvent } from '../src/lib/reaction-hydro-ccs';
import { hydroCcsConnection } from '../src/lib/reaction-hydro-credentials';
import { eventHash } from '../src/lib/reaction-domain';
import * as ccs from './fixtures/hydro-ccs-v1';

const at = (seconds: number) => new Date(Date.parse('2026-11-09T03:00:00.000Z') + seconds * 1000);
const tid = '691000000000000000000001';
const nativeExam = { platform: 'HYDRO_BROWSER', platformBaseUrl: 'https://hydro.example/d/acm', platformContestId: tid };
const connection = { baseUrl: 'https://hydro.example', apiKey: 'test-api-key' };
const ccsEnv = { REACTION_HYDRO_CCS_ORIGIN: 'https://hydro.example', REACTION_HYDRO_CCS_API_KEY: 'standalone-read-key-'.repeat(3) };
const record = (id = '691000000000000000000002', status = 0): HydroReactionRecord => ({
  id, username: 'team01', problemId: '7', problemLabel: 'A', status, createdAt: at(10).toISOString(), judgeAt: status === 1 ? at(12).toISOString() : null,
});

function replace(t: TestContext, target: any, name: string, implementation: (...args: any[]) => any) {
  const original = target[name], mocked = t.mock.fn(implementation);
  target[name] = mocked;
  t.after(() => { target[name] = original; });
  return mocked;
}

function configureCcs(t: TestContext) {
  const original = { ...process.env };
  Object.assign(process.env, ccsEnv);
  delete process.env.REACTION_HYDRO_CCS_CREDENTIALS;
  t.after(() => { process.env = original; });
}

test('standalone CCS credentials are independent, origin-bound and fail closed on invalid overrides', () => {
  const exam = { ...nativeExam, id: 'e1' };
  assert.deepEqual(hydroCcsConnection(exam, ccsEnv), { base: nativeExam.platformBaseUrl, contestId: tid, apiKey: ccsEnv.REACTION_HYDRO_CCS_API_KEY });
  assert.throws(() => hydroCcsConnection(exam, {}), /REACTION_HYDRO_CCS_CONFIGURATION/);
  assert.throws(() => hydroCcsConnection(exam, { REACTION_CCS_USERNAME: 'admin', REACTION_CCS_PASSWORD: 'password', HYDRO_PROCTOR_API_KEY: connection.apiKey }), /CONFIGURATION/);
  for (const override of ['invalid', 'null', '[]', '{"e1":null}', '{"e1":{}}', '{"e1":{"origin":"https://elsewhere.example","apiKey":"' + 'a'.repeat(32) + '"}}']) {
    assert.throws(() => hydroCcsConnection(exam, { ...ccsEnv, REACTION_HYDRO_CCS_CREDENTIALS: override }), /CONFIGURATION/);
  }
  for (const apiKey of ['', 'short', 'a'.repeat(1025), 'a'.repeat(32) + '\n']) {
    assert.throws(() => hydroCcsConnection(exam, { ...ccsEnv, REACTION_HYDRO_CCS_API_KEY: apiKey }), /CONFIGURATION/);
  }
  for (const platformBaseUrl of ['https://elsewhere.example/d/acm', 'https://hydro.example:8443/d/acm', 'https://user:password@hydro.example', 'https://hydro.example/d/acm?x=1']) {
    assert.throws(() => hydroCcsConnection({ ...exam, platformBaseUrl }, ccsEnv), /CONFIGURATION/);
  }
  const override = { e1: { origin: 'https://hydro.example', apiKey: 'b'.repeat(32) } };
  assert.equal(hydroCcsConnection(exam, { ...ccsEnv, REACTION_HYDRO_CCS_CREDENTIALS: JSON.stringify(override) }).apiKey, 'b'.repeat(32));
  assert.equal(hydroCcsConnection({ ...exam, platformContestId: tid.toUpperCase(), platformBaseUrl: 'https://hydro.example/d/other' }, ccsEnv).base, 'https://hydro.example/d/other');
  assert.throws(() => hydroCcsConnection({ ...exam, platform: 'HYDRO', platformContestId: 'local' }, ccsEnv), /CONFIGURATION/);
});

test('Hydro sources use the existing API key and preserve domain identity', () => {
  assert.equal(reactionSource(nativeExam), 'HYDRO_CONTEST');
  assert.equal(reactionSource({ platform: 'HYDRO', platformContestId: 'local' }), 'LOCAL_HYDRO');
  assert.equal(reactionSource({ platform: 'HYDRO', platformContestId: tid }), 'HYDRO_CONTEST');
  assert.equal(hydroReactionConnection(nativeExam, connection).base, nativeExam.platformBaseUrl);
  assert.throws(() => hydroReactionConnection(nativeExam, { ...connection, apiKey: '' }), /CONFIGURATION/);
  assert.throws(() => hydroReactionConnection({ ...nativeExam, platformBaseUrl: 'https://elsewhere.example' }, connection), /CONFIGURATION/);
  assert.equal(sameReactionSource(nativeExam, { ...nativeExam, platformBaseUrl: 'https://hydro.example/d/other' }), false);
});

test('Hydro status mapping waits through compilation/judging and maps terminal results explicitly', () => {
  for (const status of [0, 20, 21, 22, 24, 30, 99]) assert.equal(hydroReactionVerdict(status), null);
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => hydroReactionVerdict(i + 1)), ['AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'CE', 'SE', 'NO', 'FAILED']);
  assert.equal(hydroReactionVerdict(11), 'HK');
  assert.equal(hydroReactionVerdict(31), 'FE');
  assert.deepEqual(hydroReactionEvents(record(undefined, 30)), [{ type: 'submissions', op: 'delete', data: { id: record().id } }]);
  const events = hydroReactionEvents(record());
  assert.equal(events[1].data?.team_id, 'team01');
  assert.equal(events[2].data?.judgement_type_id, null);
});

test('native requests are scoped, authenticated and reject failures without exposing response bodies', async t => {
  let response = Response.json({ ok: true, data: { contestId: tid, records: [record()], nextAfter: null } });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    assert.equal(url, `${nativeExam.platformBaseUrl}/api/proctor/reaction-contest/${tid}`);
    assert.equal(init.headers['x-proctor-api-key'], connection.apiKey);
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body), { since: at(0).toISOString(), after: null });
    return response;
  });
  const page = await fetchHydroReactionPage(nativeExam, connection, at(0), null, new AbortController().signal);
  assert.equal(page.records[0].username, 'team01');
  response = new Response('private upstream diagnostic', { status: 403 });
  await assert.rejects(fetchHydroReactionPage(nativeExam, connection, at(0), null, new AbortController().signal), /^Error: HYDRO_HTTP_403$/);
  response = Response.json({ ok: true, data: { contestId: 'another contest', records: [], nextAfter: null } });
  await assert.rejects(fetchHydroReactionPage(nativeExam, connection, at(0), null, new AbortController().signal), /INVALID_RECORD/);
  response = Response.json({ ok: true, data: { contestId: tid, records: [], nextAfter: record().id } });
  await assert.rejects(fetchHydroReactionPage(nativeExam, connection, at(0), null, new AbortController().signal), /INVALID_RECORD/);
  const count = fetchMock.mock.callCount();
  await assert.rejects(fetchHydroReactionPage({ ...nativeExam, platformBaseUrl: 'https://other.example' }, connection, at(0), null, new AbortController().signal));
  assert.equal(fetchMock.mock.callCount(), count, 'credentials never sent to a different origin');
});

// Exercise the production event state machine against isolated model doubles;
// these tests do not connect to MySQL, a live Hydro contest or media storage.
function models(t: TestContext, platform = 'HYDRO_BROWSER') {
  const exam: any = { ...nativeExam, id: 'exam-fixture', platform, platformContestId: platform === 'HYDRO' ? 'local' : tid,
    reactionEnabled: true, reactionConfig: { initializedAt: at(0), beforeSeconds: 3, afterSeconds: 10, retentionDays: 30, leaseToken: 'worker' } };
  const current = { ...exam, reactionConfig: { ...exam.reactionConfig } };
  const reactions = new Map<string, any>(), events = new Map<string, any>();
  const pins: string[] = [];
  const key = (where: any) => `${where.type}:${where.remoteId}`;
  const tx: any = {
    $queryRaw: async () => [],
    exam: { findUniqueOrThrow: async () => current },
    reactionConfig: { update: async ({ data }: any) => Object.assign(current.reactionConfig, data) },
    reactionEvent: {
      findUnique: async ({ where }: any) => events.get(key(where.examId_type_remoteId)) || null,
      findMany: async ({ where }: any) => [...events.values()].filter(row => row.type === where.type && (!where.payload || row.payload.x_hydro_team_id === where.payload.equals)),
      upsert: async ({ where, create, update }: any) => { const id = key(where.examId_type_remoteId); const row = events.has(id) ? { ...events.get(id), ...update } : create; events.set(id, row); return row; },
    },
    candidate: { findFirst: async ({ where }: any) => where.examNumber.toLowerCase() === 'team01' ? { id: 'candidate-1', examId: exam.id, examNumber: 'team01', teamName: 'Same display name', school: 'school', college: 'college' } : null },
    reaction: {
      findFirst: async ({ where }: any) => [...reactions.values()].find(row => row.judgementId === where.judgementId) || null,
      findUnique: async ({ where }: any) => reactions.get(where.examId_submissionId.submissionId) || null,
      findUniqueOrThrow: async ({ where }: any) => [...reactions.values()].find(row => row.id === where.id),
      create: async ({ data }: any) => { const row = { id: `r-${data.submissionId}`, verdictHistory: [], ...data }; reactions.set(data.submissionId, row); return row; },
      update: async ({ where, data }: any) => { const row = [...reactions.values()].find(row => row.id === where.id); Object.assign(row, data); return row; },
      updateMany: async ({ where, data }: any) => { for (const row of reactions.values()) if (row.problemId === where.problemId) Object.assign(row, data); return { count: 0 }; },
    },
    mediaSegment: { findMany: async () => [{ id: 'segment' }] },
    reactionSegment: { createMany: async ({ data }: any) => { pins.push(...data.map((item: any) => item.reactionId)); } },
  };
  const transaction = replace(t, prisma, '$transaction', async (callback: any) => callback(tx));
  replace(t, prisma.reaction, 'findMany', async () => [...reactions.values()]);
  replace(t, prisma.reactionEvent, 'findUnique', tx.reactionEvent.findUnique);
  replace(t, prisma.reactionEvent, 'findMany', tx.reactionEvent.findMany);
  return { exam, current, reactions, events, pins, transaction };
}

test('Hydro submissions capture before/after windows, deduplicate, preserve original rejudge verdict and never fabricate ranks', async t => {
  const { exam, current, reactions, pins } = models(t);
  for (const event of hydroReactionEvents(record())) await acceptReactionEvent(exam, event, at(11));
  const r = reactions.get(record().id);
  assert.equal(r.candidateId, 'candidate-1');
  assert.equal(r.schoolName, 'school');
  assert.equal(r.collegeName, 'college');
  assert.equal(r.status, 'PENDING');
  assert.equal(+r.windowStart, +at(7));
  assert.ok(pins.length > 0);
  for (const event of hydroReactionEvents(record(undefined, 1))) await acceptReactionEvent(exam, event, at(15));
  assert.equal(r.status, 'TAIL');
  assert.equal(+r.windowEnd, +at(25), 'tail is based on observed result, not judgeAt');
  assert.equal(+r.sourceJudgementEndAt, +at(12));
  assert.equal(parseReactionRankContext(r.rankContext)?.status, 'UNAVAILABLE');
  assert.equal(parseReactionRankContext({ ...r.rankContext, status: 'AVAILABLE', beforeRank: 2, afterRank: 1 }), null);
  for (const event of hydroReactionEvents(record(undefined, 1))) await acceptReactionEvent(exam, event, at(19));
  assert.equal(reactions.size, 1);
  assert.equal(+r.windowEnd, +at(25));
  for (const event of hydroReactionEvents({ ...record(undefined, 2), judgeAt: at(30).toISOString() })) await acceptReactionEvent(exam, event, at(31));
  assert.equal(r.originalVerdict, 'AC');
  assert.equal(r.verdict, 'WA');
  assert.equal(+r.windowEnd, +at(25));
  for (const event of hydroReactionEvents({ ...record('691000000000000000000003'), username: 'Same display name' })) await acceptReactionEvent(exam, event, at(12));
  assert.equal(reactions.get('691000000000000000000003').status, 'UNMAPPED', 'display names cannot map users');
  for (const event of hydroReactionEvents({ ...record('691000000000000000000005'), username: 'TEAM01' })) await acceptReactionEvent(exam, event, at(12));
  assert.equal(reactions.get('691000000000000000000005').status, 'UNMAPPED', 'database collation must not weaken exact account mapping');
  for (const event of hydroReactionEvents({ ...record('691000000000000000000004'), createdAt: at(-1).toISOString() })) await acceptReactionEvent(exam, event, at(12));
  assert.equal(reactions.has('691000000000000000000004'), false);
  current.reactionEnabled = false;
  await acceptReactionEvent(exam, { type: 'submissions', op: 'delete', data: { id: r.submissionId } });
  assert.equal(r.status, 'TAIL');
  current.reactionEnabled = true;
  current.reactionConfig.initializedAt = at(60);
  await acceptReactionEvent(exam, { type: 'submissions', op: 'delete', data: { id: r.submissionId } });
  assert.equal(r.status, 'TAIL', 'stale in-flight response cannot mutate a newly enabled recording session');
  current.reactionConfig.initializedAt = at(0);
  current.platformBaseUrl = 'https://hydro.example/d/other';
  await assert.rejects(acceptReactionEvent(exam, hydroReactionEvents(record())[1]), /SOURCE_CHANGED/);
});

test('local Hydro polling handles over 200 submissions, late results, restart and deletions without replay writes', async t => {
  const { exam, reactions, transaction } = models(t, 'HYDRO');
  let rows: any[] = Array.from({ length: 205 }, (_, n) => ({ id: `c${String(n).padStart(24, '0')}`, problemId: 'problem-1', candidateExamNumber: 'team01',
    candidate: { examNumber: 'team01' }, problem: { label: null, order: 26 }, status: 0, createdAt: at(10), judgeAt: null }));
  let fail = false;
  const queries: any[] = [];
  replace(t, prisma.contestSubmission, 'findMany', async (query: any) => {
    queries.push(query);
    if (fail && query.where.id) throw new Error('database unavailable');
    return rows.filter(row => !query.where.id || row.id > query.where.id.gt).slice(0, query.take);
  });
  const state = await createHydroReactionPollState(exam), signal = new AbortController().signal;
  await pollHydroReactions(exam, signal, state);
  assert.equal(reactions.size, 205);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].where.syncImported, false);
  assert.equal(queries[0].select.code, undefined);
  assert.equal(reactions.get(rows[204].id).problemLabel, 'AA');
  const writes = transaction.mock.callCount();
  await pollHydroReactions(exam, signal, state);
  assert.equal(transaction.mock.callCount(), writes);
  const firstId = rows[0].id;
  rows[0] = { ...rows[0], status: 1, judgeAt: at(20) };
  await pollHydroReactions(exam, signal, state);
  assert.equal(reactions.get(firstId).status, 'TAIL');
  const windowEnd = +reactions.get(firstId).windowEnd;
  const restarted = await createHydroReactionPollState(exam);
  await pollHydroReactions(exam, signal, restarted);
  assert.equal(reactions.size, 205);
  assert.equal(+reactions.get(firstId).windowEnd, windowEnd);
  rows = rows.slice(1);
  fail = true;
  await assert.rejects(pollHydroReactions(exam, signal, restarted), /unavailable/);
  assert.equal(reactions.get(firstId).status, 'TAIL', 'partial snapshots cannot delete recordings');
  fail = false;
  await pollHydroReactions(exam, signal, restarted);
  assert.equal(reactions.get(firstId).status, 'DELETED');
});

test('native Hydro polling follows every page and records a later final result', async t => {
  const { exam, reactions } = models(t);
  replace(t, prisma.systemSetting, 'findUnique', async () => ({ value: connection }));
  let status = 0;
  const ids = ['691000000000000000000002', '691000000000000000000003'];
  const pages: Array<string | null> = [];
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    const { after } = JSON.parse(init.body); pages.push(after);
    return Response.json({ ok: true, data: { contestId: tid, records: [record(after ? ids[1] : ids[0], status)], nextAfter: after ? null : ids[0] } });
  });
  const state = await createHydroReactionPollState(exam), signal = new AbortController().signal;
  await pollHydroReactions(exam, signal, state);
  assert.deepEqual(pages, [null, ids[0]]);
  assert.equal(reactions.size, 2);
  assert.equal(reactions.get(ids[0]).status, 'PENDING');
  status = 1;
  await pollHydroReactions(exam, signal, state);
  assert.equal(reactions.get(ids[0]).originalVerdict, 'AC');
  assert.equal(reactions.get(ids[1]).originalVerdict, 'AC');
});

test('native CCS feeds persist source rank changes, resume after restart, and preserve original rank on rejudge', async t => {
  configureCcs(t);
  const { exam, reactions, events } = models(t), id = record().id;
  replace(t, prisma.systemSetting, 'findUnique', async () => { throw new Error('CCS must not read judging credentials'); });
  const history = [...ccs.baseline];
  const requestedTokens: Array<string | null> = [];
  let rejectResume = false;
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const url = new URL(input), token = url.searchParams.get('since_token'); requestedTokens.push(token);
    assert.equal(url.pathname, `/d/acm/api/ccs/contests/${tid}/event-feed`);
    assert.equal(init.headers['x-ccs-api-key'], ccsEnv.REACTION_HYDRO_CCS_API_KEY);
    assert.equal(init.headers['x-proctor-api-key'], undefined);
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    if (rejectResume && token) { rejectResume = false; return new Response('Invalid event feed token', { status: 400 }); }
    const rows = token ? history.slice(history.findIndex(row => row.token === token) + 1) : history;
    return new Response(rows.map(row => JSON.stringify(row)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
  });
  const connected = t.mock.fn(async () => {});
  const consume = () => consumeHydroCcsFeed(exam, new AbortController().signal, connected);
  await assert.rejects(consume(), /STREAM_CLOSED/);
  const r = reactions.get(id);
  assert.equal(r.status, 'PENDING');
  const cursor = events.get('hydro-ccs-cursor:standalone-v1').payload.token;
  assert.ok(events.has('teams:member01'), 'team members have their own exact footage identity and shared team name');
  history.push(ccs.ac);
  await assert.rejects(consume(), /STREAM_CLOSED/);
  assert.equal(requestedTokens[1], cursor);
  assert.equal(r.originalVerdict, 'AC');
  const rank = parseReactionRankContext(r.rankContext)!;
  assert.deepEqual([rank.status, rank.source, rank.beforeRank, rank.afterRank], ['AVAILABLE', 'HYDRO_CCS_OBSERVED_ORDER', 2, 1]);
  assert.equal(rank.provenance.eventToken, events.get('hydro-ccs-cursor:standalone-v1').payload.token);
  const windowEnd = +r.windowEnd;
  await assert.rejects(consume(), /STREAM_CLOSED/);
  assert.equal(+r.windowEnd, windowEnd);
  history.push(ccs.rejudge);
  await assert.rejects(consume(), /STREAM_CLOSED/);
  assert.equal(r.verdict, 'WA'); assert.equal(r.originalVerdict, 'AC');
  assert.deepEqual(r.rankContext, rank); assert.equal(+r.windowEnd, windowEnd);
  const latestCursor = events.get('hydro-ccs-cursor:standalone-v1').payload.token;
  rejectResume = true;
  await assert.rejects(consume(), /STREAM_CLOSED/);
  assert.deepEqual(requestedTokens.slice(-2), [latestCursor, null], 'invalid cursors rebootstrap without changing original reactions');
  assert.deepEqual(r.rankContext, rank); assert.equal(+r.windowEnd, windowEnd);
  history.push(...ccs.deleted);
  await assert.rejects(consume(), /STREAM_CLOSED/);
  assert.equal(events.get('teams:team01').payload.__reactionDeleted, true);
  assert.equal(events.get('teams:member01').payload.__reactionDeleted, true);
  assert.equal(r.status, 'DELETED');
});

test('CCS cursors do not advance for stale disabled/re-enabled sessions or failed validation', async t => {
  configureCcs(t);
  const { exam, current, events } = models(t);
  let feed = ccs.baseline.map(row => JSON.stringify(row)).join('\n');
  t.mock.method(globalThis, 'fetch', async () => new Response(feed, { headers: { 'content-type': 'application/x-ndjson' } }));
  current.reactionConfig.initializedAt = at(60);
  await assert.rejects(consumeHydroCcsFeed(exam, new AbortController().signal, async () => {}), /SOURCE_CHANGED/);
  assert.equal(events.size, 0);
  current.reactionConfig.initializedAt = at(0);
  feed = JSON.stringify({ ...ccs.baseline[4], token: 'invalid' });
  await assert.rejects(consumeHydroCcsFeed(exam, new AbortController().signal, async () => {}), /INVALID_EVENT/);
  assert.equal(events.size, 0);
});

test('a newer worker lease prevents both event writes and CCS cursor advancement', async t => {
  configureCcs(t);
  const { exam, current, events, reactions } = models(t);
  current.reactionConfig.leaseToken = 'replacement-worker';
  t.mock.method(globalThis, 'fetch', async () => new Response(ccs.baseline.map(row => JSON.stringify(row)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } }));
  await assert.rejects(consumeHydroCcsFeed(exam, new AbortController().signal, async () => {}), /SOURCE_CHANGED/);
  assert.equal(events.size, 0);
  assert.equal(reactions.size, 0);
});

test('member transfers and team renames retire aliases without deleting the new footage identity', async t => {
  configureCcs(t);
  const { exam, events } = models(t);
  let batch = ccs.baseline.slice(1, 3);
  t.mock.method(globalThis, 'fetch', async () => new Response(batch.map(row => JSON.stringify(row)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } }));
  const consume = () => assert.rejects(consumeHydroCcsFeed(exam, new AbortController().signal, async () => {}), /STREAM_CLOSED/);
  await consume();
  assert.equal(events.get('teams:member01').payload.x_hydro_team_id, 'team01');
  // The new team's update can precede deletion of the old team.
  batch = [{ ...ccs.baseline[2], token: 'a'.repeat(24) + '.2.0', data: { ...ccs.baseline[2].data!, x_hydro_usernames: ['team02', 'member01'] } }, ccs.deleted[0]];
  await consume();
  assert.equal(events.get('teams:team01').payload.__reactionDeleted, true);
  assert.equal(events.get('teams:member01').payload.x_hydro_team_id, 'team02');
  assert.equal(events.get('teams:member01').payload.__reactionDeleted, undefined);
  // A Hydro username rename changes the CCS team ID; the old ID is deleted.
  batch = [
    { type: 'teams', id: 'team02', token: 'a'.repeat(24) + '.5.0', data: null },
    { type: 'teams', id: 'renamed', token: 'a'.repeat(24) + '.5.1', data: { id: 'renamed', name: 'Renamed team', x_hydro_username: 'renamed', x_hydro_usernames: ['renamed', 'member01'] } },
  ];
  await consume();
  assert.equal(events.get('teams:team02').payload.__reactionDeleted, true);
  assert.equal(events.get('teams:member01').payload.x_hydro_team_id, 'renamed');
  assert.equal(events.get('teams:member01').payload.name, 'Renamed team');
  assert.equal(events.get('teams:member01').payload.__reactionDeleted, undefined);
});

test('CCS rejects proxy HTML and malformed event responses without advancing the cursor', async t => {
  configureCcs(t);
  const { exam, events } = models(t);
  let response = new Response('<html>proxy login</html>', { headers: { 'content-type': 'text/html' } });
  t.mock.method(globalThis, 'fetch', async () => response);
  const connected = t.mock.fn(async () => {});
  await assert.rejects(consumeHydroCcsFeed(exam, new AbortController().signal, connected), /INVALID_EVENT/);
  assert.equal(connected.mock.callCount(), 0);
  for (const event of [
    { ...ccs.baseline[0], data: { ...ccs.baseline[0].data, id: 'another-contest' } },
    { ...ccs.baseline[4], id: 'different-submission-id' },
    { ...ccs.baseline[4], data: { ...ccs.baseline[4].data, x_hydro_username: undefined } },
  ]) {
    response = new Response(JSON.stringify(event), { headers: { 'content-type': 'application/x-ndjson' } });
    await assert.rejects(consumeHydroCcsFeed(exam, new AbortController().signal, connected), /INVALID_EVENT|SOURCE_CHANGED/);
  }
  assert.equal(events.size, 0);
});

test('migration ignores embedded cursors while preserving historical recordings, ranks and capture windows', async t => {
  configureCcs(t);
  const { exam, events, reactions } = models(t);
  // Model rows already persisted by the embedded plugin, including its old field names.
  for (const event of [...ccs.baseline, ccs.ac]) {
    const normalized = normalizeHydroCcsEvent(event, tid)!;
    const old = JSON.parse(JSON.stringify(normalized).replaceAll('x_hydro_username', 'x_proctor_username').replaceAll('x_hydro_rank', 'x_proctor_rank'));
    await acceptReactionEvent(exam, old, at(31));
  }
  const r = reactions.get(record().id);
  // An old Recorder would already have persisted its verified legacy context.
  r.rankContext = structuredClone(ccs.ac.data!.x_hydro_rank);
  const rank = structuredClone(r.rankContext), windowEnd = +r.windowEnd;
  const oldCursor = { type: 'hydro-ccs-cursor', remoteId: 'v1', payload: { token: 'b'.repeat(24) + '.90.3', source: eventHash({ base: exam.platformBaseUrl, contestId: tid }) } };
  events.set('hydro-ccs-cursor:v1', oldCursor);
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    assert.equal(new URL(input).searchParams.has('since_token'), false);
    return new Response([...ccs.baseline, ccs.ac].map(row => JSON.stringify(row)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
  });
  await assert.rejects(consumeHydroCcsFeed(exam, new AbortController().signal, async () => {}), /STREAM_CLOSED/);
  assert.equal(reactions.size, 1);
  assert.equal(+r.windowEnd, windowEnd);
  assert.equal(r.originalVerdict, 'AC');
  assert.deepEqual(r.rankContext, rank);
  assert.equal(events.get('hydro-ccs-cursor:v1'), oldCursor);
  assert.equal(events.get('hydro-ccs-cursor:standalone-v1').payload.token, ccs.ac.token);
});

test('CCS never sends a key to an unconfigured origin or falls back after authorization failures', async t => {
  configureCcs(t);
  const { exam, events } = models(t);
  const connected = t.mock.fn(async () => {});
  let status = 401;
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('private diagnostic', { status }));
  for (status of [401, 403, 404, 503]) {
    await assert.rejects(consumeHydroCcsFeed(exam, new AbortController().signal, connected), new RegExp(`^Error: HYDRO_HTTP_${status}$`));
  }
  assert.equal(request.mock.callCount(), 4);
  assert.equal(connected.mock.callCount(), 0);
  assert.equal(events.size, 0);
  await assert.rejects(consumeHydroCcsFeed({ ...exam, platformBaseUrl: 'https://untrusted.example' }, new AbortController().signal, connected), /CONFIGURATION/);
  delete process.env.REACTION_HYDRO_CCS_API_KEY;
  await assert.rejects(consumeHydroCcsFeed(exam, new AbortController().signal, connected), /CONFIGURATION/);
  assert.equal(request.mock.callCount(), 4);
});

test('CCS rank evidence must match the event token, contest, username, submission, judgement and verdict', async () => {
  const event = ccs.ac;
  const rank = event.data!.x_hydro_rank as any;
  const expected = { contestId: tid, teamId: 'team01', submissionId: record().id, judgementId: `hydro-${record().id}`, verdict: 'AC' };
  assert.ok(hydroCcsRankContext(rank, expected));
  for (const key of Object.keys(expected)) assert.equal(hydroCcsRankContext(rank, { ...expected, [key]: 'mismatch' }), null);
  assert.throws(() => normalizeHydroCcsEvent({ ...event, token: event.token!.replace(/\.\d+$/, '.999') }, tid), /INVALID_EVENT/);
  assert.equal(hydroCcsRankContext({ ...rank, provenance: { ...rank.provenance, visibility: 'FROZEN_PUBLIC' } }, expected), null);
});
