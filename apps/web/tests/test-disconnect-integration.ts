// Run against a disposable database: DATABASE_URL=... pnpm exec tsx tests/test-disconnect-integration.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { getPublicTestExam } from '../src/lib/public-test';
import { PUBLIC_TEST_ROOMS } from '../src/lib/public-test-template';
import { createClientSessionToken, hashClientSessionToken } from '../src/lib/client-auth';
import { POST as disconnect } from '../src/app/api/client/test-disconnect/route';
import { POST as reconnect } from '../src/app/api/client/reconnect/route';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';
import { POST as createPair, GET as pollPair } from '../src/app/api/client/pair/route';
import { GET as mediaState } from '../src/app/api/client/media-state/route';

const marker = `disconnect-qa-${randomUUID()}`;
let candidateId: string | undefined;
const desktopDeviceId = `${marker}-desktop`, mobileDeviceId = `${marker}-phone`;
let desktopToken = createClientSessionToken().token, mobileToken = createClientSessionToken().token;

async function post(handler: (request: Request) => Promise<Response>, body: object, token = '', status = 200) {
  const response = await handler(new Request('http://localhost:4031/api/client/test', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': token }, body: JSON.stringify(body),
  }));
  const result = await response.json();
  assert.equal(response.status, status, result.message);
  return result.data;
}
async function poll(pair: { pairCode: string; pollToken: string }) {
  const response = await pollPair(new Request(`http://localhost:4031/api/client/pair?pairCode=${pair.pairCode}&deviceId=${desktopDeviceId}`, {
    headers: { 'x-proctor-pair-poll-token': pair.pollToken, 'x-proctor-session-token': desktopToken },
  }));
  const result = await response.json();
  assert.equal(response.status, 200, result.message);
  return result.data;
}
async function media(sessionId: string, pairCode: string) {
  const response = await mediaState(new Request(`http://localhost:4031/api/client/media-state?sessionId=${sessionId}&recoveryPairCode=${pairCode}`, {
    headers: { 'x-proctor-session-token': desktopToken },
  }));
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

try {
  const exam = await getPublicTestExam();
  const room = exam.rooms.find(item => item.name === PUBLIC_TEST_ROOMS.secondCamera)!;
  const startedAt = new Date(Date.now() - 10_000);
  const candidate = await prisma.candidate.create({ data: {
    examId: exam.id, examNumber: marker, name: marker, password: marker, seatNo: 'QA', status: 'ONLINE_NORMAL', startedAt,
    rooms: { create: { roomId: room.id } },
  } });
  candidateId = candidate.id;
  const session = await prisma.clientSession.create({ data: {
    examId: exam.id, candidateId, desktopDeviceId, miniProgramDeviceId: mobileDeviceId,
    desktopTokenHash: hashClientSessionToken(desktopToken), miniProgramTokenHash: hashClientSessionToken(mobileToken),
    status: 'IN_EXAM', approvedAt: new Date(), startedAt, lastDesktopSeenAt: new Date(), lastMiniProgramSeenAt: new Date(),
  } });
  const desktopBeat = (token = desktopToken, status = 200) => post(heartbeat, { sessionId: session.id, deviceId: desktopDeviceId, side: 'DESKTOP' }, token, status);
  const mobileBeat = (token = mobileToken, status = 200) => post(heartbeat, { sessionId: session.id, deviceId: mobileDeviceId, side: 'MINIPROGRAM' }, token, status);
  await post(disconnect, { sessionId: session.id, deviceId: desktopDeviceId, side: 'DESKTOP' }, mobileToken, 401);

  for (let round = 0; round < 2; round++) {
    // The mobile test must invalidate only the phone, and recovery must preserve
    // the already authenticated desktop and the original examination clock.
    const pair = await post(createPair, { deviceId: desktopDeviceId, sessionId: session.id, screenOk: true, desktopCameraOk: true }, desktopToken);
    assert.equal((await media(session.id, pair.pairCode)).recoveryPair.claimedAt, null);
    const oldPhone = mobileToken, currentDesktop = desktopToken;
    await post(disconnect, { sessionId: session.id, deviceId: mobileDeviceId, side: 'MINIPROGRAM' }, mobileToken);
    await mobileBeat(oldPhone, 401);
    await desktopBeat();
    const recovered = await post(reconnect, { pairCode: pair.pairCode, recoverySecret: pair.recoverySecret, deviceId: mobileDeviceId });
    mobileToken = recovered.miniProgramSessionToken;
    assert.equal(recovered.sessionId, session.id);
    assert.notEqual(mobileToken, oldPhone);
    assert.equal(recovered.session.startedAt, startedAt.toISOString());
    assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } })).desktopTokenHash, hashClientSessionToken(currentDesktop));
    assert.ok((await media(session.id, pair.pairCode)).recoveryPair.claimedAt, 'the desktop can detect and replace a consumed recovery QR');
    assert.equal((await media(session.id, '000000')).recoveryPair, null, 'unrelated QR state is not exposed');
    assert.equal((await poll(pair)).desktopSessionToken, null, 'phone recovery never issues a new desktop token');
    await mobileBeat(oldPhone, 401);
    await mobileBeat(); await desktopBeat();
    await post(reconnect, { pairCode: pair.pairCode, recoverySecret: pair.recoverySecret, deviceId: mobileDeviceId }, '', 403);

    // The desktop test signs out the desktop; the phone scan authorizes exactly
    // one new desktop token, which must work when the client refreshes its session.
    const oldDesktop = desktopToken;
    const desktopPair = await post(disconnect, { sessionId: session.id, deviceId: desktopDeviceId, side: 'DESKTOP' }, desktopToken);
    await desktopBeat(oldDesktop, 401);
    await mobileBeat();
    assert.equal((await poll(desktopPair)).desktopSessionToken, null, 'polling before the phone scan cannot restore the desktop');
    const recoveredPhone = await post(reconnect, { pairCode: desktopPair.pairCode, recoverySecret: desktopPair.recoverySecret, deviceId: mobileDeviceId });
    mobileToken = recoveredPhone.miniProgramSessionToken;
    const authorizedDesktop = await poll(desktopPair);
    desktopToken = authorizedDesktop.desktopSessionToken;
    assert.ok(desktopToken);
    assert.notEqual(desktopToken, oldDesktop);
    assert.equal(authorizedDesktop.testLogin.session.id, session.id);
    assert.equal(authorizedDesktop.testLogin.session.startedAt, startedAt.toISOString());
    assert.equal((await poll(desktopPair)).desktopSessionToken, null, 'repeated polling must not rotate the newly installed token');
    await desktopBeat(oldDesktop, 401);
    await desktopBeat(); await mobileBeat();
    assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } })).startedAt?.getTime(), startedAt.getTime());
  }
  console.log('PASS: repeated phone/desktop disconnect tests, scan recovery, token independence, consumed QR detection, refreshed session and preserved examination clock.');
} finally {
  await prisma.pairingSession.deleteMany({ where: { desktopDeviceId } });
  if (candidateId) await prisma.candidate.delete({ where: { id: candidateId } });
  await prisma.$disconnect();
}
