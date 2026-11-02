// Run against a disposable local MySQL database with connection_limit=1.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { PUBLIC_TEST_MARKER } from '../src/lib/public-test';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';
import { POST as finish } from '../src/app/api/client/session/finish/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/session_pool_qa', 'never run against application data');
assert.equal(database.searchParams.get('connection_limit'), '1');
const marker = `pool-qa-${randomUUID()}`;
const exams: string[] = [];
let markerCreated = false;
const desktop = createClientSessionToken(), mobile = createClientSessionToken();
const now = new Date();

async function fixture(publicTest: boolean) {
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(now.getTime() - 300_000), latestStartAt: new Date(now.getTime() + 3_600_000),
    endAt: new Date(now.getTime() + 7_200_000), durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: 'local',
    contestType: 'INDIVIDUAL', contestRule: 'IOI', flexible: true,
    requireMiniProgram: true, requireFrontCamera: true, rules: marker,
  } });
  exams.push(exam.id);
  const sessions = [];
  for (let i = 0; i < 25; i++) {
    const candidate = await prisma.candidate.create({ data: {
      examId: exam.id, examNumber: `${marker}-${i}`, name: marker, password: marker,
      seatNo: 'QA', status: 'ONLINE_NORMAL', startedAt: now,
    } });
    const session = await prisma.clientSession.create({ data: {
      examId: exam.id, candidateId: candidate.id, status: 'IN_EXAM', approvedAt: now, startedAt: now,
      desktopDeviceId: marker, miniProgramDeviceId: `${marker}-phone`,
      desktopTokenHash: desktop.tokenHash, miniProgramTokenHash: mobile.tokenHash,
      lastDesktopSeenAt: now, lastMiniProgramSeenAt: now,
    } });
    sessions.push({ session, candidate, publicTest });
  }
  return { exam, sessions };
}

async function beat(id: string, side: 'DESKTOP' | 'MINIPROGRAM', system?: object, expected = 200) {
  const response = await heartbeat(new Request('http://localhost/api/client/heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${side === 'DESKTOP' ? desktop.token : mobile.token}` },
    body: JSON.stringify({ sessionId: id, side, deviceId: side === 'DESKTOP' ? marker : `${marker}-phone`, system }),
  }));
  const body = await response.json();
  assert.equal(response.status, expected, `heartbeat returned ${response.status}`);
  return body;
}

try {
  assert.equal(await prisma.systemSetting.findUnique({ where: { key: PUBLIC_TEST_MARKER } }), null);
  const trial = await fixture(true), formal = await fixture(false);
  await prisma.systemSetting.create({ data: { key: PUBLIC_TEST_MARKER, value: { examId: trial.exam.id } } });
  markerCreated = true;
  const fixtures = [...trial.sessions, ...formal.sessions];
  // This first heartbeat also reproduces the old second-connection deadlock.
  await beat(fixtures[0].session.id, 'DESKTOP');
  const started = performance.now();
  for (let round = 0; round < 3; round++) {
    const results = await Promise.all(fixtures.flatMap(({ session }) => [
      beat(session.id, 'DESKTOP'), beat(session.id, 'MINIPROGRAM'),
    ]));
    assert.equal(results.length, 100);
    for (const [index, result] of results.entries()) {
      assert.equal(result.data.requirements.isPublicTest, fixtures[Math.floor(index / 2)].publicTest);
      assert.equal(result.data.session.status, 'IN_EXAM');
      assert.equal('publicTest' in result.data, false, 'internal flag must not change the API');
    }
  }
  for (const { session, candidate } of fixtures) {
    const current = await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.ok(current.lastDesktopSeenAt! > now && current.lastMiniProgramSeenAt! > now);
    assert.equal(current.desktopTokenHash, desktop.tokenHash);
    assert.equal(current.miniProgramTokenHash, mobile.tokenHash);
    assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).updatedAt.getTime(), candidate.updatedAt.getTime(), 'stable heartbeat must not rewrite candidate');
  }
  const abnormal = formal.sessions[0];
  await Promise.all([beat(abnormal.session.id, 'DESKTOP', { processes: ['qa-process'] }), beat(abnormal.session.id, 'MINIPROGRAM')]);
  assert.equal(await prisma.alert.count({ where: { sessionId: abnormal.session.id } }), 1);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: abnormal.candidate.id } })).status, 'ONLINE_ABNORMAL');
  const ending = await Promise.all([trial.sessions[0], formal.sessions[1]].map(async ({ session, candidate }) => {
    const response = await finish(new Request('http://localhost/api/client/session/finish', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${desktop.token}` },
      body: JSON.stringify({ sessionId: session.id, confirmationText: `考号${candidate.examNumber}，姓名${candidate.name}确认结束考试` }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await beat(session.id, 'DESKTOP')).data.session.status, 'FINISHED');
    return session.id;
  }));
  assert.equal(await prisma.alert.count({ where: { sessionId: ending[0] } }), 0);
  assert.equal(await prisma.alert.count({ where: { sessionId: ending[1] } }), 1);
  assert.equal(await prisma.mediaSegment.count({ where: { examId: { in: exams } } }), 0);
  console.log(`PASS: 300 concurrent formal/trial heartbeats with one DB connection, both tokens preserved, candidate writes skipped, abnormal alert and finish policies retained (${Math.round(performance.now() - started)} ms).`);
} finally {
  if (markerCreated) await prisma.systemSetting.deleteMany({ where: { key: PUBLIC_TEST_MARKER } });
  await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  await prisma.$disconnect();
}
