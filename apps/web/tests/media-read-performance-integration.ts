// Run only against an explicitly supplied disposable MySQL database.
// PERFORMANCE_TEST_DATABASE_URL=... pnpm exec tsx tests/media-read-performance-integration.ts
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type User } from '@prisma/client';

if (!process.env.PERFORMANCE_TEST_DATABASE_URL) throw new Error('Set PERFORMANCE_TEST_DATABASE_URL to a disposable test database');
const database = new URL(process.env.PERFORMANCE_TEST_DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/proctor_[a-z_]*qa(?:_[a-z_]+)?$/, 'requires an isolated QA database');
const db = new PrismaClient({ datasourceUrl: process.env.PERFORMANCE_TEST_DATABASE_URL, log: [{ level: 'query', emit: 'event' }] });
(globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma = db;
const { authorizeMediaRead } = await import('../src/lib/media-read-access');
const { canManageExam } = await import('../src/lib/permissions');
const channels = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'];
let queries = 0;
db.$on('query', () => { queries++; });
const prefix = `media-read-${randomUUID()}`;
const examIds: string[] = [], userIds: string[] = [];

// The previous ORM implementation is retained here as an independent oracle:
// the optimized SQL must preserve its permission and room-policy decisions.
async function previousAuthorization(user: User, sessionId: string, channel: string, checkRequired = true) {
  const session = await db.clientSession.findUnique({ where: { id: sessionId },
    select: { candidateId: true, examId: true, exam: { select: { requireFrontCamera: true, requireMiniProgram: true } } } });
  if (!session) return 404;
  if (!(await canManageExam(user, session.examId)) && !(await db.examRoomCandidate.count({ where: {
    candidateId: session.candidateId, room: { examId: session.examId, proctors: { some: { userId: user.id } } }
  } }))) return 403;
  if (checkRequired && channel !== 'DESKTOP_SCREEN') {
    const room = await db.examRoom.findFirst({ where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } },
      select: { requireFrontCamera: true, requireSecondCamera: true } });
    const required = channel === 'DESKTOP_CAMERA' ? room?.requireFrontCamera ?? session.exam.requireFrontCamera : room?.requireSecondCamera ?? session.exam.requireMiniProgram;
    if (!required) return 409;
  }
  return 200;
}

async function currentAuthorization(user: User, sessionId: string, channel: string, checkRequired = true) {
  try { await authorizeMediaRead(user, sessionId, channel, checkRequired); return 200; }
  catch (error) {
    if (error && typeof error === 'object' && 'status' in error) return error.status;
    throw error;
  }
}

try {
  const users = await Promise.all(['creator', 'administrator', 'proctor', 'other-room', 'other-exam', 'outsider', 'super'].map(async name => {
    const user = await db.user.create({ data: { username: `${prefix}-${name}`, role: name === 'super' ? 'SUPER_ADMIN' : 'ADMIN' } });
    userIds.push(user.id);
    return user;
  }));
  const [creator, administrator, proctor, otherRoomProctor, otherExamProctor, outsider] = users;
  const now = new Date();
  const exams = await Promise.all([0, 1].map(async i => {
    const exam = await db.exam.create({ data: {
      name: `${prefix}-${i}`, examCode: String(randomInt(1_000_000_000, 10_000_000_000)),
      startAt: new Date(now.getTime() - 600_000), latestStartAt: now, endAt: new Date(now.getTime() + 3_600_000),
      durationMinutes: 60, platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: prefix,
      contestType: 'INDIVIDUAL', requireFrontCamera: false, requireMiniProgram: true, rules: prefix,
      ...(i === 0 ? { createdById: creator.id } : {})
    } });
    examIds.push(exam.id);
    return exam;
  }));
  const [exam, otherExam] = exams;
  const rooms = await Promise.all([0, 1, 2, 3].map(i => db.examRoom.create({ data: {
    examId: exam.id, name: `${prefix}-${i}`, requireFrontCamera: Boolean(i & 1), requireSecondCamera: Boolean(i & 2),
    proctors: { create: { userId: proctor.id } }
  } })));
  const spareRoom = await db.examRoom.create({ data: { examId: exam.id, name: `${prefix}-empty`, proctors: { create: { userId: otherRoomProctor.id } } } });
  const foreignRoom = await db.examRoom.create({ data: { examId: otherExam.id, name: `${prefix}-foreign`, proctors: { create: { userId: otherExamProctor.id } } } });
  await db.examAdministrator.create({ data: { examId: exam.id, userId: administrator.id } });
  const candidates = Array.from({ length: 31 }, (_, i) => ({ id: `${prefix}-c${i}`, examId: exam.id, examNumber: `${prefix}-${i}`, password: prefix, seatNo: String(i) }));
  await db.candidate.createMany({ data: candidates });
  await db.examRoomCandidate.createMany({ data: candidates.slice(0, 30).map((candidate, i) => ({ candidateId: candidate.id, roomId: rooms[i % 4].id })) });
  // Even a malformed cross-exam room assignment cannot grant stream access.
  await db.examRoomCandidate.create({ data: { candidateId: candidates[0].id, roomId: foreignRoom.id } });
  const sessions = candidates.map((candidate, i) => ({ id: `${prefix}-s${i}`, candidateId: candidate.id, examId: exam.id, status: 'IN_EXAM' as const }));
  await db.clientSession.createMany({ data: sessions });

  let compared = 0;
  for (const user of users) {
    for (const sessionId of [...sessions.slice(0, 4).map(session => session.id), sessions[30].id, `${prefix}-missing`]) {
      for (const channel of channels) {
        assert.equal(await currentAuthorization(user, sessionId, channel), await previousAuthorization(user, sessionId, channel), `${user.username}/${sessionId}/${channel}`);
        compared++;
      }
    }
  }
  await db.examRoomCandidate.create({ data: { candidateId: candidates[1].id, roomId: spareRoom.id } });
  for (const user of [creator, proctor, otherRoomProctor]) {
    for (const channel of channels) {
      assert.equal(await currentAuthorization(user, sessions[1].id, channel), await previousAuthorization(user, sessions[1].id, channel), 'multiple room memberships retain existing permission and first-room policy behavior');
      compared++;
    }
  }
  await db.examRoomCandidate.delete({ where: { roomId_candidateId: { roomId: spareRoom.id, candidateId: candidates[1].id } } });
  assert.equal(await currentAuthorization({ ...outsider, id: "x' OR 1=1 --" }, sessions[0].id, 'DESKTOP_SCREEN'), 403, 'user IDs remain bound SQL parameters');
  assert.equal(await currentAuthorization(proctor, sessions[0].id, 'MOBILE_CAMERA', false), 200, 'WHEP cleanup retains access to a disabled channel');
  await db.examRoom.update({ where: { id: rooms[0].id }, data: { requireSecondCamera: true } });
  assert.equal(await currentAuthorization(proctor, sessions[0].id, 'MOBILE_CAMERA'), 200);
  await db.examRoom.update({ where: { id: rooms[0].id }, data: { requireSecondCamera: false } });
  assert.equal(await currentAuthorization(proctor, sessions[0].id, 'MOBILE_CAMERA'), 409, 'changed room policy applies to the next request');
  await db.examRoomProctor.delete({ where: { roomId_userId: { roomId: rooms[0].id, userId: proctor.id } } });
  assert.equal(await currentAuthorization(proctor, sessions[0].id, 'DESKTOP_SCREEN'), 403, 'removed proctor loses access immediately');
  await db.examRoomProctor.create({ data: { roomId: rooms[0].id, userId: proctor.id } });
  await db.examAdministrator.delete({ where: { examId_userId: { examId: exam.id, userId: administrator.id } } });
  assert.equal(await currentAuthorization(administrator, sessions[0].id, 'DESKTOP_SCREEN'), 403, 'removed administrator loses access immediately');
  await db.clientSession.update({ where: { id: sessions[0].id }, data: { status: 'FINISHED', revokedAt: now } });
  await db.exam.update({ where: { id: exam.id }, data: { endAt: new Date(now.getTime() - 1) } });
  assert.equal(await currentAuthorization(creator, sessions[0].id, 'DESKTOP_SCREEN'), await previousAuthorization(creator, sessions[0].id, 'DESKTOP_SCREEN'), 'read authorization preserves the existing historical-session behavior');

  await db.examRoom.updateMany({ where: { examId: exam.id }, data: { requireFrontCamera: true, requireSecondCamera: true } });
  async function measure(name: string, authorize: typeof previousAuthorization) {
    queries = 0;
    const began = performance.now();
    const statuses = await Promise.all(sessions.slice(0, 30).flatMap(session => channels.map(channel => authorize(proctor, session.id, channel))));
    assert.equal(statuses.every(status => status === 200), true);
    const result = { scenario: '30 candidates / 3 live channels', implementation: name, requests: statuses.length, queries, durationMs: Math.round(performance.now() - began) };
    console.log(JSON.stringify(result));
    return result;
  }
  const before = await measure('previous', previousAuthorization);
  const after = await measure('optimized', currentAuthorization as typeof previousAuthorization);
  assert.equal(after.queries, 30, 'one live query shared by the three simultaneous channel requests per candidate');
  assert.ok(before.queries >= after.queries * 6, 'reduces round trips even when Prisma batches simultaneous findUnique reads');
  console.log(`PASS: ${compared} permission/policy comparisons; immediate revocation; bound parameters; independent cross-exam checks.`);
} finally {
  if (examIds.length) await db.exam.deleteMany({ where: { id: { in: examIds } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
}
