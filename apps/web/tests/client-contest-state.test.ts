import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ContestSummarySession } from '../src/lib/client-contest';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { serializeContestState } from '../src/lib/client-contest-state';
import { GET } from '../src/app/api/client/contest/state/route';

const credentials = createClientSessionToken();
const start = new Date('2026-10-11T10:00:00Z');
const at = (minutes: number) => new Date(+start + minutes * 60_000);

function fixture(): ContestSummarySession {
  return {
    id: 'session', status: 'IN_EXAM', startedAt: start, lockdown: false, lockdownReason: null,
    desktopTokenHash: credentials.tokenHash, miniProgramTokenHash: null, revokedAt: null,
    updatedAt: start, lastDesktopSeenAt: start,
    candidate: { id: 'candidate', updatedAt: start, startedAt: start, lateStartAllowedAt: null, isTeamLeader: true },
    exam: { id: 'exam', updatedAt: start, published: true, platformContestId: 'local',
      startAt: start, latestStartAt: at(60), endAt: at(120), durationMinutes: 120,
      flexible: false, contestRule: 'IOI', contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS',
      leaderOnlySubmission: true, allowTeamSubmissionView: true, scoreboardFrozenAt: at(90),
      problems: [{ id: 'problem', order: 0, updatedAt: start, title: 'A', problemType: 'default', score: 100, scorePercent: 100, hydroScore: 100 }],
    },
  } as ContestSummarySession;
}

function replace(t: TestContext, target: object, key: string, implementation: unknown) {
  const record = target as Record<string, unknown>;
  const original = record[key]; record[key] = implementation;
  t.after(() => { record[key] = original; });
}

function request(token = credentials.token) {
  return new Request('http://localhost/api/client/contest/state?sessionId=session', {
    headers: { 'x-proctor-session-token': token },
  });
}

test('contest state exposes the session contract and stable revisions across ordinary heartbeat updates', () => {
  const session = fixture();
  const before = serializeContestState(session, at(1));
  session.updatedAt = at(2); session.lastDesktopSeenAt = at(2);
  assert.equal(serializeContestState(session, at(2)).revision, before.revision);
  assert.deepEqual(before.session, {
    id: 'session', status: 'IN_EXAM', startedAt: start, lockdown: false, lockdownReason: null,
    latestStartAt: at(15), flexible: false, effectiveEndAt: at(120).toISOString(),
    canSubmit: true, canViewSubmissions: true, allowTeamSubmissionView: true,
  });
  session.lockdown = true; session.lockdownReason = 'Locked'; session.status = 'LOCKED';
  const locked = serializeContestState(session, at(2));
  assert.equal(locked.revision, before.revision, 'session changes are delivered directly without reloading all statements');
  assert.equal(locked.session.lockdown, true); assert.equal(locked.session.status, 'LOCKED');
  assert.equal(locked.session.lockdownReason, 'Locked');
});

test('exam, identity, problem edits and team sharing changes invalidate full contest data', () => {
  const baseline = serializeContestState(fixture(), at(1)).revision;
  for (const change of [
    (session: ContestSummarySession) => { session.exam.updatedAt = at(1); },
    (session: ContestSummarySession) => { session.candidate.updatedAt = at(1); },
    (session: ContestSummarySession) => { session.exam.problems[0].updatedAt = at(1); },
    (session: ContestSummarySession) => { session.exam.problems = []; },
    (session: ContestSummarySession) => { session.exam.allowTeamSubmissionView = false; },
    (session: ContestSummarySession) => { session.candidate.startedAt = at(-1); },
  ]) {
    const session = fixture(); change(session);
    assert.notEqual(serializeContestState(session, at(1)).revision, baseline);
  }
});

test('full problem rows and lightweight problem metadata produce the same local revision', () => {
  const summary = fixture();
  const full = { ...summary, exam: { ...summary.exam, problems: summary.exam.problems.map(problem => ({
    ...problem, content: 'Full statement', files: [{ name: 'attachment.pdf' }], config: { answer: 'private' },
  })) } };
  assert.equal(serializeContestState(full, at(1)).revision, serializeContestState(summary, at(1)).revision);
  assert.equal(serializeContestState(full, at(1)).requiresFullRefresh, undefined);
  assert.equal(serializeContestState(summary, at(1)).requiresFullRefresh, undefined);
});

test('legacy Hydro contests request a full refresh before their remote deadline can be replaced', async t => {
  const session = fixture();
  session.exam.platformContestId = 'legacy-hydro-contest';
  session.exam.problems = [];
  replace(t, prisma.clientSession, 'findUnique', async () => session);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('the lightweight state endpoint must not fetch Hydro'); });
  const response = await GET(request());
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.requiresFullRefresh, true, 'the caller must retain the full response deadline until another full response arrives');
  assert.equal(typeof data.revision, 'string');
  session.exam.problems = fixture().exam.problems;
  const local = await GET(request());
  assert.equal((await local.json()).data.requiresFullRefresh, undefined,
    'the exact full-route local/legacy discriminator is the presence of local problems');
});

test('clock-only start, attachment, freeze, personal end and exam end transitions change revision', () => {
  const session = fixture();
  assert.notEqual(serializeContestState(session, at(-1)).revision, serializeContestState(session, start).revision);
  session.startedAt = null; session.candidate.startedAt = at(2);
  assert.notEqual(serializeContestState(session, at(1)).revision, serializeContestState(session, at(2)).revision);
  session.candidate.startedAt = start;
  assert.notEqual(serializeContestState(session, at(89)).revision, serializeContestState(session, at(90)).revision);
  assert.notEqual(serializeContestState(session, at(119)).revision, serializeContestState(session, at(120)).revision);
  session.exam.flexible = true; session.exam.durationMinutes = 30;
  assert.equal(serializeContestState(session, at(29)).session.effectiveEndAt, at(30).toISOString());
  assert.notEqual(serializeContestState(session, at(29)).revision, serializeContestState(session, at(30)).revision);
  assert.notEqual(serializeContestState(session, at(119)).revision, serializeContestState(session, at(120)).revision,
    'global result visibility must still change after a flexible personal exam has ended');
});

test('30 concurrent state requests use fresh authorization with problem metadata only and no submissions or Hydro', async t => {
  let reads = 0;
  replace(t, prisma.clientSession, 'findUnique', async (query: any) => {
    reads++;
    assert.equal(query.where.id, 'session');
    const selection = query.include.exam.include.problems.select;
    assert.equal(selection.updatedAt, true);
    for (const large of ['content', 'config', 'files']) assert.equal(selection[large], undefined);
    return fixture();
  });
  replace(t, prisma.contestSubmission, 'findMany', async () => { assert.fail('state must not read submission history'); });
  replace(t, prisma.candidate, 'count', async () => { assert.fail('state must not recount all candidates'); });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('state must not call Hydro'); });
  const responses = await Promise.all(Array.from({ length: 30 }, () => GET(request())));
  const revisions = new Set<string>();
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const { data } = await response.json();
    assert.deepEqual(Object.keys(data).sort(), ['revision', 'session']);
    revisions.add(data.revision);
    assert.equal(data.session.desktopTokenHash, undefined);
    assert.equal(data.session.startedAt, start.toISOString());
  }
  assert.equal(reads, 30); assert.equal(revisions.size, 1);
});

test('state polling immediately rejects revoked tokens, unpublished exams and disallowed sessions', async t => {
  const session = fixture();
  replace(t, prisma.clientSession, 'findUnique', async () => session);
  assert.equal((await GET(new Request('http://localhost/api/client/contest/state'))).status, 400);
  assert.equal((await GET(request())).status, 200);
  assert.equal((await GET(request('wrong-token'))).status, 401);
  session.revokedAt = at(1);
  assert.equal((await GET(request())).status, 401);
  session.revokedAt = null; session.exam.published = false;
  assert.equal((await GET(request())).status, 403);
  session.exam.published = true; session.status = 'WAITING_REVIEW';
  assert.equal((await GET(request())).status, 403);
});
