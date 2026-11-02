import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { createSessionToken } from '../src/lib/auth';
import { POST as leaderboard } from '../src/app/api/client/contest/leaderboard/route';

// Use the disposable performance database. An optional production fixture
// server at PERFORMANCE_QA_BASE exercises cookie auth and administrator reads.
const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_performance_qa');
const base = process.env.PERFORMANCE_QA_BASE;
if (base) assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const marker = `contest-read-qa-${crypto.randomUUID()}`;
const users: string[] = [];
let examId = '';
const findCandidates = prisma.candidate.findMany;
const findSubmissions = prisma.contestSubmission.findMany;
const originalFetch = globalThis.fetch;

async function main() {
  const startAt = new Date(Date.now() - 60_000);
  const exam = await prisma.exam.create({ data: {
    name: marker, examCode: crypto.randomBytes(5).toString('hex'),
    startAt, latestStartAt: startAt, endAt: new Date(Date.now() + 3600_000), durationMinutes: 60,
    platform: 'HYDRO', platformBaseUrl: 'http://127.0.0.1:1', platformContestId: 'local',
    contestType: 'INDIVIDUAL', contestRule: 'IOI', published: true,
    showTestCaseCount: true, showObjectiveScore: true, rules: '',
    problems: { create: { order: 0, hydroProblemId: '1', title: 'Load fixture', content: 'statement'.repeat(16_000) } },
  }, include: { problems: true } });
  examId = exam.id;
  const candidates = await Promise.all(Array.from({ length: 30 }, (_, index) => prisma.candidate.create({ data: {
    examId, examNumber: String(index).padStart(3, '0'), password: 'qa-only', name: `Candidate ${index}`, seatNo: String(index + 1),
  } })));
  const sessions = await Promise.all(candidates.map(async candidate => {
    const credentials = createClientSessionToken();
    const session = await prisma.clientSession.create({ data: {
      examId, candidateId: candidate.id, desktopDeviceId: `${marker}-${candidate.id}`,
      desktopTokenHash: credentials.tokenHash, startedAt: startAt, status: 'IN_EXAM',
    } });
    return { session, token: credentials.token };
  }));
  const rows = candidates.flatMap((candidate, candidateIndex) => Array.from({ length: 10 }, (_, index) => ({
    id: `${marker}-${candidateIndex}-${index}`, examId, candidateId: candidate.id, problemId: exam.problems[0].id,
    actorKey: candidate.examNumber, candidateExamNumber: candidate.examNumber,
    lang: 'cpp', code: `${candidate.id}\n${'x'.repeat(8 * 1024)}`,
    status: candidateIndex === 0 && index === 9 ? 22 : 1,
    statusText: candidateIndex === 0 && index === 9 ? 'Waiting' : 'Accepted',
    score: candidateIndex === 0 && index === 9 ? 0 : 100,
    hydroRecordId: `${marker}-remote-${candidateIndex}-${index}`,
    judgeAt: candidateIndex === 0 && index === 9 ? null : new Date(),
    testCases: [], subtasks: {}, createdAt: new Date(+startAt + (index + 1) * 1000),
  })));
  await prisma.contestSubmission.createMany({ data: rows });
  let candidateReads = 0, submissionReads = 0, remoteCalls = 0;
  prisma.candidate.findMany = (async (args: any) => { candidateReads++; return findCandidates.call(prisma.candidate, args); }) as typeof findCandidates;
  prisma.contestSubmission.findMany = (async (args: any) => { submissionReads++; return findSubmissions.call(prisma.contestSubmission, args); }) as typeof findSubmissions;
  globalThis.fetch = async () => { remoteCalls++; throw new Error('Hydro is intentionally offline'); };
  const request = (input: typeof sessions[number]) => new Request('http://localhost/api/client/contest/leaderboard', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': input.token },
    body: JSON.stringify({ sessionId: input.session.id }),
  });
  const timings: number[] = [];
  await Promise.all(sessions.map(async input => {
    const began = performance.now();
    const response = await leaderboard(request(input));
    assert.equal(response.status, 200, await response.clone().text());
    const { data } = await response.json();
    timings.push(performance.now() - began);
    assert.equal(data.rows.length, 30);
    assert.ok(data.rows.every((row: any) => row.score === 100));
  }));
  assert.equal(remoteCalls, 0);
  assert.ok(candidateReads < 30 && submissionReads < 30, 'overlapping polls must coalesce actual database reads');
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ fixture: '30 leaderboard polls, 300 submissions with 8 KiB source, 8 database connections',
    successfulPolls: timings.length, candidateReads, submissionReads, p50Ms: Math.round(timings[14]), p95Ms: Math.round(timings[28]), remoteCalls }));

  await prisma.contestSubmission.updateMany({ where: { examId, candidateId: candidates[0].id, status: 1 }, data: { score: 50 } });
  const updated = (await (await leaderboard(request(sessions[0]))).json()).data;
  assert.equal(updated.rows.find((row: any) => row.username === candidates[0].examNumber).score, 50);
  await prisma.clientSession.update({ where: { id: sessions[0].session.id }, data: { revokedAt: new Date() } });
  assert.equal((await leaderboard(request(sessions[0]))).status, 401);
  prisma.candidate.findMany = findCandidates;
  prisma.contestSubmission.findMany = findSubmissions;
  globalThis.fetch = originalFetch;

  if (base) {
    const admin = await prisma.user.create({ data: { username: `${marker}-admin`, role: 'SUPER_ADMIN' } });
    users.push(admin.id);
    const outsider = await prisma.user.create({ data: { username: `${marker}-outsider`, role: 'ADMIN' } });
    users.push(outsider.id);
    const headers = { cookie: `cwnupaa_proctor_session=${createSessionToken(admin)}` };
    const outsiderHeaders = { cookie: `cwnupaa_proctor_session=${createSessionToken(outsider)}` };
    const path = `/api/exams/${examId}`;
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}${path}/submissions`, { headers })));
    for (const response of responses) {
      assert.equal(response.status, 200, await response.clone().text());
      const { data } = await response.json();
      assert.equal(data.length, 300);
      assert.equal(data.find((row: any) => row.id === rows[9].id).code, rows[9].code);
      assert.equal(data.find((row: any) => row.id === rows[9].id).status, 22);
    }
    await prisma.exam.update({ where: { id: examId }, data: { contestRule: 'KS' } });
    const grading = await fetch(`${base}${path}/grading`, { headers });
    assert.equal(grading.status, 200, await grading.clone().text());
    const { data } = await grading.json();
    assert.equal(data.rows.length, 30);
    const latest = data.rows.find((row: any) => row.candidate.id === candidates[0].id).cells[0];
    assert.equal(latest.submissionId, rows[9].id);
    assert.equal(latest.status, 22, 'latest pending KS submission cannot fall back to an older score');
    assert.equal(latest.code, rows[9].code);
    for (const endpoint of ['submissions', 'grading']) {
      assert.equal((await fetch(`${base}${path}/${endpoint}`, { headers: outsiderHeaders })).status, 403);
      assert.equal((await fetch(`${base}${path}/${endpoint}`)).status, 401);
    }
    console.log('PASS: production administrator submission/grading HTTP reads preserve pending results and code; unrelated administrators and unauthenticated requests are denied.');
  }
  console.log('PASS: real database concurrent leaderboard coalescing, fresh scores and immediate revocation.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  prisma.candidate.findMany = findCandidates;
  prisma.contestSubmission.findMany = findSubmissions;
  globalThis.fetch = originalFetch;
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});
