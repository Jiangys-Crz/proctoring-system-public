// Run only against a disposable local database named session_cleanup_qa.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { cleanupPublicTestState, PUBLIC_TEST_MARKER } from '../src/lib/public-test';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1', 'requires an isolated local test database');
assert.equal(database.pathname, '/session_cleanup_qa', 'must not run against application data');
const marker = `cleanup-qa-${randomUUID()}`;
const exams: string[] = [];
let markerCreated = false;
const desktop = createClientSessionToken(), mobile = createClientSessionToken();
const now = new Date(), old = new Date(now.getTime() - 86_400_000);

async function createExam(publicTest: boolean) {
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(now.getTime() - 300_000), latestStartAt: new Date(now.getTime() + 3_600_000),
    endAt: new Date(now.getTime() + 7_200_000), durationMinutes: 30,
    platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: 'local',
    contestType: 'INDIVIDUAL', contestRule: 'IOI', flexible: true, requireMiniProgram: true, requireFrontCamera: true, rules: marker,
  } });
  exams.push(exam.id);
  const candidate = await prisma.candidate.create({ data: { examId: exam.id, name: marker,
    examNumber: marker, password: 'permanent-test-password', seatNo: 'QA', status: 'APPROVED',
    createdAt: old, updatedAt: now,
    ...(publicTest ? { publicTestAccount: { create: { externalUserId: marker } } } : {}),
  } });
  const session = await prisma.clientSession.create({ data: { id: `${publicTest ? 'test_' : ''}${randomUUID()}`,
    examId: exam.id, candidateId: candidate.id, status: 'APPROVED', approvedAt: now,
    desktopDeviceId: `${marker}-desktop`, miniProgramDeviceId: `${marker}-phone`,
    desktopTokenHash: desktop.tokenHash, miniProgramTokenHash: mobile.tokenHash,
    lastDesktopSeenAt: now, lastMiniProgramSeenAt: now,
  } });
  return { exam, candidate, session };
}

async function beat(sessionId: string, side: 'DESKTOP' | 'MINIPROGRAM', expected = 200) {
  const response = await heartbeat(new Request('http://localhost/api/client/heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${side === 'DESKTOP' ? desktop.token : mobile.token}` },
    body: JSON.stringify({ sessionId, deviceId: `${marker}-${side === 'DESKTOP' ? 'desktop' : 'phone'}`, side }),
  }));
  const body = await response.json();
  assert.equal(response.status, expected, body.message);
  return body;
}

try {
  assert.equal(await prisma.systemSetting.findUnique({ where: { key: PUBLIC_TEST_MARKER } }), null, 'requires a fresh disposable database');
  const trial = await createExam(true), formal = await createExam(false);
  await prisma.systemSetting.create({ data: { key: PUBLIC_TEST_MARKER, value: { examId: trial.exam.id } } });
  markerCreated = true;
  for (const seconds of [0, 30, 60, 90]) {
    await cleanupPublicTestState(new Date(now.getTime() + seconds * 1000));
    for (const fixture of [trial, formal]) {
      await beat(fixture.session.id, 'DESKTOP');
      await beat(fixture.session.id, 'MINIPROGRAM');
      const session = await prisma.clientSession.findUniqueOrThrow({ where: { id: fixture.session.id } });
      assert.equal(session.desktopTokenHash, desktop.tokenHash);
      assert.equal(session.miniProgramTokenHash, mobile.tokenHash);
      assert.equal(session.startedAt, null);
    }
  }
  // Even an old activity timestamp cannot make a still-active login disposable.
  await prisma.candidate.update({ where: { id: trial.candidate.id }, data: { updatedAt: old } });
  await cleanupPublicTestState();
  await beat(trial.session.id, 'DESKTOP');
  await beat(trial.session.id, 'MINIPROGRAM');

  // Formal candidates are never selected by the trial cleanup, including finished ones.
  await prisma.candidate.update({ where: { id: formal.candidate.id }, data: { status: 'FINISHED', updatedAt: old } });
  await cleanupPublicTestState();
  assert.ok(await prisma.clientSession.findUnique({ where: { id: formal.session.id } }));
  for (const status of ['WAITING_REVIEW', 'APPROVED', 'IN_EXAM'] as const) {
    const startedAt = status === 'IN_EXAM' ? now : null;
    await prisma.candidate.update({ where: { id: formal.candidate.id }, data: { startedAt, status: status === 'WAITING_REVIEW' ? 'REQUESTING' : 'ONLINE_NORMAL' } });
    await prisma.clientSession.update({ where: { id: formal.session.id }, data: { status, startedAt } });
    assert.equal((await beat(formal.session.id, 'DESKTOP')).data.session.status, status);
    assert.equal((await beat(formal.session.id, 'MINIPROGRAM')).data.session.status, status);
  }
  const stale = new Date(Date.now() - 600_000);
  await prisma.clientSession.update({ where: { id: formal.session.id }, data: { lastMiniProgramSeenAt: stale } });
  await beat(formal.session.id, 'DESKTOP');
  await beat(formal.session.id, 'MINIPROGRAM');
  await prisma.clientSession.update({ where: { id: formal.session.id }, data: { lastDesktopSeenAt: stale } });
  await beat(formal.session.id, 'MINIPROGRAM');
  await beat(formal.session.id, 'DESKTOP');
  await prisma.clientSession.update({ where: { id: formal.session.id }, data: { lastDesktopSeenAt: stale, lastMiniProgramSeenAt: stale } });
  assert.equal((await beat(formal.session.id, 'DESKTOP', 410)).code, 'CLIENT_SESSION_REVOKED');
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: formal.candidate.id } })).startedAt?.getTime(), now.getTime());

  await prisma.candidate.update({ where: { id: trial.candidate.id }, data: { status: 'FINISHED', updatedAt: new Date(now.getTime() - 120_000) } });
  await cleanupPublicTestState();
  assert.equal(await prisma.clientSession.findUnique({ where: { id: trial.session.id } }), null);
  const permanent = await prisma.candidate.findUniqueOrThrow({ where: { id: trial.candidate.id }, include: { publicTestAccount: true } });
  assert.equal(permanent.status, 'NOT_REQUESTED');
  assert.equal(permanent.password, trial.candidate.password);
  assert.equal(permanent.publicTestAccount?.externalUserId, marker);
  console.log('PASS: old trial accounts stay authenticated through cleanup; active logins survive stale activity; formal review/start/exam and single-side recovery remain valid; two-sided logout preserves time; finished trials retain credentials.');
} finally {
  if (markerCreated) await prisma.systemSetting.deleteMany({ where: { key: PUBLIC_TEST_MARKER } });
  await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  await prisma.$disconnect();
}
