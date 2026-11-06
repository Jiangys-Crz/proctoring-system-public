import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type SessionStatus } from '@prisma/client';

const url = process.env.PERFORMANCE_TEST_DATABASE_URL;
if (!url) throw new Error('Set PERFORMANCE_TEST_DATABASE_URL to an isolated QA database');
const database = new URL(url);
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/proctor_[a-z_]*qa(?:_[a-z_]+)?$/);
const db = new PrismaClient({ datasourceUrl: url });
(globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma = db;
const { healthSessionIds } = await import('../src/lib/session-health-scan');
const prefix = `health-scan-${randomUUID()}`;
const examIds: string[] = [];
const now = new Date();
const at = (offset: number | null) => offset === null ? null : new Date(now.getTime() + offset);
type Case = {
  name: string; transition: boolean; revocation?: boolean;
  desktop?: number | null; phone?: number | null; created?: number; approved?: number | null;
  room?: boolean; requirePhone?: boolean; desktopOffline?: boolean; phoneOffline?: boolean;
  end?: number; flexible?: boolean; rule?: 'XCPC' | 'ACM' | 'OI';
  candidateStarted?: number | null; sessionStarted?: number | null; status?: SessionStatus;
};
const cases: Case[] = [
  { name: 'healthy optional phone missing', transition: false },
  { name: 'room false overrides required phone', room: false, requirePhone: true, transition: false },
  { name: 'room true overrides optional phone', room: true, transition: true },
  { name: 'no room inherits required phone', requirePhone: true, transition: true },
  { name: 'no room inherits optional phone', transition: false },
  { name: 'desktop 20 second boundary', desktop: -20_000, transition: false },
  { name: 'desktop stale', desktop: -20_001, transition: true },
  { name: 'missing desktop uses approved time', desktop: null, transition: true, revocation: true },
  { name: 'unapproved recent session waits', desktop: null, approved: null, created: -30_000, transition: false },
  { name: 'fully offline exact 120 second boundary', desktop: -120_000, transition: true, revocation: true },
  { name: 'optional phone cannot keep desktop session alive', desktop: -120_000, phone: 0, transition: true, revocation: true },
  { name: 'required phone keeps reported desktop outage alive', desktop: -120_000, phone: 0, room: true, desktopOffline: true, transition: false },
  { name: 'required missing phone uses creation for revocation', desktop: -120_000, room: true, transition: true, revocation: true },
  { name: 'required missing phone within creation grace', desktop: -120_000, room: true, created: -90_000, desktopOffline: true, approved: null, transition: false },
  { name: 'reported phone outage with desktop online', phone: -40_000, room: true, phoneOffline: true, transition: false },
  { name: 'phone requirement removed clears offline marker', phoneOffline: true, transition: true },
  { name: 'healthy ended exam', end: 0, transition: true },
  { name: 'healthy flexible personal time exhausted', rule: 'OI', flexible: true, candidateStarted: -600_000, transition: true },
  { name: 'flexible fallback to session start', rule: 'OI', flexible: true, candidateStarted: null, sessionStarted: -600_000, transition: true },
  { name: 'candidate start takes priority', rule: 'OI', flexible: true, candidateStarted: 0, sessionStarted: -600_000, transition: false },
  { name: 'flexible no start waits until hard end', rule: 'OI', flexible: true, candidateStarted: null, sessionStarted: null, transition: false },
  { name: 'fixed OI ignores personal clock', rule: 'OI', candidateStarted: -600_000, transition: false },
  { name: 'XCPC ignores legacy flexible flag', flexible: true, candidateStarted: -600_000, transition: false },
  { name: 'ACM alias ignores legacy flexible flag', rule: 'ACM', flexible: true, candidateStarted: -600_000, transition: false },
  { name: 'finished rows never reenter scan', status: 'FINISHED', desktop: -120_000, transition: false },
];

try {
  for (const entry of cases) {
    const exam = await db.exam.create({ data: {
      name: `${prefix}-${entry.name}`, examCode: String(randomInt(1_000_000_000, 10_000_000_000)),
      startAt: at(-600_000)!, latestStartAt: at(3_600_000)!, endAt: at(entry.end ?? 7_200_000)!,
      durationMinutes: 5, contestRule: entry.rule ?? 'XCPC', flexible: entry.flexible ?? false,
      platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: prefix,
      contestType: 'INDIVIDUAL', requireMiniProgram: entry.requirePhone ?? false, rules: prefix,
    } });
    examIds.push(exam.id);
    const candidate = await db.candidate.create({ data: {
      examId: exam.id, examNumber: entry.name, password: prefix, seatNo: entry.name,
      startedAt: at(entry.candidateStarted === undefined ? -60_000 : entry.candidateStarted),
    } });
    if (entry.room !== undefined) {
      await db.examRoom.create({ data: { examId: exam.id, name: entry.name, requireSecondCamera: entry.room,
        candidates: { create: { candidateId: candidate.id } } } });
    }
    const session = await db.clientSession.create({ data: {
      examId: exam.id, candidateId: candidate.id, status: entry.status ?? 'IN_EXAM',
      createdAt: at(entry.created ?? -600_000)!, approvedAt: at(entry.approved === undefined ? -600_000 : entry.approved),
      startedAt: at(entry.sessionStarted === undefined ? -60_000 : entry.sessionStarted),
      lastDesktopSeenAt: at(entry.desktop === undefined ? 0 : entry.desktop), lastMiniProgramSeenAt: at(entry.phone ?? null),
      desktopOfflineAt: entry.desktopOffline ? now : null, miniProgramOfflineAt: entry.phoneOffline ? now : null,
    } });
    assert.deepEqual(await healthSessionIds(exam.id, now), entry.transition ? [{ id: session.id }] : [], entry.name);
  }
  console.log(`PASS: ${cases.length} real-MySQL health scan cases; room overrides, exact cutoffs, approval/creation clocks, personal deadlines and finished rows.`);
} finally {
  if (examIds.length) await db.exam.deleteMany({ where: { id: { in: examIds } } });
  await db.$disconnect();
}
