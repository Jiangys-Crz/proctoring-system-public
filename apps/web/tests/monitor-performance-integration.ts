import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

// No deployed data: each run owns one exam and three temporary users.
const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/proctor_[a-z_]*qa$/);
const db = new PrismaClient({ log: [{ level: 'query', emit: 'event' }] });
(globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma = db;
const { loadMonitorExam, loadMonitorData } = await import('../src/lib/monitor-state-data');
const { getExamAccess, canAccessExam, canManageExam } = await import('../src/lib/permissions');
const { publicDto } = await import('../src/lib/public-dto');
const { createSessionToken } = await import('../src/lib/auth');
const base = process.env.PERFORMANCE_QA_BASE;
if (base) assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const prefix = `monitor-perf-${randomUUID()}`;
let examId = '';
const users: string[] = [];
let queries = 0;
db.$on('query', () => { queries++; });

try {
  const [owner, proctor, outsider] = await Promise.all(['owner', 'proctor', 'outsider'].map(async name => {
    const user = await db.user.create({ data: { username: `${prefix}-${name}`, passwordHash: 'private-hash' } });
    users.push(user.id);
    return user;
  }));
  const now = new Date();
  const exam = await db.exam.create({ data: {
    name: prefix, examCode: String(randomInt(1_000_000_000, 10_000_000_000)), createdById: owner.id,
    startAt: now, latestStartAt: now, endAt: new Date(now.getTime() + 7_200_000), durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: 'https://judge.invalid', platformContestId: prefix,
    contestType: 'INDIVIDUAL', rules: 'test', externalBoardApiKey: 'private-api-key',
  } });
  examId = exam.id;
  await db.examProblem.createMany({ data: Array.from({ length: 10 }, (_, order) => ({
    examId, order, hydroProblemId: String(order), title: `Problem ${order}`,
    content: 'S'.repeat(128 * 1024), config: { privateJudgeData: 'X'.repeat(32 * 1024) },
    files: [{ name: 'fixture.txt', metadata: 'Y'.repeat(16 * 1024) }],
  })) });
  const rooms = await Promise.all([0, 1].map(index => db.examRoom.create({ data: { examId, name: `room-${index}` } })));
  await db.examRoomProctor.create({ data: { roomId: rooms[0].id, userId: proctor.id } });
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    id: `${prefix}-${index}`, examId, examNumber: String(index), name: `Candidate ${index}`,
    seatNo: String(index), password: 'private-password',
  }));
  await db.candidate.createMany({ data: candidates });
  await db.examRoomCandidate.createMany({ data: candidates.map((candidate, index) => ({ candidateId: candidate.id, roomId: rooms[index % 2].id })) });
  await db.clientSession.createMany({ data: candidates.map(candidate => ({
    id: `${candidate.id}-session`, candidateId: candidate.id, examId, status: 'IN_EXAM',
    desktopTokenHash: 'private-desktop-token', miniProgramTokenHash: 'private-phone-token',
  })) });
  await db.loginRequest.createMany({ data: candidates.map(candidate => ({ candidateId: candidate.id, examId })) });
  await db.alert.createMany({ data: candidates.map(candidate => ({ candidateId: candidate.id, examId, type: 'CLIENT_OFFLINE', message: 'fixture' })) });
  await db.printJob.createMany({ data: candidates.flatMap(candidate => [0, 1].map(index => ({
    candidateId: candidate.id, examId, title: `Document ${index}`, examNumber: candidate.examNumber,
    mode: 'PHYSICAL', status: 'PENDING', content: 'P'.repeat(32 * 1024),
  }))) });

  queries = 0;
  assert.equal(await canAccessExam(owner, examId), true);
  assert.equal(await canManageExam(owner, examId), true);
  const previousPermissionQueries = queries;
  queries = 0;
  assert.deepEqual(await getExamAccess(owner, examId), { accessible: true, manageable: true });
  assert.equal(queries, 1);
  assert.equal(previousPermissionQueries, 2);
  assert.deepEqual(await getExamAccess(proctor, examId), { accessible: true, manageable: false });
  assert.deepEqual(await getExamAccess(outsider, examId), { accessible: false, manageable: false });

  const [currentExam, currentData, previousExam, previousPrintJobs] = await Promise.all([
    loadMonitorExam(examId), loadMonitorData(examId, owner.id, true),
    db.exam.findUniqueOrThrow({ where: { id: examId }, include: { problems: { orderBy: { order: 'asc' } } } }),
    db.printJob.findMany({ where: { examId }, orderBy: { createdAt: 'desc' } }),
  ]);
  assert(currentExam);
  assert.equal(currentExam.problems.length, 10);
  assert.deepEqual(currentExam.problems.map(problem => [problem.id, problem.title, problem.order, problem.scorePercent]),
    previousExam.problems.map(problem => [problem.id, problem.title, problem.order, problem.scorePercent]));
  assert.equal(currentData.candidates.length, 30);
  assert.equal(currentData.sessions.length, 30);
  assert.equal(currentData.loginRequests.length, 30);
  assert.equal(currentData.alerts.length, 30);
  assert.equal(currentData.printJobs.length, 60);
  assert.equal(currentData.rooms.length, 2);
  assert.ok(currentData.printJobs.every(job => !('content' in job)));
  assert.ok(currentExam.problems.every(problem => !('content' in problem) && !('config' in problem) && !('files' in problem)));
  const current = JSON.stringify(publicDto({ exam: currentExam, ...currentData }));
  const previous = JSON.stringify(publicDto({ ...currentData, exam: previousExam, printJobs: previousPrintJobs }));
  assert.ok(!current.includes('private-'));
  assert.ok(current.length < previous.length / 10, 'monitor polls must not transport statements or print bodies');
  // Preview still retrieves every byte directly from its authorized document route's source.
  assert.equal((await db.printJob.findUniqueOrThrow({ where: { id: currentData.printJobs[0].id } })).content.length, 32 * 1024);

  const scoped = await loadMonitorData(examId, proctor.id, false);
  const allowed = new Set(candidates.filter((_, index) => index % 2 === 0).map(candidate => candidate.id));
  assert.equal(scoped.candidates.length, 15);
  assert.equal(scoped.rooms.length, 1);
  assert.equal(scoped.printJobs.length, 30);
  assert.ok(scoped.candidates.every(candidate => allowed.has(candidate.id)));
  for (const collection of [scoped.sessions, scoped.loginRequests, scoped.alerts, scoped.printJobs]) {
    assert.ok(collection.every(row => row.candidateId && allowed.has(row.candidateId)));
  }
  if (base) {
    const path = `${base}/api/exams/${examId}`;
    const headers = (user: typeof owner) => ({ cookie: `cwnupaa_proctor_session=${createSessionToken(user)}` });
    const ownerHeaders = headers(owner), proctorHeaders = headers(proctor), outsiderHeaders = headers(outsider);
    const stateResponse = await fetch(`${path}/state`, { headers: ownerHeaders });
    assert.equal(stateResponse.status, 200, await stateResponse.clone().text());
    const stateText = await stateResponse.text();
    const state = JSON.parse(stateText).data;
    assert.equal(state.candidates.length, 30);
    assert.equal(state.printJobs.length, 60);
    assert.equal(state.exam.problems.length, 10);
    assert.ok(state.printJobs.every((job: Record<string, unknown>) => !('content' in job)));
    assert.ok(state.exam.problems.every((problem: Record<string, unknown>) => !('content' in problem) && !('config' in problem) && !('files' in problem)));
    assert.ok(!stateText.includes('private-'));
    assert.ok(Buffer.byteLength(stateText) < Buffer.byteLength(previous) / 10);
    const proctorState = await fetch(`${path}/state`, { headers: proctorHeaders });
    assert.equal(proctorState.status, 200, await proctorState.clone().text());
    const proctorData = (await proctorState.json()).data;
    assert.equal(proctorData.candidates.length, 15);
    assert.ok(proctorData.candidates.every((candidate: { id: string }) => allowed.has(candidate.id)));
    const ownedJob = currentData.printJobs.find(job => allowed.has(job.candidateId))!;
    const otherJob = currentData.printJobs.find(job => !allowed.has(job.candidateId))!;
    const document = `${path}/print-jobs/${ownedJob.id}/document`;
    for (const authorizedHeaders of [ownerHeaders, proctorHeaders]) {
      const response = await fetch(document, { headers: authorizedHeaders });
      assert.equal(response.status, 200, await response.clone().text());
      const html = await response.text();
      const text = [...html.matchAll(/<pre class="content">([\s\S]*?)<\/pre>/g)].map(match => match[1]).join('').replace(/\n/g, '');
      assert.equal(text, 'P'.repeat(32 * 1024), 'authorized print preview preserves the entire document');
    }
    assert.equal((await fetch(`${path}/print-jobs/${otherJob.id}/document`, { headers: proctorHeaders })).status, 403);
    for (const endpoint of [`${path}/state`, document]) {
      assert.equal((await fetch(endpoint, { headers: outsiderHeaders })).status, 403);
      assert.equal((await fetch(endpoint)).status, 401);
    }
    const httpTimings = await Promise.all(Array.from({ length: 30 }, async () => {
      const began = performance.now();
      const response = await fetch(`${path}/state`, { headers: ownerHeaders });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).data.candidates.length, 30);
      return performance.now() - began;
    }));
    httpTimings.sort((a, b) => a - b);
    console.log(JSON.stringify({ scenario: 'production HTTP / 30 parallel monitor polls', responseBytes: Buffer.byteLength(stateText), p95Ms: Math.round(httpTimings[28]) }));
  }
  await db.examRoomProctor.delete({ where: { roomId_userId: { roomId: rooms[0].id, userId: proctor.id } } });
  assert.deepEqual(await getExamAccess(proctor, examId), { accessible: false, manageable: false });
  assert.equal((await loadMonitorData(examId, proctor.id, false)).candidates.length, 0);
  if (base) {
    const headers = { cookie: `cwnupaa_proctor_session=${createSessionToken(proctor)}` };
    assert.equal((await fetch(`${base}/api/exams/${examId}/state`, { headers })).status, 403, 'revocation takes effect on the next HTTP poll');
  }

  // Pause an old proctor read after fetching candidates, revoke only one of
  // two rooms, then verify the next authorized request cannot join old data.
  await db.examRoomProctor.createMany({ data: rooms.map(room => ({ roomId: room.id, userId: proctor.id })) });
  const originalCandidates = db.candidate.findMany.bind(db.candidate);
  let releaseOld!: () => void, oldReadStarted!: () => void;
  const oldRelease = new Promise<void>(done => { releaseOld = done; });
  const oldStarted = new Promise<void>(done => { oldReadStarted = done; });
  let firstCandidateRead = true;
  db.candidate.findMany = (async (...args: Parameters<typeof originalCandidates>) => {
    const rows = await originalCandidates(...args);
    if (firstCandidateRead) { firstCandidateRead = false; oldReadStarted(); await oldRelease; }
    return rows;
  }) as typeof db.candidate.findMany;
  try {
    const oldRead = loadMonitorData(examId, proctor.id, false);
    await oldStarted;
    await db.examRoomProctor.delete({ where: { roomId_userId: { roomId: rooms[0].id, userId: proctor.id } } });
    assert.deepEqual(await getExamAccess(proctor, examId), { accessible: true, manageable: false });
    const freshRead = await loadMonitorData(examId, proctor.id, false);
    assert.equal(freshRead.candidates.length, 15);
    assert.ok(freshRead.candidates.every(candidate => !allowed.has(candidate.id)), 'partial revocation must not join the old pending room data');
    releaseOld();
    assert.equal((await oldRead).candidates.length, 30, 'fixture must actually hold a pre-revocation snapshot');
  } finally { releaseOld(); db.candidate.findMany = originalCandidates; }

  // A large, newly acknowledged history must never hide older open incidents.
  await db.alert.createMany({ data: Array.from({ length: 90 }, (_, index) => ({
    examId, candidateId: candidates[0].id, type: 'CLIENT_OFFLINE' as const,
    message: `acknowledged-${index}`, acknowledgedAt: new Date(), createdAt: new Date(Date.now() + index),
  })) });
  const alertPage = await loadMonitorData(examId, owner.id, true);
  assert.equal(alertPage.alerts.length, 80);
  assert.equal(alertPage.alerts.filter(alert => !alert.acknowledgedAt).length, 30);
  assert.ok(alertPage.alerts.slice(0, 30).every(alert => !alert.acknowledgedAt));
  await db.alert.updateMany({ where: { examId, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
  assert.ok((await loadMonitorData(examId, owner.id, true)).alerts.every(alert => alert.acknowledgedAt), 'acknowledgement appears immediately on the next completed poll');

  queries = 0;
  await loadMonitorData(examId, owner.id, true);
  const singleReadQueries = queries;
  queries = 0;
  const timings = await Promise.all(Array.from({ length: 30 }, async (_, index) => {
    const began = performance.now();
    const data = await loadMonitorData(examId, index % 2 ? owner.id : outsider.id, true);
    assert.equal(data.printJobs.length, 60);
    return performance.now() - began;
  }));
  const sharedReadQueries = queries;
  assert.equal(sharedReadQueries, singleReadQueries, '30 overlapping manager reads must issue only one set of database queries');
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ scenario: '30 candidates, 10 large problems, 60 print jobs',
    previousBytes: Buffer.byteLength(previous), currentBytes: Buffer.byteLength(current),
    concurrentReads: timings.length, queries: { singleRead: singleReadQueries, parallelReads: sharedReadQueries, previousParallelReads: singleReadQueries * timings.length }, p95Ms: Math.round(timings[28]),
    managerPermissionQueries: { before: previousPermissionQueries, after: 1 } }));
  console.log('PASS: monitor metadata, print source retention, room isolation, immediate permission revocation, shared reads and pending-first alert pagination.');
} finally {
  if (examId) await db.exam.delete({ where: { id: examId } });
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
}
