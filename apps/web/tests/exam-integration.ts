import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/lib/db';
import { saveExam } from '../src/lib/exam-save';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { canManageExam } from '../src/lib/permissions';
import { judgeDeferredSubmissions } from '../src/lib/deferred-judge';
import { verifyCandidateIdentity } from '../src/lib/candidate-verify';
import { createClientSessionToken } from '../src/lib/client-auth';
import { POST as submit } from '../src/app/api/client/contest/submit/route';
import { examCodeDate } from '../src/lib/exam-code';

const marker = `qa-${crypto.randomUUID()}`;
const realFetch = globalThis.fetch;
const calls: string[] = [];
let failHydro = false;
const userIds: string[] = [];
const examIds: string[] = [];
async function main() {
  const creator = await prisma.user.create({ data: { username: `${marker}-owner`, role: 'SUPER_ADMIN' } }); userIds.push(creator.id);
  const manager = await prisma.user.create({ data: { username: `${marker}-manager`, role: 'ADMIN' } }); userIds.push(manager.id);
  const stranger = await prisma.user.create({ data: { username: `${marker}-stranger`, role: 'ADMIN' } }); userIds.push(stranger.id);
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (failHydro) throw new Error('Hydro unavailable for QA');
    const data = path === '/api/proctor/languages' ? [{ id: 'cc.cc17', name: 'C++17' }, { id: 'rust', name: 'Rust' }] : path.includes('/problem/') ? { id: path.split('/').pop(), title: 'QA problem', config: { type: 'default' }, content: 'test', files: [] }
      : { id: 'qa-record', status: 1, score: 100, testCases: [{ status: 1 }], time: 1, memory: 1, judgeAt: new Date().toISOString() };
    return Response.json({ ok: true, data });
  };
  const input = CreateExamSchema.parse({ name: marker, startAt: '2099-12-29T23:30:00Z', latestStartAt: '2099-12-29T23:30:00Z', endAt: '2100-01-01', durationMinutes: 120, contestRule: 'KS', platform: 'HYDRO', contestType: 'INDIVIDUAL', administratorIds: [manager.id], problemIds: ['1', '2'], allowedLanguages: ['cpp'], allowPrint: true, rules: '# QA rules' });
  const exams = await Promise.all(Array.from({ length: 4 }, async () => {
    const exam = await saveExam(input, creator.id); examIds.push(exam.id); return exam;
  }));
  assert.equal(new Set(exams.map(exam => exam.examCode)).size, 4);
  assert.ok(exams.every(exam => /^20991230\d{2}$/.test(exam.examCode)));
  assert.equal(examCodeDate(new Date('2026-09-27T16:00:00Z')), '20260928');
  const exam = exams[0];
  assert.equal(exam.saveFullRecording, false);
  assert.equal(await canManageExam(manager, exam.id), true);
  assert.equal(await canManageExam(stranger, exam.id), false);
  const changed = await saveExam({ ...input, saveFullRecording: true, name: `${marker} edited`, startAt: new Date('2099-12-31'), latestStartAt: new Date('2099-12-31'), problemIds: ['2', '1'] }, manager.id, exam.id);
  assert.equal(changed.saveFullRecording, true);
  assert.equal(changed.examCode, exam.examCode);
  assert.deepEqual(changed.allowedLanguages, ['cpp']);
  assert.equal(changed.allowPrint, true);
  assert.equal(changed.showTestCaseCount, true);
  const reordered = await prisma.examProblem.findMany({ where: { examId: exam.id }, orderBy: { order: 'asc' } });
  assert.deepEqual(reordered.map(problem => problem.hydroProblemId), ['2', '1']);
  const identity = { examNumber: 'same-number', password: 'qa-password', studentId: 'qa-student', name: 'QA Candidate', school: 'QA School', college: 'QA College', seatNo: '1' };
  const one = await prisma.candidate.create({ data: { ...identity, examId: exams[0].id } });
  const two = await prisma.candidate.create({ data: { ...identity, examId: exams[1].id } });
  assert.equal((await verifyCandidateIdentity({ ...identity, examCode: exams[0].examCode })).candidate?.id, one.id);
  assert.equal((await verifyCandidateIdentity({ ...identity, examCode: exams[1].examCode })).candidate?.id, two.id);
  assert.equal((await verifyCandidateIdentity({ ...identity, examCode: exams[0].examCode, examId: exams[1].id })).ok, false);
  const objective = await prisma.examProblem.update({ where: { id: reordered[0].id }, data: { problemType: 'objective' } });
  await prisma.exam.update({ where: { id: exam.id }, data: { startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 3600_000) } });
  const token = createClientSessionToken();
  const session = await prisma.clientSession.create({ data: { examId: exam.id, candidateId: one.id, desktopDeviceId: marker, desktopTokenHash: token.tokenHash, startedAt: new Date(), status: 'IN_EXAM' } });
  const request = (pid: number, lang: string) => new Request('http://localhost/api/client/contest/submit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': token.token }, body: JSON.stringify({ sessionId: session.id, pid, lang, code: 'answer' }) });
  const rejected = await submit(request(1, 'rust'));
  assert.equal(rejected.status, 400);
  const programming = await submit(request(1, 'cc.cc17'));
  assert.equal(programming.status, 201);
  const programResult = (await programming.json()).data;
  assert.equal(programResult.score, null); assert.equal(programResult.passedTestCases, 0); assert.equal(programResult.totalTestCases, 0);
  // Candidate requests return the durable queued record before asynchronous judging.
  async function waitForJudge(id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await prisma.contestSubmission.findUniqueOrThrow({ where: { id } });
      if (row.judgeAt) return row;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('QA judge worker did not finish');
  }
  assert.equal((await waitForJudge(programResult.id)).passedTestCases, 1);
  assert.deepEqual(programResult.testCases, []);
  const judgeCallsBeforeObjective = calls.filter(path => path === '/api/proctor/judge').length;
  const objectiveResponse = await submit(request(2, '_'));
  assert.equal(objectiveResponse.status, 201);
  const objectiveResult = (await objectiveResponse.json()).data;
  assert.equal(objectiveResult.score, null); assert.equal(objectiveResult.passedTestCases, null);
  const ksJudged = await waitForJudge(objectiveResult.id);
  assert.equal(ksJudged.deferredJudge, false);
  assert.equal(calls.filter(path => path === '/api/proctor/judge').length, judgeCallsBeforeObjective + 1);
  // Deferred objective judging still applies to IOI when grades are hidden.
  await prisma.exam.update({ where: { id: exam.id }, data: { contestRule: 'IOI', showObjectiveScore: false } });
  const deferredResponse = await submit(request(2, '_'));
  assert.equal(deferredResponse.status, 201);
  const deferredResult = (await deferredResponse.json()).data;
  const submission = await prisma.contestSubmission.findUniqueOrThrow({ where: { id: deferredResult.id } });
  assert.equal(submission.deferredJudge, true);
  assert.equal(submission.hydroRecordId, null);
  const before = calls.length;
  await judgeDeferredSubmissions(exam.id);
  assert.equal(calls.length, before, 'objective was sent to Hydro before exam end');
  await prisma.exam.update({ where: { id: exam.id }, data: { endAt: new Date(Date.now() - 1000) } });
  await Promise.all([judgeDeferredSubmissions(exam.id), judgeDeferredSubmissions(exam.id)]);
  assert.equal(calls.length, before + 1, 'concurrent workers duplicated judge request');
  const judged = await prisma.contestSubmission.findUniqueOrThrow({ where: { id: submission.id } });
  assert.equal(judged.deferredJudge, false); assert.equal(judged.score, 100);
  await assert.rejects(saveExam({ ...input, problemIds: ['1'] }, manager.id, exam.id), /已有提交/);
  failHydro = true;
  const count = await prisma.exam.count({ where: { createdById: creator.id } });
  await assert.rejects(saveExam({ ...input, problemIds: ['3'] }, creator.id), /Hydro unavailable/);
  assert.equal(await prisma.exam.count({ where: { createdById: creator.id } }), count);
  console.log('PASS: concurrent unique codes; immutable codes; manager permissions; atomic save; reordering; language enforcement; opt-in recording settings; asynchronous KS judging and count-only response; cross-exam candidate matching; deferred objective judging and worker leases.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  globalThis.fetch = realFetch;
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});
