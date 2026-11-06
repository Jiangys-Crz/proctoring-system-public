// Explicit disposable local DB fixture; every created row is removed in finally.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { createCandidateLoginRequest } from '../src/lib/candidate-login';
import { markStaleSessionsOffline, startSessionHealthWorker } from '../src/lib/session-health';
import { POST as pair } from '../src/app/api/client/pair/route';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';
import { POST as reconnect } from '../src/app/api/client/reconnect/route';

const marker = `logout-qa-${randomUUID()}`;
let examId: string | undefined;
const desktop = createClientSessionToken(), mobile = createClientSessionToken();
async function post(handler: (r: Request) => Promise<Response>, body: object, expected: number, token?: string) {
  const response = await handler(new Request('http://localhost:4031/api/client/test', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
  const data = await response.json(); assert.equal(response.status, expected, data.message); return data;
}
try {
  const now = new Date(); const firstStart = new Date(now.getTime() - 600_000);
  const exam = await prisma.exam.create({ data: { examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(now.getTime() - 900_000), latestStartAt: new Date(now.getTime() + 3_600_000), endAt: new Date(now.getTime() + 7_200_000),
    durationMinutes: 120, platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker,
    contestType: 'INDIVIDUAL', requireMiniProgram: true, requireFrontCamera: false, rules: marker,
  } }); examId = exam.id;
  const candidate = await prisma.candidate.create({ data: { examId, examNumber: marker, password: marker, seatNo: 'QA', startedAt: firstStart, status: 'ONLINE_NORMAL' } });
  const room = await prisma.examRoom.create({ data: { examId, name: marker, loginMode: 'CREDENTIALS', loginReviewMode: 'MANUAL', requireSecondCamera: true, requireFrontCamera: false, candidates: { create: { candidateId: candidate.id } } } });
  const login = await prisma.loginRequest.create({ data: { examId, candidateId: candidate.id, status: 'APPROVED', reviewedAt: now } });
  const session = await prisma.clientSession.create({ data: { examId, candidateId: candidate.id, loginRequestId: login.id,
    desktopDeviceId: marker, miniProgramDeviceId: `${marker}-phone`, desktopTokenHash: desktop.tokenHash, miniProgramTokenHash: mobile.tokenHash,
    status: 'IN_EXAM', approvedAt: now, startedAt: firstStart, lastDesktopSeenAt: now, lastMiniProgramSeenAt: now,
  } });
  const recovery = (await post(pair, { deviceId: marker, sessionId: session.id, screenOk: true }, 200, desktop.token)).data;
  const old = new Date(Date.now() - 120_001);
  await prisma.clientSession.update({ where: { id: session.id }, data: { lastDesktopSeenAt: old, lastMiniProgramSeenAt: old } });
  await markStaleSessionsOffline(examId);
  const offline = await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal(offline.status, 'OFFLINE'); assert.equal(offline.revokedAt, null);
  assert.equal(offline.desktopTokenHash, desktop.tokenHash); assert.equal(offline.miniProgramTokenHash, mobile.tokenHash);
  await post(heartbeat, { sessionId: session.id, deviceId: marker, side: 'DESKTOP' }, 200, desktop.token);
  await post(heartbeat, { sessionId: session.id, deviceId: `${marker}-phone`, side: 'MINIPROGRAM' }, 200, mobile.token);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).startedAt?.getTime(), firstStart.getTime());

  await prisma.examRoom.update({ where: { id: room.id }, data: { requireSecondCamera: false } });
  const initial = (await post(pair, { deviceId: `${marker}-new-desktop`, screenOk: true }, 200)).data;
  const pairing = await prisma.pairingSession.findUniqueOrThrow({ where: { pairCode: initial.pairCode } });
  const fresh = await createCandidateLoginRequest({ exam, pairing, candidateId: candidate.id, memberIdentity: null, materials: {}, method: 'CREDENTIALS' });
  const freshSession = await prisma.clientSession.findUniqueOrThrow({ where: { id: fresh.sessionId } });
  assert.equal(freshSession.status, 'WAITING_REVIEW'); assert.equal(freshSession.revokedAt, null);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).startedAt?.getTime(), firstStart.getTime());
  await post(heartbeat, { sessionId: session.id, deviceId: marker, side: 'DESKTOP' }, 410, desktop.token);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).status, 'REQUESTING', 'old heartbeat never changes newer login');
  const stale = new Date(Date.now() - 120_001);
  await prisma.clientSession.update({ where: { id: freshSession.id }, data: { lastDesktopSeenAt: stale, lastMiniProgramSeenAt: new Date() } });
  await prisma.examRoom.update({ where: { id: room.id }, data: { requireSecondCamera: true } });
  await markStaleSessionsOffline(examId);
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: freshSession.id } })).revokedAt, null);
  await prisma.clientSession.update({ where: { id: freshSession.id }, data: { lastDesktopSeenAt: new Date() } });
  await prisma.examRoom.update({ where: { id: room.id }, data: { requireSecondCamera: false } });
  // Wait for its first pass, then make the session stale and exercise the timer's next pass.
  let initialWorkerFinished!: () => void;
  const firstWorkerPass = new Promise<void>(resolve => { initialWorkerFinished = resolve; });
  let workerFinished!: () => void;
  const workerPass = new Promise<void>(resolve => { workerFinished = resolve; });
  let passes = 0;
  startSessionHealthWorker(async () => {
    await markStaleSessionsOffline(examId);
    if (++passes === 1) initialWorkerFinished(); else workerFinished();
    return 0;
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('background worker timeout')), 15_000); });
    await Promise.race([firstWorkerPass, timeout]);
    assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: freshSession.id } })).revokedAt, null);
    await prisma.clientSession.update({ where: { id: freshSession.id }, data: { lastDesktopSeenAt: stale } });
    await Promise.race([workerPass, timeout]);
  } finally { if (deadline) clearTimeout(deadline); }
  const workerEnded = await prisma.clientSession.findUniqueOrThrow({ where: { id: freshSession.id } });
  assert.equal(workerEnded.revokedAt, null, 'background worker retains disconnected sessions');
  assert.equal(workerEnded.status, 'OFFLINE');
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).startedAt?.getTime(), firstStart.getTime());
  console.log('PASS: long outages retain sessions and tokens; fresh login revokes the old session; personal clock is preserved; background scans only mark offline.');
} finally {
  const worker = globalThis as typeof globalThis & { sessionHealthTimer?: ReturnType<typeof setInterval> };
  if (worker.sessionHealthTimer) { clearInterval(worker.sessionHealthTimer); delete worker.sessionHealthTimer; }
  await prisma.pairingSession.deleteMany({ where: { desktopDeviceId: { startsWith: marker } } });
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  assert.equal(await prisma.pairingSession.count({ where: { desktopDeviceId: { startsWith: marker } } }), 0);
  if (examId) assert.equal(await prisma.exam.count({ where: { id: examId } }), 0);
  await prisma.$disconnect();
}
