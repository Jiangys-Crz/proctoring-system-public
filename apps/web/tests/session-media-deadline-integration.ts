// Runs against a disposable local database and an in-memory media control API.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { startSessionHealthWorker } from '../src/lib/session-health';
import { nextHealthDeadline } from '../src/lib/session-health-scan';
import { reconcileTerminalSessionMedia } from '../src/lib/session-media-lifecycle';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_deadline_media_qa');
assert.equal(await prisma.clientSession.count(), 0, 'this fixture owns the database');
const clock = Date.now();
const exam = await prisma.exam.create({ data: {
  examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: 'deadline fixture',
  startAt: new Date(clock - 90_000), latestStartAt: new Date(clock + 30_000), endAt: new Date(clock + 120_000),
  durationMinutes: 1, contestType: 'INDIVIDUAL', contestRule: 'IOI', flexible: true,
  platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: 'local', rules: 'synthetic',
  requireFrontCamera: false, requireMiniProgram: false,
} });
const realFetch = globalThis.fetch;
const worker = globalThis as typeof globalThis & { sessionHealthTimer?: ReturnType<typeof setTimeout>; sessionHealthBusy?: boolean };
try {
  async function session(examNumber: string, startedAt: Date) {
    const candidate = await prisma.candidate.create({ data: { examId: exam.id, examNumber, password: 'synthetic', seatNo: 'QA', startedAt } });
    return prisma.clientSession.create({ data: { examId: exam.id, candidateId: candidate.id, status: 'IN_EXAM', startedAt, lastDesktopSeenAt: new Date() } });
  }
  const deadline = new Date(clock + 1600);
  const ending = await session('ending', new Date(+deadline - 60_000));
  const other = await session('still-running', new Date(clock));
  assert.equal(+(await nextHealthDeadline())!, +deadline);
  const peers = new Map([[randomUUID(), ending.id], [randomUUID(), other.id]]);
  const endedPeer = [...peers.keys()][0];
  let firstKickAt = 0, outage = true;
  const kicked = new Set<string>();
  process.env.MEDIA_PUBLISH_SECRET ||= 'qa-only-secret';
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v3/paths/list') return Response.json({ pageCount: 1, items: [...peers].filter(([id]) => !kicked.has(id)).map(([id, sessionId]) => ({
      name: `live/${sessionId}_DESKTOP_SCREEN`, readers: [{ type: 'webRTCSession', id }],
    })) });
    if (path.endsWith('/list')) return Response.json({ pageCount: 0, items: [] });
    assert.equal(init?.method, 'POST');
    const peer = path.split('/').at(-1)!;
    assert.equal(peer, endedPeer);
    assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: ending.id } })).status, 'FINISHED');
    firstKickAt ||= Date.now();
    if (outage) return new Response(null, { status: 503 });
    kicked.add(peer);
    return new Response(null, { status: 200 });
  };
  startSessionHealthWorker();
  while (!firstKickAt && Date.now() < +deadline + 4000) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(firstKickAt >= +deadline && firstKickAt < +deadline + 3000, 'worker disconnects around the deadline without a heartbeat');
  while (worker.sessionHealthBusy) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: ending.id } })).liveMediaStoppedAt, null);
  outage = false;
  await reconcileTerminalSessionMedia();
  assert.deepEqual([...kicked], [endedPeer]);
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: other.id } })).status, 'IN_EXAM');
  await prisma.clientSession.update({ where: { id: ending.id }, data: { liveMediaStoppedAt: new Date(Date.now() - 20_000) } });
  kicked.clear(); // Simulate a late negotiation that was not visible in the first inventory.
  await reconcileTerminalSessionMedia();
  assert.deepEqual([...kicked], [endedPeer]);
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: ending.id } })).liveMediaRechecked, true);
  console.log('PASS: flexible deadline without heartbeat, committed finish, unrelated stream retained, retry and late handshake cleanup.');
} finally {
  while (worker.sessionHealthBusy) await new Promise(resolve => setTimeout(resolve, 25));
  clearTimeout(worker.sessionHealthTimer);
  delete worker.sessionHealthTimer;
  globalThis.fetch = realFetch;
  await prisma.exam.delete({ where: { id: exam.id } });
  await prisma.$disconnect();
}
