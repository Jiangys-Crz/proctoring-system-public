import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { serializeLocalSubmissions } from '../src/lib/local-contest';
import { submissionVisibility } from '../src/lib/submission-visibility';
import { calculateLeaderboards } from '../src/lib/leaderboards';
import { POST as submissions } from '../src/app/api/client/contest/submissions/route';
import { POST as leaderboard } from '../src/app/api/client/contest/leaderboard/route';

const now = new Date();
const freeze = new Date(+now - 60_000);
const exam = { id: 'freeze-exam', published: true, platformContestId: 'local', contestRule: 'XCPC' as const,
  startAt: new Date(+now - 600_000), latestStartAt: new Date(+now - 600_000), endAt: new Date(+now + 600_000),
  durationMinutes: 20, contestType: 'INDIVIDUAL' as const, scoreboardFrozenAt: freeze,
  showObjectiveScore: true, showTestCaseCount: true,
  problems: [{ id: 'problem', order: 0, title: 'A', problemType: 'default', scorePercent: 100, score: 100, hydroScore: 100 }] };
const ownerToken = createClientSessionToken();
const session = { id: 'freeze-session', examId: exam.id, candidateId: 'owner', status: 'IN_EXAM',
  desktopTokenHash: ownerToken.tokenHash, revokedAt: null, exam, candidate: { id: 'owner', startedAt: null } };
const run = (id: string, candidateId = 'other', createdAt = new Date(+freeze + 1), status = 1) => ({
  id, candidateId, actorKey: candidateId, problemId: 'problem', candidateExamNumber: candidateId, candidateName: candidateId, teamName: null,
  status, statusText: status === 1 ? 'Accepted' : 'Judge detail must stay private', score: 100, totalTestCases: 10, passedTestCases: 10,
  time: 321, memory: 654, code: 'source', lang: 'cpp', testCases: [{ status: 1, message: 'secret' }], subtasks: { score: 100 }, createdAt
});

function replace(t: TestContext, object: object, key: string, value: unknown) {
  const target = object as Record<string, unknown>, original = target[key];
  target[key] = value; t.after(() => { target[key] = original; });
}
function mockSession(t: TestContext, value = session) {
  replace(t, prisma.clientSession, 'findUnique', async () => value);
  replace(t, prisma.systemSetting, 'findUnique', async () => null);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('candidate result reads must not call Hydro'); });
}
const request = (extra: Record<string, unknown> = {}, token = ownerToken.token) => new Request('http://localhost/api/client/contest/submissions', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': token },
  body: JSON.stringify({ sessionId: session.id, ...extra })
});
function hidden(row: any) {
  assert.equal(row.resultHidden, true);
  assert.equal(row.status, 0); assert.equal(row.statusText, 'Submitted');
  assert.equal(row.scoreVisible, false); assert.equal(row.score, null);
  assert.equal(row.totalTestCases, null); assert.equal(row.passedTestCases, null);
  assert.equal(row.time, 0); assert.equal(row.memory, 0);
  assert.deepEqual(row.testCases, []); assert.deepEqual(row.subtasks, {});
}

test('XCPC and legacy ACM hide every other-candidate verdict and metric in the freeze window', () => {
  for (const contestRule of ['XCPC', 'ACM'] as const) {
    const records = [1, 2, 3, 7, 22, 30].map(status => run(`status-${status}`, 'other', new Date(+freeze + 1), status));
    const serialized = serializeLocalSubmissions({ ...exam, contestRule }, records, 'owner', now);
    serialized.forEach(hidden);
    assert.deepEqual(records.map(record => record.status), [1, 2, 3, 7, 22, 30], 'serialization never mutates shared judge inputs');
  }
});

test('owner and pre-freeze submissions keep their ordinary verdicts and test counts', () => {
  const records = [run('own', 'owner'), run('before', 'other', new Date(+freeze - 1)), run('boundary', 'other', freeze)];
  for (const row of serializeLocalSubmissions(exam, records, 'owner', now)) {
    assert.equal(row.resultHidden, false); assert.equal(row.status, 1);
    assert.equal(row.statusText, 'Accepted'); assert.equal(row.passedTestCases, 10);
    assert.equal(row.time, 321); assert.equal(row.memory, 654);
    assert.equal(row.score, null, 'XCPC still has no score column');
  }
});

test('freeze timing matches scoreboard boundaries and unfreezes at the existing exam end', () => {
  const row = run('other');
  for (const observation of [new Date(+freeze - 1), exam.endAt, new Date(+exam.endAt + 1)]) {
    assert.equal(serializeLocalSubmissions(exam, [row], 'owner', observation)[0].status, 1);
  }
  hidden(serializeLocalSubmissions(exam, [row], 'owner', freeze)[0]);
  hidden(serializeLocalSubmissions(exam, [row], 'owner', new Date(+exam.endAt - 1))[0]);
  assert.equal(serializeLocalSubmissions({ ...exam, scoreboardFrozenAt: null }, [row], 'owner', now)[0].status, 1);
  const candidates = [{ id: 'other', examNumber: 'other', name: 'Other', teamName: null }];
  const records = [run('boundary', 'other', freeze), { ...row, problemId: 'second' }];
  const board = calculateLeaderboards(exam, [...exam.problems, { ...exam.problems[0], id: 'second' }], candidates, records, now);
  assert.equal(board.rows[0].solved, 1);
  assert.equal(board.rows[0].cells[1].pending, 1);
  assert.equal(board.rows[0].cells[1].accepted, false);
});

test('other scoring rules and hidden objective verdicts retain their existing policies', () => {
  const viewer = { candidateId: 'owner', submissionCandidateId: 'other', submittedAt: new Date(+freeze + 1) };
  assert.equal(submissionVisibility({ ...exam, contestRule: 'IOI' }, 'default', now, viewer).result, true);
  assert.equal(submissionVisibility({ ...exam, contestRule: 'GPLT' }, 'default', now, viewer).result, true);
  assert.equal(submissionVisibility({ ...exam, contestRule: 'OI' }, 'default', now, viewer).result, false);
  assert.equal(submissionVisibility({ ...exam, showObjectiveScore: false }, 'objective', now,
    { ...viewer, submissionCandidateId: 'owner' }).result, false);
});

test('authenticated candidate poll returns only owner records even with forged viewer/time parameters', async t => {
  mockSession(t);
  replace(t, prisma.contestSubmission, 'findMany', async ({ where }: any) => {
    assert.deepEqual(where, { examId: exam.id, candidateId: 'owner' });
    return [run('own', 'owner')];
  });
  const response = await submissions(request({ viewerCandidateId: 'other', timePoint: +freeze - 1, admin: true }));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.length, 1);
  assert.equal(data[0].id, 'own'); assert.equal(data[0].status, 1);
  assert.equal(data[0].canViewDetail, true);
  assert.equal((await submissions(request({}, 'invalid-token'))).status, 401);
});

test('concurrent candidate identities never share private records', async t => {
  const otherToken = createClientSessionToken();
  mockSession(t);
  replace(t, prisma.clientSession, 'findUnique', async ({ where }: any) => where.id === 'other-session'
    ? { ...session, id: 'other-session', candidateId: 'other', candidate: { id: 'other' }, desktopTokenHash: otherToken.tokenHash } : session);
  const row = run('shared');
  replace(t, prisma.contestSubmission, 'findMany', async ({ where }: any) => where.candidateId === 'other' ? [row] : []);
  const [owner, other] = await Promise.all([
    submissions(request()), submissions(request({ sessionId: 'other-session' }, otherToken.token))
  ]);
  assert.deepEqual((await owner.json()).data, []);
  const visible = (await other.json()).data[0];
  assert.equal(visible.status, 1); assert.equal(visible.canViewDetail, true);
});

test('frozen legacy Hydro leaderboard cannot relay an unverifiable live aggregate', async t => {
  mockSession(t, { ...session, exam: { ...exam, problems: [] } });
  const response = await leaderboard(request({ timePoint: +freeze - 1 }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { available: false, frozen: true, rows: [] });
});
