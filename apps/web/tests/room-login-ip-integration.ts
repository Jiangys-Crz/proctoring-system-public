import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { bindCandidateLoginIp } from '../src/lib/login-ip';
import { createPairSecret } from '../src/lib/pairing-security';
import { createPairingSession } from '../src/lib/pairing-create';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_room_ip_qa');
const base = 'http://127.0.0.1:4098', marker = `room-ip-${randomUUID()}`;
const users: string[] = [], pairs: string[] = [];
let examId = '';
try {
  const admin = await prisma.user.create({ data: { username: marker, role: 'SUPER_ADMIN' } }); users.push(admin.id);
  const proctor = await prisma.user.create({ data: { username: marker + '-a', role: 'ADMIN' } }); users.push(proctor.id);
  const other = await prisma.user.create({ data: { username: marker + '-b', role: 'ADMIN' } }); users.push(other.id);
  const now = Date.now();
  const exam = await prisma.exam.create({ data: { examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: marker,
    startAt: new Date(now - 60_000), latestStartAt: new Date(now + 3_600_000), endAt: new Date(now + 7_200_000), durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: base, platformContestId: 'local', contestType: 'INDIVIDUAL', rules: '', published: true,
    requireMiniProgram: false, requireFrontCamera: false, createdById: admin.id } }); examId = exam.id;
  const roomA = await prisma.examRoom.create({ data: { examId, name: 'A', requireFrontCamera: false, requireSecondCamera: false, proctors: { create: { userId: proctor.id } } } });
  const roomB = await prisma.examRoom.create({ data: { examId, name: 'B', requireFrontCamera: false, requireSecondCamera: false, proctors: { create: { userId: other.id } } } });
  const a = await prisma.candidate.create({ data: { examId, examNumber: 'A001', name: 'A', password: marker, seatNo: '1', loginIp: '192.0.2.1', rooms: { create: { roomId: roomA.id } } } });
  const b = await prisma.candidate.create({ data: { examId, examNumber: 'B001', name: 'B', password: marker, seatNo: '2', loginIp: '192.0.2.1', rooms: { create: { roomId: roomB.id } } } });
  const request = (method: string, body?: unknown, user = admin, query = '') => new Request(`${base}/api/exams/${examId}/login-restrictions${query}`, {
    method, headers: { cookie: `cwnupaa_proctor_session=${createSessionToken(user)}`, origin: base, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const change = (body: unknown, user = admin) => fetch(request('POST', body, user));
  const read = async (user = admin, query = '') => {
    const response = await fetch(request('GET', undefined, user, query));
    assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data;
  };
  const firstChange = await change({ action: 'set-room', roomId: roomB.id, enabled: false });
  assert.equal(firstChange.status, 200, await firstChange.clone().text());
  assert.deepEqual((await read()).candidates.map((row: any) => row.id), [a.id]);
  assert.equal((await read(admin, '?q=B001')).total, 0, 'search cannot bypass the enabled-room filter');
  assert.equal((await read(proctor)).total, 1);
  assert.equal((await read(other)).total, 0);
  assert.deepEqual((await read(other)).rooms.map((row: any) => row.id), [roomB.id], 'room policy visibility remains scoped');
  assert.equal((await change({ action: 'set-room', roomId: roomA.id, enabled: false }, proctor)).status, 403);
  assert.equal((await change({ action: 'set-room', roomId: 'foreign-room', enabled: false })).status, 404);
  await assert.rejects(prisma.$transaction(tx => bindCandidateLoginIp(tx, examId, a.id, '192.0.2.2')), /绑定其他/);
  await prisma.$transaction(tx => bindCandidateLoginIp(tx, examId, b.id, '192.0.2.2'));
  assert.equal((await change({ action: 'set-room', roomId: roomB.id, enabled: true })).status, 200);
  await assert.rejects(prisma.$transaction(tx => bindCandidateLoginIp(tx, examId, b.id, '192.0.2.3')), /绑定其他/);
  assert.equal((await read()).total, 2);
  assert.equal((await change({ action: 'set-room', roomId: roomA.id, enabled: false })).status, 200);
  async function login(ip: string) {
    const poll = createPairSecret('POLL');
    const pair = await createPairingSession(prisma, { desktopDeviceId: randomUUID(), desktopLoginIp: ip, screenOk: true, desktopCameraOk: true,
      pollTokenHash: poll.hash, expiresAt: new Date(Date.now() + 300_000), purpose: 'INITIAL', peripheralsFingerprint: `usb-v5:${'a'.repeat(64)}` });
    pairs.push(pair.id);
    return fetch(new Request(`${base}/api/client/credential-login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ examCode: exam.examCode, name: a.name, examNumber: a.examNumber, password: marker, pairCode: pair.pairCode }) }));
  }
  const first = await login('192.0.2.2'); assert.equal(first.status, 201, await first.clone().text());
  const originalSession = (await first.json()).data.sessionId;
  assert.equal((await change({ action: 'set-room', roomId: roomA.id, enabled: true })).status, 200);
  assert.equal((await login('192.0.2.3')).status, 403);
  assert.equal((await change({ action: 'release', candidateIds: [a.id, b.id] }, proctor)).status, 403);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: a.id } })).loginIp, '192.0.2.2', 'failed mixed-scope release must roll back');
  assert.equal((await change({ action: 'release', candidateIds: [a.id] }, proctor)).status, 200);
  const rebound = await login('192.0.2.3'); assert.equal(rebound.status, 201, await rebound.clone().text());
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: a.id } })).loginIp, '192.0.2.3');
  assert.ok((await prisma.clientSession.findUniqueOrThrow({ where: { id: originalSession } })).revokedAt);
  assert.equal((await change({ action: 'toggle', enabled: false })).status, 200);
  assert.equal((await read()).total, 0);
  console.log('PASS room switches, filtered/searchable/scoped rosters, transactional IP binding, credential login, one-time release, rebind/revocation and batch switches');
} finally {
  if (examId) { await prisma.systemSetting.deleteMany({ where: { key: { startsWith: `room-login-ip:${examId}:` } } }); await prisma.exam.delete({ where: { id: examId } }); }
  if (pairs.length) await prisma.pairingSession.deleteMany({ where: { id: { in: pairs } } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
}
