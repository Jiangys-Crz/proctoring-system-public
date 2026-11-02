import { createHash, randomBytes } from 'node:crypto';
import { effectiveEnd } from './contest-rules';
import type { Candidate, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './db';
import { nextExamCode } from './exam-code';
import { publicTestProblemId } from './public-test-config';
import { PUBLIC_TEST_DURATION_MINUTES, PUBLIC_TEST_PROBLEMS, PUBLIC_TEST_ROOMS, PUBLIC_TEST_RULES, type PublicTestMode } from './public-test-template';

export const PUBLIC_TEST_MARKER = 'public-test.exam.v1';
export const PUBLIC_TEST_COOKIE = 'proctor_test_enrollment';
export const PUBLIC_TEST_STATE_SECONDS = 12 * 60 * 60;
export class PublicTestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function retryable(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && ['P2002', 'P2034'].includes(String(error.code));
}

/** A locked deployment marker gives all workers the same permanently open, system-owned exam. */
export async function ensurePublicTestExam(client: Pick<PrismaClient, '$transaction'> = prisma) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async tx => {
        await tx.systemSetting.upsert({ where: { key: PUBLIC_TEST_MARKER }, update: {}, create: { key: PUBLIC_TEST_MARKER, value: {} } });
        await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${PUBLIC_TEST_MARKER} FOR UPDATE`;
        const marker = await tx.systemSetting.findUniqueOrThrow({ where: { key: PUBLIC_TEST_MARKER } });
        const existingId = objectValue(marker.value).examId;
        if (typeof existingId === 'string' && await tx.exam.findUnique({ where: { id: existingId } })) {
          await tx.exam.update({ where: { id: existingId }, data: { name: '系统测试考试', requireMiniProgram: true, requireFrontCamera: true, rules: PUBLIC_TEST_RULES, published: true, flexible: true, platformContestId: 'local', durationMinutes: PUBLIC_TEST_DURATION_MINUTES, startAt: new Date('2020-01-01T00:00:00Z'), latestStartAt: new Date('9999-12-31T23:00:00Z'), endAt: new Date('9999-12-31T23:30:00Z') } });
          await tx.examRoom.updateMany({ where: { examId: existingId }, data: { requireSecondCamera: true, requireFrontCamera: true } });
          await tx.examRoom.upsert({ where: { examId_name: { examId: existingId, name: PUBLIC_TEST_ROOMS.secondCamera } },
            create: { examId: existingId, name: PUBLIC_TEST_ROOMS.secondCamera, requireSecondCamera: true, requireFrontCamera: true, loginMode: 'SECOND_CAMERA_QR', loginReviewMode: 'AUTO' },
            update: { requireSecondCamera: true, requireFrontCamera: true, loginMode: 'SECOND_CAMERA_QR', loginReviewMode: 'AUTO' } });
          return existingId;
        }
        const now = new Date(Date.now() - 60_000);
        const exam = await tx.exam.create({ data: {
          examCode: await nextExamCode(tx, now), name: '系统测试考试',
          startAt: now, latestStartAt: new Date('9999-12-31T23:00:00Z'), endAt: new Date('9999-12-31T23:30:00Z'),
          durationMinutes: PUBLIC_TEST_DURATION_MINUTES, flexible: true, published: true,
          platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: 'local',
          contestType: 'INDIVIDUAL', contestRule: 'IOI', showObjectiveScore: true,
          requireMiniProgram: true, requireFrontCamera: true,
          rules: PUBLIC_TEST_RULES,
          rooms: { create: Object.entries(PUBLIC_TEST_ROOMS).map(([mode, name]) => ({
            name, requireFrontCamera: true, requireSecondCamera: mode === 'secondCamera',
            loginMode: 'SECOND_CAMERA_QR', loginReviewMode: 'AUTO',
          })) },
          problems: { create: PUBLIC_TEST_PROBLEMS.map(problem => ({ ...problem, hydroProblemId: publicTestProblemId() })) },
        } });
        await tx.systemSetting.update({ where: { key: PUBLIC_TEST_MARKER }, data: { value: { examId: exam.id } } });
        return exam.id;
      }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 });
    } catch (error) { if (attempt >= 2 || !retryable(error)) throw error; }
  }
}

export async function publicTestExamId() {
  const marker = await prisma.systemSetting.findUnique({ where: { key: PUBLIC_TEST_MARKER } });
  const id = objectValue(marker?.value).examId;
  return typeof id === 'string' ? id : '';
}
// Transaction callers must reuse their connection: requesting a second pooled
// connection while holding a session lock can exhaust the pool under load.
export async function isPublicTestExam(examId: string, client: Pick<Prisma.TransactionClient, 'systemSetting'> = prisma) {
  const marker = await client.systemSetting.findUnique({ where: { key: PUBLIC_TEST_MARKER } });
  return objectValue(marker?.value).examId === examId;
}
export async function getPublicTestExam() {
  const examId = await ensurePublicTestExam();
  const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { rooms: true } });
  const now = new Date();
  if (!exam || !exam.published || exam.platformContestId !== 'local' || !exam.flexible
    || now < exam.startAt || now >= exam.latestStartAt || now >= exam.endAt) throw new PublicTestError('测试考试暂未开放，请稍后再试', 503);
  return exam;
}
export function publicTestEnrollmentKey(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new PublicTestError('体验凭据无效，请刷新页面', 400);
  return `public-test.enrollment.${createHash('sha256').update(token).digest('hex')}`;
}

/** Called only after the route validates the association password; no admin user is created. */
export async function enrollPublicTest(externalUserId: string, mode: PublicTestMode) {
  if (!/^[1-9]\d*$/.test(externalUserId)) throw new PublicTestError('请先通过协会官网验证', 401);
  // The exam is selected only by the server's marker; callers cannot enroll in a real exam.
  const exam = await getPublicTestExam();
  const room = exam.rooms.find(item => item.name === PUBLIC_TEST_ROOMS[mode]);
  if (!room || room.loginReviewMode !== 'AUTO' || room.loginMode !== 'SECOND_CAMERA_QR'
    || room.requireSecondCamera !== (mode === 'secondCamera')) throw new PublicTestError('该体验模式暂不可用', 503);
  const key = `public-test.account.${externalUserId}`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.systemSetting.upsert({ where: { key }, create: { key, value: {} }, update: {} });
        await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${key} FOR UPDATE`;
        const binding = await tx.publicTestAccount.findUnique({ where: { externalUserId } });
        let candidate = binding ? await tx.candidate.findFirst({ where: { id: binding.candidateId, examId: exam.id } }) : null;
        if (!binding) {
          const suffix = randomBytes(6).toString('hex').toUpperCase();
          candidate = await tx.candidate.create({ data: {
            examId: exam.id, name: `体验考生${suffix.slice(-4)}`, examNumber: `TEST${suffix}`,
            password: randomBytes(12).toString('base64url'), seatNo: '自助体验', ranked: false,
            rooms: { create: { roomId: room.id } },
          } });
          await tx.publicTestAccount.create({ data: { externalUserId, candidateId: candidate.id } });
        }
        if (!candidate) throw new PublicTestError('绑定的测试账号不可用，请联系管理员', 503);
        await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${candidate.id} FOR UPDATE`;
        candidate = await tx.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
        if (candidate.status === 'FINISHED' || new Date() >= effectiveEnd(exam, candidate.startedAt)) {
          candidate = await resetPublicTestCandidate(tx, candidate);
        }
        return { examCode: exam.examCode, examName: exam.name, name: candidate.name!, examNumber: candidate.examNumber,
          password: candidate.password, durationMinutes: exam.durationMinutes, mode, roomName: room.name };
      }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 });
    } catch (error) { if (attempt >= 2 || !retryable(error)) throw error; }
  }
}

/** Keep permanent credentials; retire only the previous test's temporary state. */
export async function resetPublicTestCandidate(tx: Prisma.TransactionClient, candidate: Candidate) {
  const sessions = await tx.clientSession.findMany({ where: { candidateId: candidate.id }, select: { id: true } });
  const requests = await tx.loginRequest.findMany({ where: { candidateId: candidate.id }, select: { id: true } });
  await tx.pairingSession.deleteMany({ where: { OR: [{ recoverySessionId: { in: sessions.map(row => row.id) } }, { loginRequestId: { in: requests.map(row => row.id) } }] } });
  await tx.clientSession.deleteMany({ where: { candidateId: candidate.id } });
  await tx.loginRequest.deleteMany({ where: { candidateId: candidate.id } });
  await tx.contestSubmission.deleteMany({ where: { candidateId: candidate.id } });
  return tx.candidate.update({ where: { id: candidate.id }, data: { startedAt: null, status: 'NOT_REQUESTED', abnormal: false } });
}

/** Retain only the short-lived connection state needed to run the current experience. */
export async function cleanupPublicTestState(now = new Date()) {
  const marker = await prisma.systemSetting.findUnique({ where: { key: PUBLIC_TEST_MARKER } });
  const examId = objectValue(marker?.value).examId;
  if (typeof examId !== 'string') return;
  const finishedBefore = new Date(now.getTime() - 60_000);
  const unusedBefore = new Date(now.getTime() - PUBLIC_TEST_STATE_SECONDS * 1000);
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { durationMinutes: true } });
  if (!exam) return;
  const startedBefore = new Date(now.getTime() - exam.durationMinutes * 60_000 - 60_000);
  const candidates = await prisma.candidate.findMany({ where: { examId, OR: [
    { status: 'FINISHED', updatedAt: { lt: finishedBefore } },
    { startedAt: { lt: startedBefore } },
    { startedAt: null, updatedAt: { lt: unusedBefore }, sessions: { none: { status: { not: 'FINISHED' } } },
      OR: [{ publicTestAccount: { is: null } }, { status: { not: 'NOT_REQUESTED' } }] },
  ] }, select: { id: true }, take: 500 });
  if (candidates.length) await prisma.$transaction(async tx => {
    const ids = candidates.map(candidate => candidate.id);
    for (const id of ids) {
      await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${id} FOR UPDATE`;
      const current = await tx.candidate.findUnique({ where: { id }, include: { publicTestAccount: true } });
      if (!current || current.examId !== examId) continue;
      const finished = current.status === 'FINISHED' && current.updatedAt < finishedBefore;
      const expired = Boolean(current.startedAt && current.startedAt < startedBefore);
      // Permanent accounts can be older than the cleanup window even during a
      // new login. Use current activity and recheck sessions under the row lock.
      const unused = !current.startedAt && current.updatedAt < unusedBefore && (await tx.clientSession.count({
        where: { candidateId: id, status: { not: 'FINISHED' } },
      })) === 0;
      if (!finished && !expired && !unused) continue;
      if (current.publicTestAccount) {
        // Unused, reset permanent accounts need no further writes on every cleanup tick.
        if (current.status !== 'NOT_REQUESTED' || current.startedAt || await tx.clientSession.count({ where: { candidateId: id } })) await resetPublicTestCandidate(tx, current);
      } else {
        await resetPublicTestCandidate(tx, current);
        await tx.candidate.delete({ where: { id } });
      }
    }
  });
  await prisma.systemSetting.deleteMany({ where: { key: { startsWith: 'public-test.enrollment.' }, updatedAt: { lt: unusedBefore } } });
}

const state = globalThis as typeof globalThis & { publicTestCleanupTimer?: ReturnType<typeof setInterval>; publicTestCleanupBusy?: boolean };
export function startPublicTestCleanup() {
  if (state.publicTestCleanupTimer) return;
  state.publicTestCleanupTimer = setInterval(async () => {
    if (state.publicTestCleanupBusy) return;
    state.publicTestCleanupBusy = true;
    try { await cleanupPublicTestState(); }
    catch (error) { console.error('Test state cleanup failed', error); }
    finally { state.publicTestCleanupBusy = false; }
  }, 30_000);
  state.publicTestCleanupTimer.unref();
}
