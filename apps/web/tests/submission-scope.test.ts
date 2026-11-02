import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { POST as submissions } from '../src/app/api/client/contest/submissions/route';
import { POST as submit } from '../src/app/api/client/contest/submit/route';
import { GET as contest } from '../src/app/api/client/contest/route';

const now = new Date();
const token = createClientSessionToken();
const problem = { id: 'problem', order: 0, title: 'A', problemType: 'default', scorePercent: 100, score: 100,
  hydroScore: 100, hydroProblemId: '1', content: 'Statement', config: {}, files: [], updatedAt: now };
const exam: any = { id: 'exam', examCode: '1234567890', name: 'Exam', published: true, platformContestId: 'local',
  contestRule: 'XCPC', contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS', allowTeamSubmissionView: true,
  startAt: new Date(+now - 600_000), latestStartAt: new Date(+now - 600_000), endAt: new Date(+now + 600_000),
  scoreboardFrozenAt: new Date(+now - 60_000), showObjectiveScore: true, showTestCaseCount: true,
  flexible: false, allowedLanguages: ['cpp'], problems: [problem], durationMinutes: 20, updatedAt: now };
const candidate: any = { id: 'owner', examId: 'exam', examNumber: '001', name: 'Owner', teamName: 'Team A',
  startedAt: exam.startAt, isTeamLeader: true, updatedAt: now };
const session: any = { id: 'session', examId: exam.id, candidateId: candidate.id, status: 'IN_EXAM',
  desktopTokenHash: token.tokenHash, revokedAt: null, exam, candidate, startedAt: exam.startAt };
const record = (candidateId: string) => ({ id: `submission-${candidateId}`, examId: exam.id, candidateId, actorKey: `actor-${candidateId}`,
  problemId: 'problem', candidateExamNumber: candidateId, candidateName: candidateId, teamName: 'Untrusted historical team',
  status: 1, statusText: 'Accepted', score: 100, totalTestCases: 10, passedTestCases: 10, time: 11, memory: 22,
  code: `${candidateId} secret code`, lang: 'cpp', testCases: [{ status: 1 }], subtasks: { score: 100 },
  createdAt: now, updatedAt: new Date(+now + 1000) });

function replace(t: TestContext, target: object, key: string, value: unknown) {
  const object = target as Record<string, unknown>, original = object[key];
  object[key] = value; t.after(() => { object[key] = original; });
}
function setup(t: TestContext, getSession = () => session) {
  replace(t, prisma.clientSession, 'findUnique', async () => getSession());
  replace(t, prisma.systemSetting, 'findUnique', async () => null);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('history must not call Hydro'); });
}
function request(input: Record<string, unknown> = {}, auth = token.token) {
  return new Request('http://localhost/api/client/contest/submissions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proctor-session-token': auth },
    body: JSON.stringify({ sessionId: session.id, ...input }) });
}
async function data(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data;
}
function members(t: TestContext) {
  replace(t, prisma.candidate, 'findMany', async ({ where, select }: any) => {
    assert.deepEqual(where, { examId: 'exam', teamName: 'Team A' });
    assert.deepEqual(select, { id: true, teamName: true });
    return [{ id: 'mate', teamName: 'Team A' }, { id: 'wrong-case', teamName: 'team a' }];
  });
}

test('team summaries use exact current membership in this exam and do not load source or testcase payloads', async t => {
  setup(t); members(t);
  replace(t, prisma.contestSubmission, 'findMany', async ({ where, select }: any) => {
    assert.deepEqual(where, { examId: 'exam', candidateId: { in: ['owner', 'mate'] } });
    assert.equal(select.code, undefined); assert.equal(select.testCases, undefined); assert.equal(select.subtasks, undefined);
    assert.equal(select.updatedAt, true);
    return [record('owner'), record('mate')];
  });
  const rows = await data(await submissions(request({ summaryOnly: true, candidateId: 'outside', actorKey: 'outside', teamName: 'Other Team' })));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 1, 'shared own-team verdict stays visible during XCPC freeze');
    assert.equal(row.canViewDetail, true); assert.equal(row.detailsLoaded, false);
    assert.equal(row.updatedAt, new Date(+now + 1000).toISOString());
    assert.equal(row.code, ''); assert.deepEqual(row.testCases, []); assert.deepEqual(row.subtasks, {});
    assert.equal(row.isOwn, row.id === 'submission-owner');
  }
});

test('detail reads use identical scope; forged identifiers never grant another team access', async t => {
  setup(t); members(t);
  replace(t, prisma.contestSubmission, 'findMany', async () => { assert.fail('details must not load full history'); });
  replace(t, prisma.contestSubmission, 'findFirst', async ({ where, select }: any) => {
    assert.deepEqual(where.candidateId, { in: ['owner', 'mate'] }); assert.equal(where.examId, 'exam');
    assert.equal(select.code, true); assert.equal(select.testCases, true);
    return where.id === 'submission-mate' ? record('mate') : null;
  });
  const row = await data(await submissions(request({ submissionId: 'submission-mate', summaryOnly: true })));
  assert.equal(row.detailsLoaded, true); assert.equal(row.isOwn, false); assert.equal(row.code, 'mate secret code');
  assert.equal(row.status, 1);
  assert.equal((await submissions(request({ submissionId: 'submission-outside', candidateId: 'outside', teamName: 'Other Team' }))).status, 404);
  assert.equal((await submissions(request({ submissionId: 'submission-mate' }, 'invalid'))).status, 401);
});

test('disabled sharing, individual exams, common accounts and blank team identities stay account-private', async t => {
  let current = session;
  setup(t, () => current);
  replace(t, prisma.candidate, 'findMany', async () => { assert.fail('account-private scope must not scan team members'); });
  replace(t, prisma.contestSubmission, 'findMany', async ({ where }: any) => {
    assert.deepEqual(where, { examId: 'exam', candidateId: 'owner' }); return [record('owner')];
  });
  for (const patch of [
    { exam: { ...exam, allowTeamSubmissionView: false } },
    { exam: { ...exam, contestType: 'INDIVIDUAL' } },
    { exam: { ...exam, teamAccountMode: 'TEAM_ACCOUNT' }, memberStudentId: 'member-1' },
    { exam: { ...exam, teamAccountMode: 'TEAM_ACCOUNT' }, memberStudentId: 'member-2' },
    { candidate: { ...candidate, teamName: '  ' } },
    { candidate: { ...candidate, teamName: null } },
  ]) {
    current = { ...session, ...patch };
    const rows = await data(await submissions(request()));
    assert.equal(rows.length, 1); assert.equal(rows[0].isOwn, true); assert.equal(rows[0].code, 'owner secret code');
  }
});

test('turning sharing off or moving a candidate removes prior detail access immediately', async t => {
  let enabled = true, teamName = 'Team A';
  setup(t, () => ({ ...session, exam: { ...exam, allowTeamSubmissionView: enabled }, candidate: { ...candidate, teamName } }));
  replace(t, prisma.candidate, 'findMany', async ({ where }: any) => where.teamName === 'Team A' ? [{ id: 'mate', teamName }] : []);
  replace(t, prisma.contestSubmission, 'findFirst', async ({ where }: any) => Array.isArray(where.candidateId?.in) ? record('mate') : null);
  assert.equal((await submissions(request({ submissionId: 'submission-mate' }))).status, 200);
  enabled = false;
  assert.equal((await submissions(request({ submissionId: 'submission-mate' }))).status, 404);
  enabled = true; teamName = 'Other Team';
  assert.equal((await submissions(request({ submissionId: 'submission-mate' }))).status, 404);
});

test('team sharing retains OI/KS scoring restrictions and public-test account isolation', async t => {
  let rule = 'OI'; setup(t, () => ({ ...session, exam: { ...exam, contestRule: rule } })); members(t);
  replace(t, prisma.contestSubmission, 'findFirst', async () => record('mate'));
  const oi = await data(await submissions(request({ submissionId: 'submission-mate' })));
  assert.equal(oi.resultHidden, true); assert.equal(oi.score, null); assert.deepEqual(oi.testCases, []);
  assert.equal(oi.code, 'mate secret code');
  rule = 'KS';
  const ks = await data(await submissions(request({ submissionId: 'submission-mate' })));
  assert.equal(ks.score, null); assert.equal(ks.status, 1);
  replace(t, prisma.systemSetting, 'findUnique', async () => ({ value: { examId: 'exam' } }));
  replace(t, prisma.contestSubmission, 'findMany', async ({ where }: any) => {
    assert.deepEqual(where, { examId: 'exam', candidateId: 'owner' }); return [];
  });
  assert.deepEqual(await data(await submissions(request())), []);
});

test('30 concurrent summary polls query each account once, with fresh authorization and no large fields or writes', async t => {
  let auth = 0, reads = 0;
  setup(t, () => { auth++; return { ...session, exam: { ...exam, allowTeamSubmissionView: false } }; });
  replace(t, prisma.contestSubmission, 'findMany', async ({ where, select }: any) => {
    reads++; assert.equal(where.candidateId, 'owner');
    assert.equal(select.code, undefined); assert.equal(select.testCases, undefined); return [record('owner')];
  });
  replace(t, prisma.contestSubmission, 'updateMany', async () => { assert.fail('polls must not write'); });
  const rows = await Promise.all(Array.from({ length: 30 }, async () => data(await submissions(request({ summaryOnly: true })))));
  assert.equal(auth, 30); assert.equal(reads, 30);
  rows.forEach(value => assert.equal(value[0].detailsLoaded, false));
});

test('initial contest uses the same team scope and optional summary projection', async t => {
  setup(t);
  replace(t, prisma.candidate, 'count', async () => 3);
  replace(t, prisma.examRoom, 'findFirst', async () => null);
  replace(t, prisma.candidate, 'findMany', async ({ select }: any) => select.id
    ? [{ id: 'mate', teamName: 'Team A' }] : [{ name: 'Mate', examNumber: '002', isTeamLeader: false }]);
  replace(t, prisma.contestSubmission, 'findMany', async ({ where, select }: any) => {
    assert.deepEqual(where, { examId: 'exam', candidateId: { in: ['owner', 'mate'] } });
    assert.equal(select.code, undefined); return [record('owner'), record('mate')];
  });
  const value = await data(await contest(new Request('http://localhost/api/client/contest?sessionId=session&summaryOnly=true', {
    headers: { 'x-proctor-session-token': token.token },
  })));
  assert.equal(value.contest.allowTeamSubmissionView, true);
  assert.equal(value.submissions.length, 2);
  value.submissions.forEach((row: any) => { assert.equal(row.detailsLoaded, false); assert.equal(row.code, ''); });
});

test('submit response and persisted attribution always belong to the authenticated account', async t => {
  setup(t, () => ({ ...session, exam: { ...exam, contestRule: 'OI', problems: [{ ...problem, problemType: 'objective' }] } }));
  replace(t, prisma.contestSubmission, 'create', async ({ data: row }: any) => {
    assert.equal(row.candidateId, 'owner'); assert.equal(row.examId, 'exam');
    assert.equal(row.actorKey, `${exam.examCode}:${candidate.examNumber}`);
    return { ...record('owner'), ...row };
  });
  const response = await submit(request({ pid: 1, lang: '_', code: '{"answer":"A"}', candidateId: 'mate', actorKey: 'mate' }));
  assert.equal(response.status, 201, await response.clone().text());
  const row = (await response.json()).data;
  assert.equal(row.isOwn, true); assert.equal(row.detailsLoaded, true); assert.equal(row.canViewDetail, true);
  assert.equal(row.code, '{"answer":"A"}'); assert.equal(row.resultHidden, true);
});
