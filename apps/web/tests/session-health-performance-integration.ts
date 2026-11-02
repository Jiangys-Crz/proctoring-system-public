// Run only against an explicitly supplied disposable MySQL database.
// PERFORMANCE_TEST_DATABASE_URL=... pnpm exec tsx tests/session-health-performance-integration.ts
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

if (!process.env.PERFORMANCE_TEST_DATABASE_URL) throw new Error('Set PERFORMANCE_TEST_DATABASE_URL to a disposable test database');
const database = new URL(process.env.PERFORMANCE_TEST_DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/proctor_[a-z_]*qa(?:_[a-z_]+)?$/, 'requires an isolated QA database');
const db = new PrismaClient({ datasourceUrl: process.env.PERFORMANCE_TEST_DATABASE_URL, log: [{ level: 'query', emit: 'event' }] });
(globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma = db;
const { markStaleSessionsOffline } = await import('../src/lib/session-health');
let locks = 0, queries = 0, hydrated = 0, largestPage = 0;
const findMany = db.clientSession.findMany.bind(db.clientSession);
db.clientSession.findMany = (async (...args: Parameters<typeof findMany>) => {
  const rows = await findMany(...args);
  hydrated += rows.length;
  largestPage = Math.max(largestPage, rows.length);
  return rows;
}) as typeof db.clientSession.findMany;
const candidateCount = 1000;
db.$on('query', event => { queries++; if (/FOR UPDATE/i.test(event.query)) locks++; });
const prefix = `health-perf-${randomUUID()}`;
let examId: string | undefined;
try {
  const now = new Date(), startedAt = new Date(now.getTime() - 600_000);
  const exam = await db.exam.create({ data: {
    name: prefix, examCode: String(randomInt(1_000_000_000, 10_000_000_000)),
    startAt: startedAt, latestStartAt: new Date(now.getTime() + 3_600_000), endAt: new Date(now.getTime() + 7_200_000),
    durationMinutes: 120, platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: prefix,
    contestType: 'INDIVIDUAL', requireMiniProgram: true, requireFrontCamera: false, rules: prefix
  } });
  examId = exam.id;
  const rooms = await Promise.all([false, true].map(requireSecondCamera => db.examRoom.create({ data: {
    examId: exam.id, name: `${prefix}-${requireSecondCamera}`, requireSecondCamera, requireFrontCamera: false
  } })));
  const candidates = Array.from({ length: candidateCount }, (_, i) => ({ id: `${prefix}-${i}`, examId: exam.id, examNumber: `${prefix}-${i}`, password: prefix, seatNo: String(i), startedAt, status: 'ONLINE_NORMAL' as const }));
  await db.candidate.createMany({ data: candidates });
  await db.examRoomCandidate.createMany({ data: candidates.map((candidate, i) => ({ candidateId: candidate.id, roomId: rooms[i % 2].id })) });
  await db.clientSession.createMany({ data: candidates.map((candidate, i) => ({
    id: `${prefix}-session-${i}`, candidateId: candidate.id, examId: exam.id,
    status: 'IN_EXAM' as const, createdAt: startedAt, approvedAt: startedAt, startedAt,
    lastDesktopSeenAt: now, lastMiniProgramSeenAt: i % 2 ? now : null,
    desktopTokenHash: 'desktop-token', miniProgramTokenHash: i % 2 ? 'mobile-token' : null
  })) });
  locks = 0; queries = 0; hydrated = 0; largestPage = 0;
  const began = performance.now();
  await Promise.all(Array.from({ length: 8 }, () => markStaleSessionsOffline(exam.id)));
  const durationMs = Math.round(performance.now() - began);
  assert.equal(locks, 0, 'healthy candidates and 8 concurrent admin polls must not lock any sessions');
  assert.equal(queries, 1, 'healthy candidates need only one narrow scan');
  assert.equal(hydrated, 0, 'optional phone NULL must not hydrate healthy sessions');
  console.log(JSON.stringify({ scenario: `${candidateCount} healthy sessions / 8 simultaneous polls`, durationMs, queries, hydrated, sessionWriteLocks: locks }));
  assert.equal(await db.alert.count({ where: { examId: exam.id } }), 0);

  // A phone-only survivor must keep the session valid, with its outage written
  // once. Subsequent dashboard refreshes must not compete with its heartbeat.
  const expiredAt = new Date(Date.now() - 180_000);
  await db.clientSession.updateMany({ where: { examId: exam.id, miniProgramTokenHash: { not: null } }, data: { lastDesktopSeenAt: expiredAt } });
  assert.equal(await markStaleSessionsOffline(exam.id), candidateCount / 2);
  assert.ok(largestPage <= 200, `hydration page too large: ${largestPage}`);
  locks = 0; hydrated = 0; queries = 0;
  assert.equal(await markStaleSessionsOffline(exam.id), 0);
  assert.equal(locks, 0, 'reported single-side outages must not cause repeated locking');
  assert.equal(hydrated, 0);
  assert.equal(queries, 1);
  console.log(JSON.stringify({ scenario: `${candidateCount / 2} reported outages / ${candidateCount / 2} healthy`, queries, hydrated, sessionWriteLocks: locks, largestTransitionPage: largestPage }));
  assert.equal(await db.clientSession.count({ where: { examId: exam.id, revokedAt: { not: null } } }), 0);

  await db.clientSession.updateMany({ where: { examId: exam.id }, data: { lastDesktopSeenAt: expiredAt, lastMiniProgramSeenAt: expiredAt } });
  await markStaleSessionsOffline(exam.id);
  assert.equal(await db.clientSession.count({ where: { examId: exam.id, status: 'FINISHED', revokedAt: { not: null }, desktopTokenHash: null, miniProgramTokenHash: null } }), candidateCount);
  assert.equal(await db.candidate.count({ where: { examId: exam.id, startedAt } }), candidateCount, 'expiry preserves all personal examination clocks');
  console.log('PASS: no healthy-session locks; one-time offline transitions; all fully offline sessions revoked with clocks preserved.');
} finally {
  if (examId) await db.exam.delete({ where: { id: examId } });
  await db.$disconnect();
}
