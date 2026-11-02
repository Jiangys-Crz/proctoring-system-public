// DATABASE_URL must name this disposable local database. Never uses Hydro.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { createPairSecret } from '../src/lib/pairing-security';
import { POST as credentials } from '../src/app/api/client/credential-login/route';
import { GET as pollPair } from '../src/app/api/client/pair/route';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_performance_qa', 'requires an isolated performance test database');
const baseUrl = process.env.PERFORMANCE_TEST_BASE_URL;
if (baseUrl) assert.equal(new URL(baseUrl).hostname, '127.0.0.1', 'HTTP test is local only');
const marker = `login-concurrency-${randomUUID()}`;
let examId: string | undefined;
const latencies: number[] = [];
async function pair() {
  const poll = createPairSecret('POLL');
  const row = await prisma.pairingSession.create({ data: {
    pairCode: String(randomInt(100000, 1000000)), desktopDeviceId: marker,
    pollTokenHash: poll.hash, purpose: 'INITIAL', screenOk: true,
    expiresAt: new Date(Date.now() + 300_000),
  } });
  return { ...row, pollToken: poll.secret };
}
async function login(examCode: string, examNumber: string, pairCode: string) {
  const start = performance.now();
  const request = new Request(`${baseUrl || 'http://localhost'}/api/client/credential-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ examCode, examNumber, pairCode, name: marker, password: marker }),
  });
  const response = baseUrl ? await fetch(request) : await credentials(request);
  const body = await response.json();
  latencies.push(performance.now() - start);
  return { status: response.status, body };
}
try {
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(Date.now() - 60_000), latestStartAt: new Date(Date.now() + 3_600_000),
    endAt: new Date(Date.now() + 7_200_000), durationMinutes: 120, flexible: true,
    platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: 'local',
    contestType: 'INDIVIDUAL', requireMiniProgram: false, requireFrontCamera: false, rules: marker,
    rooms: { create: { name: marker, loginMode: 'CREDENTIALS', loginReviewMode: 'MANUAL', requireSecondCamera: false, requireFrontCamera: false } },
  }, include: { rooms: true } });
  examId = exam.id;
  const fixtures = [];
  for (let index = 0; index < 31; index++) {
    const candidate = await prisma.candidate.create({ data: {
      examId, examNumber: String(index), name: marker, password: marker, seatNo: String(index),
      rooms: { create: { roomId: exam.rooms[0].id } },
    } });
    fixtures.push({ candidate, pairing: await pair() });
  }
  const results = await Promise.all(fixtures.slice(0, 30).map(({ candidate, pairing }) => login(exam.examCode, candidate.examNumber, pairing.pairCode)));
  for (const result of results) assert.equal(result.status, 201, JSON.stringify(result.body));
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(`PASS: 30 concurrent credential logins; p50=${Math.round(sorted[14])}ms, p95=${Math.round(sorted[28])}ms, max=${Math.round(sorted[29])}ms (${baseUrl ? 'local HTTP' : 'local route handlers'} + real MySQL; pool=${database.searchParams.get('connection_limit')}).`);
  const tokens = await Promise.all(fixtures.slice(0, 30).map(async ({ pairing }) => {
    const request = new Request(`${baseUrl || 'http://localhost'}/api/client/pair?deviceId=${marker}&pairCode=${pairing.pairCode}`, {
      headers: { 'x-proctor-pair-poll-token': pairing.pollToken },
    });
    const response = baseUrl ? await fetch(request) : await pollPair(request);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(body.data.desktopSessionToken);
    return { sessionId: body.data.loginRequest.session.id as string, token: body.data.desktopSessionToken as string };
  }));
  const beats: number[] = [];
  for (let round = 0; round < 3; round++) {
    await Promise.all(tokens.map(async ({ sessionId, token }) => {
      const began = performance.now();
      const request = new Request(`${baseUrl || 'http://localhost'}/api/client/heartbeat`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId, deviceId: marker, side: 'DESKTOP' }),
      });
      const response = baseUrl ? await fetch(request) : await heartbeat(request);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.data.session.status, 'WAITING_REVIEW');
      beats.push(performance.now() - began);
    }));
  }
  beats.sort((a, b) => a - b);
  console.log(`PASS: 30 simultaneous desktop pairing polls and 90 authenticated heartbeats; heartbeat p95=${Math.round(beats[85])}ms, max=${Math.round(beats.at(-1)!)}ms.`);
  const target = fixtures[30], competing = await pair();
  const duplicate = await Promise.all([target.pairing, competing].map(pairing => login(exam.examCode, target.candidate.examNumber, pairing.pairCode)));
  assert.deepEqual(duplicate.map(result => result.status).sort(), [201, 409]);
  assert.equal(await prisma.clientSession.count({ where: { candidateId: target.candidate.id, revokedAt: null } }), 1);
  assert.equal(await prisma.loginRequest.count({ where: { examId } }), 31);
  console.log('PASS: competing logins for the same candidate create exactly one session.');
  // A heartbeat that has updated but not committed must win over a relogin
  // observing the preceding two-minute-offline snapshot.
  const recovering = tokens[0];
  await prisma.clientSession.update({ where: { id: recovering.sessionId }, data: {
    status: 'OFFLINE', lastDesktopSeenAt: new Date(Date.now() - 180_000),
  } });
  const nextPair = await pair();
  const heartbeatDb = new PrismaClient();
  let unlock!: () => void, locked!: () => void;
  const released = new Promise<void>(resolve => { unlock = resolve; });
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const inFlightHeartbeat = heartbeatDb.$transaction(async tx => {
    await tx.clientSession.update({ where: { id: recovering.sessionId }, data: { lastDesktopSeenAt: new Date() } });
    locked();
    await released;
  }, { timeout: 10_000 });
  try {
    await Promise.race([acquired, inFlightHeartbeat]);
    const relogin = login(exam.examCode, fixtures[0].candidate.examNumber, nextPair.pairCode);
    await new Promise(resolve => setTimeout(resolve, 100));
    unlock();
    await inFlightHeartbeat;
    const result = await relogin;
    assert.equal(result.status, 409, JSON.stringify(result.body));
    const preserved = await prisma.clientSession.findUniqueOrThrow({ where: { id: recovering.sessionId } });
    assert.equal(preserved.revokedAt, null);
    assert.ok(preserved.desktopTokenHash);
    console.log('PASS: a concurrent recovering heartbeat prevents relogin from revoking its refreshed session.');
  } finally { unlock(); await inFlightHeartbeat; await heartbeatDb.$disconnect(); }
} finally {
  await prisma.pairingSession.deleteMany({ where: { desktopDeviceId: marker } });
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.$disconnect();
}
