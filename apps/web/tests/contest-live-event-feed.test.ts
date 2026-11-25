import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contestEventFeedConnection, readContestEventFeed } from '../src/lib/contest-live-event-feed';
import { contestLivePresentation, liveRoster, type LiveExam } from '../src/lib/contest-live-scoring';
import { ac, baseline, deleted, rejudge } from './fixtures/hydro-ccs-v1';
import type { CcsEvent } from '../src/lib/reaction-domain';

const hydroId = String(baseline[0].data?.id);
const start = new Date('2026-11-09T03:00:00Z');
const end = new Date('2026-11-09T06:00:00Z');
const capturedAt = new Date('2026-11-09T04:00:00Z');
const signal = () => AbortSignal.timeout(5_000);
const ndjson = (events: CcsEvent[]) => new Response(events.map(event => JSON.stringify(event)).join('\n'), {
  headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
});

test('Hydro starts at the domain-specific feed and applies judgement updates and deletions across resume', async t => {
  const exam = { id: 'internal-exam', platform: 'HYDRO_BROWSER', platformBaseUrl: 'https://hydro.example/d/school', platformContestId: hydroId };
  const key = 'a'.repeat(32);
  const previous = { origin: process.env.REACTION_HYDRO_CCS_ORIGIN, key: process.env.REACTION_HYDRO_CCS_API_KEY, overrides: process.env.REACTION_HYDRO_CCS_CREDENTIALS };
  process.env.REACTION_HYDRO_CCS_ORIGIN = 'https://hydro.example';
  process.env.REACTION_HYDRO_CCS_API_KEY = key;
  delete process.env.REACTION_HYDRO_CCS_CREDENTIALS;
  t.after(() => {
    for (const [name, value] of Object.entries({ REACTION_HYDRO_CCS_ORIGIN: previous.origin, REACTION_HYDRO_CCS_API_KEY: previous.key,
      REACTION_HYDRO_CCS_CREDENTIALS: previous.overrides })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const connection = contestEventFeedConnection(exam, 'hydro');
  const initial = structuredClone(baseline);
  initial[0].id = null;
  initial[0].data = { ...initial[0].data, end_time: end.toISOString(), scoreboard_freeze_duration: '1:00:00.000' };
  initial[4].data = { ...initial[4].data, team_id: 'some-other-account', language_id: 'cpp' };
  const outsider: CcsEvent = { ...initial[4], id: 'outside', token: `${'a'.repeat(24)}.1.6`,
    data: { ...initial[4].data, id: 'outside', x_hydro_username: 'unlisted', team_id: 'team01' } };
  const state: CcsEvent = { type: 'state', id: null, token: `${'a'.repeat(24)}.1.7`, data: { frozen: null, thawed: null } };
  const cursors: Array<string | null> = [];
  const replies = [ndjson([...initial, outsider, state, ac]), ndjson([rejudge]), ndjson(deleted), new Response('expired', { status: 400 }), ndjson(initial)];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://hydro.example');
    assert.equal(url.pathname, `/d/school/api/ccs/contests/${hydroId}/event-feed`);
    assert.equal(url.searchParams.get('stream'), 'false');
    assert.notEqual(url.searchParams.get('runs'), 'false');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('x-ccs-api-key'), key);
    cursors.push(url.searchParams.get('since_token'));
    return replies.shift()!;
  });
  const accounts = new Map([['team01', 'candidate']]);
  const first = await readContestEventFeed(connection, accounts, capturedAt, signal());
  assert.equal(first.snapshot.remoteFrozenAt, '2026-11-09T05:00:00.000Z');
  assert.deepEqual(first.snapshot.runs.map(run => [run.candidateId, run.verdict, run.language, run.judgedAt?.toISOString()]),
    [['candidate', 'Accepted', 'cpp', '2026-11-09T03:00:30.000Z']]);
  const changed = await readContestEventFeed(connection, accounts, capturedAt, signal(), first.hydroState);
  assert.equal(changed.snapshot.runs[0].verdict, 'Wrong Answer');
  assert.equal(first.snapshot.runs[0].verdict, 'Accepted');
  const removed = await readContestEventFeed(connection, accounts, capturedAt, signal(), changed.hydroState);
  assert.deepEqual(removed.snapshot.runs, []);
  const restarted = await readContestEventFeed(connection, accounts, capturedAt, signal(), removed.hydroState);
  assert.equal(restarted.snapshot.runs[0].status, 0);
  assert.deepEqual(cursors, [null, ac.token, rejudge.token, deleted[2].token, null]);
});

test('Hydro queue progress follows completed test IDs across updates, deletions and rejudging', async t => {
  const connection = { platform: 'hydro' as const, contestId: hydroId, url: 'https://hydro.example/event-feed', headers: {} };
  const judgementId = String(baseline[5].id);
  const accounts = new Map([['team01', 'candidate']]);
  let index = 0;
  const event = (type: string, id: string, data: CcsEvent['data']): CcsEvent =>
    ({ type, id, data, token: `${'a'.repeat(24)}.2.${index++}` });
  const testCase = (id: string, verdict: string | null = 'AC', parent = judgementId) =>
    event('runs', id, { id, judgement_id: parent, judgement_type_id: verdict });
  const problem = baseline[3];
  const initial = baseline.map(row => row === problem ? { ...row, data: { ...row.data, test_data_count: 4 } } : row);
  const replies = [
    ndjson([...initial, testCase('one'), testCase('one', 'WA'), testCase('four'), testCase('other', 'AC', 'another-judgement'), testCase('waiting', null)]),
    ndjson([event('runs', 'four', null)]),
    ndjson([ac, testCase('three')]),
    ndjson([baseline[5], event('runs', 'one', null), testCase('new-case')]),
    ndjson([ac, baseline[5], testCase('newer-case')]),
    ndjson([problem]),
  ];
  t.mock.method(globalThis, 'fetch', async () => replies.shift()!);
  const first = await readContestEventFeed(connection, accounts, capturedAt, signal());
  assert.equal(first.snapshot.runs[0].testedPart, 0.5);
  const exam: LiveExam = { id: 'exam', name: 'Test', startAt: start, latestStartAt: start, endAt: end, durationMinutes: 180,
    contestType: 'INDIVIDUAL', contestRule: 'XCPC', scoreboardFrozenAt: null, showObjectiveScore: false };
  const roster = liveRoster(exam, [{ id: 'candidate', examNumber: 'team01', name: 'Team', teamName: null, school: null, hydroAccount: null }], 'hydro');
  const beforeFreeze = contestLivePresentation(exam, 'hydro', roster, first.snapshot, null, capturedAt, 'all');
  assert.equal(beforeFreeze.submissions[0].testedPart, 0.5);
  const frozen = contestLivePresentation(exam, 'hydro', roster, first.snapshot, null, capturedAt, 'all', 'normal',
    { at: '2026-11-09T03:00:05Z', revealed: false });
  for (const row of [...frozen.submissions, ...frozen.timeline]) {
    assert.equal(row.frozen, true);
    assert.equal('testedPart' in row, false);
  }
  const changed = await readContestEventFeed(connection, accounts, capturedAt, signal(), first.hydroState);
  assert.equal(changed.snapshot.runs[0].testedPart, 0.25);
  assert.equal(first.snapshot.runs[0].testedPart, 0.5);
  const finished = await readContestEventFeed(connection, accounts, capturedAt, signal(), changed.hydroState);
  assert.equal(finished.snapshot.runs[0].verdict, 'Accepted');
  assert.equal(finished.snapshot.runs[0].testedPart, undefined);
  const retried = await readContestEventFeed(connection, accounts, capturedAt, signal(), finished.hydroState);
  assert.equal(retried.snapshot.runs[0].testedPart, 0.25);
  const sameBatchRetry = await readContestEventFeed(connection, accounts, capturedAt, signal(), retried.hydroState);
  assert.equal(sameBatchRetry.snapshot.runs[0].testedPart, 0.25);
  const unknownTotal = await readContestEventFeed(connection, accounts, capturedAt, signal(), sameBatchRetry.hydroState);
  assert.equal(unknownTotal.snapshot.runs[0].testedPart, undefined);
});

test('Nova maps CCS usernames, uses the upstream problem ID and keeps finished post-freeze results masked', async t => {
  const authorization = 'Basic test-credential';
  const contestId = '12';
  const connection = { platform: 'nova' as const, contestId, url: `https://nova.example/api/ccs/contests/${contestId}/event-feed`, headers: { authorization } };
  const entry = (type: string, id: string, data: Record<string, unknown> = {}): CcsEvent => ({ type, id, data: { id, ...data } });
  const makeSubmission = (id: string, account: string) => entry('submissions', id, {
    team_id: account, problem_id: '77', time: '2026-11-09T03:10:00Z', language_id: 'cpp',
  });
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.equal(input, connection.url + '?stream=false');
    assert.equal(new Headers(init.headers).get('authorization'), authorization);
    return ndjson([
      entry('contests', contestId), entry('teams', 'player'), entry('teams', 'outsider'), entry('teams', 'legacy-alias'),
      entry('problems', '77', { label: 'A', name: 'A problem', rgb: '#123456', ordinal: 0, test_data_count: 5 }),
      makeSubmission('accepted', 'player'), makeSubmission('unlisted', 'outsider'),
      makeSubmission('deleted-user-uid', 'uid'), makeSubmission('alias', 'legacy-alias'),
      entry('judgements', 'accepted', { submission_id: 'accepted', judgement_type_id: 'AC', end_time: '2026-11-09T03:10:02Z' }),
      makeSubmission('pending', 'player'),
      entry('runs', 'case-1', { judgement_id: 'in-progress', judgement_type_id: 'AC' }),
      entry('judgements', 'in-progress', { submission_id: 'pending', judgement_type_id: null }),
    ]);
  });
  const accounts = new Map([['player', 'candidate'], ['uid', 'another']]);
  const { snapshot } = await readContestEventFeed(connection, accounts, capturedAt, signal());
  assert.deepEqual(snapshot.runs.map(run => [run.id, run.status, run.problemId, run.testedPart]),
    [['accepted', 1, '77', undefined], ['pending', 0, '77', 0.2]]);
  assert.equal(snapshot.problems[0].color, '#123456');
  const exam: LiveExam = { id: 'exam', name: 'Exam', startAt: start, latestStartAt: start, endAt: end, durationMinutes: 180,
    contestType: 'INDIVIDUAL', contestRule: 'XCPC', scoreboardFrozenAt: null, showObjectiveScore: false };
  const roster = liveRoster(exam, [{ id: 'candidate', examNumber: 'player', name: 'Player', teamName: null, hydroAccount: 'legacy-alias', school: null }], 'nova');
  const data = contestLivePresentation(exam, 'nova', roster, snapshot, null, capturedAt, 'all', 'normal',
    { at: '2026-11-09T03:05:00Z', revealed: false });
  assert.deepEqual(data.timeline.map(run => [run.verdict, run.frozen, run.score, run.firstBlood, run.testedPart]),
    [[null, true, null, false, undefined], [null, true, null, false, undefined]]);
  assert.equal(data.statistics[0].accepted, 0);
});
