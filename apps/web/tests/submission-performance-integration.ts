import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { triggerJudgeStatusSync } from '../src/lib/deferred-judge';
import { POST as submissions } from '../src/app/api/client/contest/submissions/route';

// Run against a disposable database after prisma db push. The test removes all
// of its own records and stubs Hydro; no deployed judge receives submissions.
const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_submission_qa', 'requires an isolated submission QA database');
const marker = `submission-qa-${crypto.randomUUID()}`;
const originalFetch = globalThis.fetch;
let examId = '';

async function main() {
  const start = new Date(Date.now() - 60_000);
  const exam = await prisma.exam.create({ data: {
    name: marker, examCode: crypto.randomBytes(5).toString('hex'),
    startAt: start, latestStartAt: start, endAt: new Date(Date.now() + 3600_000), durationMinutes: 60,
    platform: 'HYDRO', platformBaseUrl: 'https://judge.example.org', platformContestId: 'local',
    contestType: 'INDIVIDUAL', contestRule: 'IOI', published: true, showTestCaseCount: true,
    showObjectiveScore: true, rules: '',
    problems: { create: { order: 0, hydroProblemId: '1', title: 'Load fixture', content: 'statement'.repeat(16_000) } },
  }, include: { problems: true } });
  examId = exam.id;
  const candidates = await Promise.all(Array.from({ length: 30 }, (_, index) => prisma.candidate.create({ data: {
    examId, examNumber: String(index).padStart(3, '0'), password: 'test-only', name: `Candidate ${index}`, seatNo: String(index + 1),
  } })));
  const sessions = await Promise.all(candidates.map(async candidate => {
    const credentials = createClientSessionToken();
    const session = await prisma.clientSession.create({ data: {
      examId, candidateId: candidate.id, desktopDeviceId: `${marker}-${candidate.id}`,
      desktopTokenHash: credentials.tokenHash, startedAt: start, status: 'IN_EXAM',
    } });
    return { session, token: credentials.token };
  }));
  const rows = candidates.flatMap((candidate, candidateIndex) => Array.from({ length: 10 }, (_, index) => ({
    id: `${marker}-${String(candidateIndex * 10 + index).padStart(3, '0')}`,
    examId, candidateId: candidate.id, problemId: exam.problems[0].id,
    actorKey: candidate.examNumber, candidateExamNumber: candidate.examNumber,
    lang: 'cpp', code: `${candidate.id}\n${'x'.repeat(16 * 1024)}`,
    status: 22, statusText: 'Waiting', deferredJudge: true,
    hydroRecordId: `${marker}-remote-${candidateIndex * 10 + index}`,
    testCases: [], subtasks: {}, createdAt: start,
  })));
  await prisma.contestSubmission.createMany({ data: rows });
  let remoteCalls = 0;
  globalThis.fetch = async () => { remoteCalls++; throw new Error('Hydro is intentionally offline'); };
  const request = (input: typeof sessions[number]) => new Request('http://localhost/api/client/contest/submissions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': input.token },
    body: JSON.stringify({ sessionId: input.session.id }),
  });
  const timings: number[] = [];
  await Promise.all(sessions.map(async input => {
    const began = performance.now();
    const response = await submissions(request(input));
    assert.equal(response.status, 200, await response.clone().text());
    const { data } = await response.json();
    timings.push(performance.now() - began);
    assert.equal(data.length, 300);
    assert.equal(data.filter((row: any) => row.canViewDetail).length, 10);
    assert.ok(data.filter((row: any) => !row.canViewDetail).every((row: any) => row.code === '' && row.testCases.length === 0));
  }));
  assert.equal(remoteCalls, 0, '30 candidate polls must continue without Hydro');
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ fixture: '30 candidates, 300 submissions, 16 KiB code each, Hydro offline',
    successfulPolls: timings.length, p50Ms: Math.round(timings[14]), p95Ms: Math.round(timings[28]), remoteCalls }));

  // Oldest 200 records stay pending. Records 201..300 finish remotely and must
  // still be found on the second worker tick, with real SQL keyset pagination.
  const queried: string[][] = [];
  globalThis.fetch = async (_url, init) => {
    const { ids } = JSON.parse(String(init?.body));
    queried.push(ids);
    return Response.json({ ok: true, data: ids.map((id: string) => {
      const index = Number(id.split('-').at(-1));
      const complete = index >= 200;
      return { id, status: complete ? 1 : 22, statusText: complete ? 'Accepted' : 'Waiting',
        score: complete ? 100 : 0, time: 0, memory: 0, testCases: [], subtasks: {},
        judgeAt: complete ? new Date().toISOString() : null };
    }) });
  };
  await triggerJudgeStatusSync();
  await triggerJudgeStatusSync();
  assert.deepEqual(queried.map(ids => ids.length), [200, 100]);
  assert.equal(await prisma.contestSubmission.count({ where: { examId, judgeAt: { not: null }, score: 100 } }), 100);
  assert.equal(await prisma.contestSubmission.count({ where: { examId, judgeAt: null } }), 200);
  const latest = await submissions(request(sessions[29]));
  const { data } = await latest.json();
  assert.ok(data.filter((row: any) => row.canViewDetail).every((row: any) => row.status === 1));
  await prisma.clientSession.update({ where: { id: sessions[0].session.id }, data: { revokedAt: new Date() } });
  assert.equal((await submissions(request(sessions[0]))).status, 401);
  console.log('PASS: real database 30-way local polling, private detail projections, 300-record judge sweep, completed-result visibility and immediate revocation.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  globalThis.fetch = originalFetch;
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.$disconnect();
});
