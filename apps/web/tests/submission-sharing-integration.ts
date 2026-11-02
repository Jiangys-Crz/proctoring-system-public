// Run only against the disposable QA database; optionally exercise a built HTTP server.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { POST as submissions } from '../src/app/api/client/contest/submissions/route';
import { GET as contest } from '../src/app/api/client/contest/route';
import { GET as contestState } from '../src/app/api/client/contest/state/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_submission_sharing_qa');
const base = process.env.PERFORMANCE_QA_BASE;
if (base) assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const marker = `sharing-${randomUUID()}`;
const now = new Date();
const exams: string[] = [];
type Identity = { id: string; candidateId: string; token: string };
async function call(identity: Identity, input: Record<string, unknown> = {}, auth = identity.token) {
  const init = { method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': auth },
    body: JSON.stringify({ sessionId: identity.id, ...input }) };
  const path = '/api/client/contest/submissions';
  return base ? fetch(`${base}${path}`, init) : submissions(new Request(`http://localhost${path}`, init));
}
async function read(identity: Identity, stateOnly = false, summaryOnly = true) {
  const path = `/api/client/contest${stateOnly ? '/state' : ''}?sessionId=${identity.id}&summaryOnly=${summaryOnly}`;
  const init = { headers: { 'x-proctor-session-token': identity.token } };
  return base ? fetch(`${base}${path}`, init) : (stateOnly ? contestState : contest)(new Request(`http://localhost${path}`, init));
}
async function data(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data;
}
async function createExam() {
  const exam = await prisma.exam.create({ data: {
    name: marker, examCode: String(randomInt(1_000_000_000, 10_000_000_000)),
    startAt: new Date(+now - 600_000), latestStartAt: new Date(+now - 600_000), endAt: new Date(+now + 3_600_000),
    durationMinutes: 70, scoreboardFrozenAt: new Date(+now - 60_000), platform: 'HYDRO', platformBaseUrl: 'http://127.0.0.1:1',
    platformContestId: 'local', contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS', contestRule: 'XCPC',
    published: true, allowTeamSubmissionView: false, showTestCaseCount: true, rules: 'Synthetic submission sharing test',
    problems: { create: { order: 0, title: 'Fixture', hydroProblemId: '1', content: 'Fixture only' } },
  }, include: { problems: true } });
  exams.push(exam.id); return exam;
}

try {
  const exam = await createExam();
  const otherExam = await createExam();
  const candidates = Array.from({ length: 100 }, (_, index) => ({
    id: `${marker}-candidate-${index}`, examId: exam.id, examNumber: String(index), name: `Candidate ${index}`,
    teamName: index === 99 ? 'team 0' : `Team ${Math.floor(index / 3)}`,
    password: 'qa-only', seatNo: String(index), startedAt: exam.startAt,
  }));
  const outsider = { ...candidates[0], id: `${marker}-other-exam-candidate`, examId: otherExam.id };
  await prisma.candidate.createMany({ data: [...candidates, outsider] });
  const identities: Identity[] = [];
  const sessions = candidates.map((candidate, index) => {
    const credentials = createClientSessionToken();
    const id = `${marker}-session-${index}`;
    identities.push({ id, candidateId: candidate.id, token: credentials.token });
    return { id, examId: exam.id, candidateId: candidate.id, desktopDeviceId: id,
      desktopTokenHash: credentials.tokenHash, status: 'IN_EXAM' as const, startedAt: exam.startAt };
  });
  await prisma.clientSession.createMany({ data: sessions });
  const code = '// large private source\n'.repeat(1500);
  const records = [...candidates, outsider].flatMap((candidate, index) => Array.from({ length: index === 100 ? 1 : 10 }, (_, sequence) => ({
    id: `${marker}-submission-${index}-${sequence}`, examId: candidate.examId, candidateId: candidate.id,
    problemId: candidate.examId === exam.id ? exam.problems[0].id : otherExam.problems[0].id,
    actorKey: `untrusted-actor-${index}`, candidateExamNumber: candidate.examNumber, candidateName: candidate.name,
    teamName: 'Historical names do not grant access', lang: 'cpp', code, status: 1, statusText: 'Accepted', score: 100,
    totalTestCases: 16, passedTestCases: 16, time: 32, memory: 64,
    testCases: Array.from({ length: 16 }, () => ({ status: 1, message: 'private judge detail '.repeat(20) })),
    subtasks: { score: 100 }, createdAt: new Date(+now + sequence), judgeAt: now,
  })));
  for (let offset = 0; offset < records.length; offset += 100) await prisma.contestSubmission.createMany({ data: records.slice(offset, offset + 100) });
  const owner = identities[0];
  const full = await data(await call(owner));
  assert.equal(full.length, 10); full.forEach((row: any) => { assert.equal(row.isOwn, true); assert.equal(row.code, code); });
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const latencies: number[] = [];
  let summaryBytes = 0;
  const start = performance.now();
  await Promise.all(identities.map(async identity => {
    const started = performance.now();
    const rows = await data(await call(identity, { summaryOnly: true, candidateId: outsider.id, teamName: 'Team 0', admin: true }));
    latencies.push(performance.now() - started);
    assert.equal(rows.length, 10);
    rows.forEach((row: any) => {
      assert.equal(row.isOwn, true); assert.equal(row.detailsLoaded, false); assert.equal(row.code, '');
      assert.deepEqual(row.testCases, []); assert.equal(row.submittedBy.username, candidates.find(candidate => candidate.id === identity.candidateId)!.examNumber);
      assert.equal(row.status, 1); assert.ok(row.updatedAt);
    });
    if (identity === owner) summaryBytes = Buffer.byteLength(JSON.stringify(rows));
  }));
  const elapsedMs = Math.round(performance.now() - start);
  const p95Ms = Math.round(latencies.sort((a, b) => a - b)[Math.floor(latencies.length * .95)]);
  assert.ok(summaryBytes < fullBytes / 10, 'summary response must omit large source/testcase payloads');
  const before = await data(await read(owner, true));
  assert.equal(before.session.allowTeamSubmissionView, false);
  assert.equal(before.submissions, undefined); assert.equal(before.problems, undefined);
  const fullContest = await data(await read(owner, false, false));
  const fullContestBytes = Buffer.byteLength(JSON.stringify(fullContest));
  assert.equal(fullContest.submissions.length, 10);
  const stateLatencies: number[] = [];
  let stateBytes = 0;
  const stateStarted = performance.now();
  await Promise.all(identities.map(async identity => {
    const started = performance.now();
    const state = await data(await read(identity, true));
    stateLatencies.push(performance.now() - started);
    assert.equal(state.session.id, identity.id);
    assert.equal(typeof state.revision, 'string');
    for (const field of ['problems', 'submissions', 'files', 'user', 'contest']) assert.equal(state[field], undefined);
    if (identity === owner) stateBytes = Buffer.byteLength(JSON.stringify(state));
  }));
  const stateElapsedMs = Math.round(performance.now() - stateStarted);
  const stateP95Ms = Math.round(stateLatencies.sort((a, b) => a - b)[Math.floor(stateLatencies.length * .95)]);
  assert.ok(stateBytes < fullContestBytes / 100, 'state polls must omit statements, languages, roster and historical source code');
  await prisma.exam.update({ where: { id: exam.id }, data: { allowTeamSubmissionView: true } });
  const sharedState = await data(await read(owner, true));
  assert.equal(sharedState.session.allowTeamSubmissionView, true); assert.notEqual(sharedState.revision, before.revision);
  const shared = await data(await call(owner, { summaryOnly: true }));
  assert.equal(shared.length, 30, 'only the three exact-name teammates share records');
  assert.equal(shared.filter((row: any) => row.isOwn).length, 10);
  assert.ok(shared.every((row: any) => row.status === 1), 'same team sees own results during freeze');
  const mateId = `${marker}-submission-1-0`;
  const detail = await data(await call(owner, { submissionId: mateId }));
  assert.equal(detail.isOwn, false); assert.equal(detail.detailsLoaded, true); assert.equal(detail.code, code);
  for (const id of [`${marker}-submission-3-0`, `${marker}-submission-99-0`, `${marker}-submission-100-0`]) {
    assert.equal((await call(owner, { submissionId: id, candidateId: outsider.id, actorKey: 'untrusted-actor-100' })).status, 404);
  }
  const initial = await data(await read(owner));
  assert.equal(initial.revision, sharedState.revision); assert.equal(initial.submissions.length, 30);
  assert.ok(initial.submissions.every((row: any) => row.detailsLoaded === false && row.code === ''));
  await prisma.candidate.update({ where: { id: candidates[1].id }, data: { teamName: 'Moved Team' } });
  assert.equal((await call(owner, { submissionId: mateId })).status, 404, 'membership removal applies without waiting for cache expiry');
  assert.equal((await data(await call(owner, { summaryOnly: true }))).length, 20);
  await prisma.exam.update({ where: { id: exam.id }, data: { allowTeamSubmissionView: false } });
  assert.equal((await call(owner, { submissionId: `${marker}-submission-2-0` })).status, 404);
  assert.equal((await data(await read(owner))).submissions.length, 10);
  await prisma.exam.update({ where: { id: exam.id }, data: { allowTeamSubmissionView: true, teamAccountMode: 'TEAM_ACCOUNT' } });
  assert.equal((await data(await call(owner))).length, 10, 'shared account ownership cannot expand to other same-name accounts');
  const credentials = createClientSessionToken();
  const member = await prisma.clientSession.create({ data: { examId: exam.id, candidateId: owner.candidateId,
    desktopDeviceId: `${marker}-second-member`, desktopTokenHash: credentials.tokenHash, status: 'IN_EXAM',
    memberName: 'Second member', memberStudentId: 'qa-second-member' } });
  const memberRows = await data(await call({ id: member.id, candidateId: owner.candidateId, token: credentials.token }));
  assert.equal(memberRows.length, 10); assert.ok(memberRows.every((row: any) => row.isOwn));
  assert.equal((await call(owner, {}, 'invalid')).status, 401);
  await prisma.clientSession.update({ where: { id: owner.id }, data: { revokedAt: now } });
  assert.equal((await call(owner, { submissionId: `${marker}-submission-0-0` })).status, 401);
  assert.equal((await read(owner, true)).status, 401);
  console.log(JSON.stringify({ mode: base ? 'production HTTP + MySQL' : 'route handlers + MySQL',
    accounts: 100, records: 1000, concurrentSummaryReads: 100, elapsedMs, p95Ms,
    fullBytes, summaryBytes, payloadReductionPercent: Math.round((1 - summaryBytes / fullBytes) * 1000) / 10,
    concurrentStateReads: 100, stateElapsedMs, stateP95Ms, fullContestBytes, stateBytes,
    statePayloadReductionPercent: Math.round((1 - stateBytes / fullContestBytes) * 1000) / 10 }));
  console.log('PASS: account/team boundaries, exact-name membership, cross-exam isolation, summary/detail parity, frozen own-team results, state revisions, immediate switch/removal and token revocation.');
} finally {
  if (exams.length) await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  await prisma.$disconnect();
}
