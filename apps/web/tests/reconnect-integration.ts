// Run explicitly against a local development database:
// pnpm exec tsx --env-file-if-exists=.env --env-file-if-exists=.env.local tests/reconnect-integration.ts
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { getDesktopReleases } from '../src/lib/desktop-releases';
import { prisma } from '../src/lib/db';
import { createClientSessionToken, hashClientSessionToken } from '../src/lib/client-auth';
import { GET as pollPair, POST as createPair } from '../src/app/api/client/pair/route';
import { POST as reconnect } from '../src/app/api/client/reconnect/route';
import { GET as mediaState } from '../src/app/api/client/media-state/route';
import { POST as publishCamera } from '../src/app/api/client/whip/route';
import { verifyMediaPublishToken } from '../src/lib/media-publish-token';

const marker = `reconnect-qa-${randomUUID()}`;
let examId: string | undefined;
const desktopToken = createClientSessionToken();
const previousMobileToken = createClientSessionToken();

async function post(handler: (request: Request) => Promise<Response>, path: string, body: object, status: number, token?: string) {
  const response = await handler(new Request(`http://localhost:4031${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-proctor-session-token': token } : {}) },
    body: JSON.stringify(body),
  }));
  const result = await response.json();
  assert.equal(response.status, status, result.message || `Unexpected HTTP status for ${path}`);
  return result.data;
}

async function polling(deviceId: string, pairCode: string, pollToken: string, sessionToken = '') {
  const response = await pollPair(new Request(`http://localhost:4031/api/client/pair?deviceId=${encodeURIComponent(deviceId)}&pairCode=${pairCode}`, { headers: { 'x-proctor-pair-poll-token': pollToken, ...(sessionToken ? { 'x-proctor-session-token': sessionToken } : {}) } }));
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

let currentVersion = '';
const pairInput = (deviceId: string, sessionId?: string) => ({
  deviceId, sessionId, hostname: 'Disposable integration desktop', os: 'darwin 24.0.0', clientVersion: currentVersion,
  screenOk: true, desktopCameraOk: false, peripheralsFingerprint: marker,
});

try {
  // A fresh local database permits pairing before the first client release.
  currentVersion = (await getDesktopReleases()).find(item => item.target === 'mac-arm64' && item.channel === 'public')?.version || '0.0.0';
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(Date.now() - 60_000), latestStartAt: new Date(Date.now() + 3_600_000),
    endAt: new Date(Date.now() + 7_200_000), durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker,
    contestType: 'INDIVIDUAL', requireMiniProgram: true, requireFrontCamera: true, rules: 'Disposable reconnect verification',
  } });
  examId = exam.id;
  const candidate = await prisma.candidate.create({ data: { examId, examNumber: marker, password: marker, seatNo: 'QA' } });
  const room = await prisma.examRoom.create({ data: {
    examId, name: marker, requireSecondCamera: false, requireFrontCamera: false,
    candidates: { create: { candidateId: candidate.id } },
  } });
  const loginRequest = await prisma.loginRequest.create({ data: { examId, candidateId: candidate.id, status: 'APPROVED', reviewedAt: new Date() } });
  const session = await prisma.clientSession.create({ data: {
    examId, candidateId: candidate.id, loginRequestId: loginRequest.id, status: 'APPROVED',
    desktopDeviceId: marker, miniProgramDeviceId: `${marker}-old-phone`,
    desktopTokenHash: desktopToken.tokenHash, miniProgramTokenHash: previousMobileToken.tokenHash,
    approvedAt: new Date(), lastDesktopSeenAt: new Date(), miniProgramOfflineAt: new Date(Date.now() - 30_000),
  } });

  const beforeUnauthorized = await prisma.pairingSession.count({ where: { desktopDeviceId: marker } });
  await post(createPair, '/api/client/pair', pairInput(marker, session.id), 401);
  await post(createPair, '/api/client/pair', pairInput(marker, session.id), 401, previousMobileToken.token);
  assert.equal(await prisma.pairingSession.count({ where: { desktopDeviceId: marker } }), beforeUnauthorized, 'unauthorized QR creation never writes a pairing');

  for (const status of ['APPROVED', 'IN_EXAM'] as const) {
    const requireSecondCamera = status === 'IN_EXAM';
    await prisma.exam.update({ where: { id: examId }, data: { requireMiniProgram: !requireSecondCamera } });
    await prisma.examRoom.update({ where: { id: room.id }, data: { requireSecondCamera } });
    await prisma.clientSession.update({ where: { id: session.id }, data: { status } });
    const beforePair = Date.now();
    const pair = await post(createPair, '/api/client/pair', pairInput(marker, session.id), 200, desktopToken.token);
    const expiresAt = new Date(pair.expiresAt).getTime();
    const serverNow = new Date(pair.serverNow).getTime();
    assert.ok(Number.isFinite(serverNow) && serverNow >= beforePair && serverNow <= Date.now());
    assert.ok(expiresAt - serverNow > 290_000 && expiresAt - serverNow <= 300_000, 'QR TTL is measured from server time');
    const persisted = await prisma.pairingSession.findUniqueOrThrow({ where: { pairCode: pair.pairCode } });
    assert.equal(persisted.loginRequestId, loginRequest.id);
    assert.ok(persisted.desktopTokenIssuedAt, 'the already authenticated desktop keeps its current token');
    assert.match(pair.pollToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(pair.recoverySecret, /^[A-Za-z0-9_-]{43}$/);
    const anonymousPoll = await pollPair(new Request(`http://localhost:4031/api/client/pair?deviceId=${marker}&pairCode=${pair.pairCode}`));
    assert.equal(anonymousPoll.status, 401, 'QR contents never grant desktop polling access');
    await post(reconnect, '/api/client/reconnect', { pairCode: pair.pairCode, deviceId: `${marker}-no-secret` }, 400);
    const firstPoll = await polling(marker, pair.pairCode, pair.pollToken);
    assert.equal(firstPoll.desktopSessionToken, null);
    assert.ok(Number.isFinite(new Date(firstPoll.serverNow).getTime()));

    // This is the important recovery path: the replacement phone has no saved
    // session ID, no previous login token and no new login request/materials.
    const phoneDeviceId = `${marker}-${status}-new-phone`;
    const mobile = await post(reconnect, '/api/client/reconnect', { pairCode: pair.pairCode, recoverySecret: pair.recoverySecret, deviceId: phoneDeviceId }, 200);
    assert.equal(mobile.sessionId, session.id);
    assert.equal(mobile.session.status, status);
    assert.equal(mobile.requirements.requireSecondCamera, requireSecondCamera, 'room requirements override contradictory exam defaults');
    assert.equal(mobile.requirements.requireFrontCamera, false);
    assert.ok(mobile.miniProgramSessionToken);
    assert.equal(mobile.session.desktopTokenHash, undefined);
    assert.equal(mobile.session.miniProgramTokenHash, undefined);
    const refreshed = await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(refreshed.desktopTokenHash, desktopToken.tokenHash);
    assert.equal(refreshed.miniProgramDeviceId, phoneDeviceId);
    assert.equal(refreshed.miniProgramTokenHash, hashClientSessionToken(mobile.miniProgramSessionToken));
    assert.equal(refreshed.miniProgramOfflineAt, null);
    assert.ok(refreshed.lastMiniProgramSeenAt);
    const desktopState = await mediaState(new Request(`http://localhost:4031/api/client/media-state?sessionId=${session.id}`, {
      headers: { 'x-proctor-session-token': desktopToken.token },
    }));
    assert.equal(desktopState.status, 200, 'the existing desktop remains authenticated while the replacement phone reconnects');
    assert.equal((await desktopState.json()).data.session.requireSecondCamera, requireSecondCamera);

    // Use the real WHIP route and database authorization, replacing only the
    // external media-server response so this test never creates a real stream.
    const fetchBefore = globalThis.fetch;
    let upstreamCalls = 0;
    try {
      globalThis.fetch = async (_input, init) => {
        upstreamCalls += 1;
        const credential = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') || '';
        assert.notEqual(credential, mobile.miniProgramSessionToken, 'media receives a dedicated publication token');
        assert.equal(verifyMediaPublishToken(credential, refreshed, 'MOBILE_CAMERA'), true);
        return new Response('v=0\r\n', { status: 201, headers: { 'content-type': 'application/sdp' } });
      };
      const cameraRequest = (token: string) => new Request(`http://localhost:4031/api/client/whip?sessionId=${session.id}&channel=MOBILE_CAMERA`, {
        method: 'POST', headers: { 'content-type': 'application/sdp', 'x-proctor-session-token': token }, body: 'v=0\r\n',
      });
      assert.equal((await publishCamera(cameraRequest(previousMobileToken.token))).status, 401);
      assert.equal((await publishCamera(cameraRequest(mobile.miniProgramSessionToken))).status, requireSecondCamera ? 201 : 409);
      assert.equal(upstreamCalls, requireSecondCamera ? 1 : 0);
    } finally {
      globalThis.fetch = fetchBefore;
    }
    assert.equal(await prisma.loginRequest.count({ where: { examId } }), 1, 'phone recovery does not repeat examination approval');
    const repeatedPoll = await polling(marker, pair.pairCode, pair.pollToken);
    assert.equal(repeatedPoll.desktopSessionToken, null);
    assert.equal(repeatedPoll.loginRequest.requirements.requireSecondCamera, requireSecondCamera);
    assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } })).desktopTokenHash, desktopToken.tokenHash);

    await post(reconnect, '/api/client/reconnect', { pairCode: pair.pairCode, recoverySecret: pair.recoverySecret, deviceId: `${marker}-replay` }, 403);
    const expired = await post(createPair, '/api/client/pair', pairInput(marker, session.id), 200, desktopToken.token);
    await prisma.pairingSession.update({ where: { pairCode: expired.pairCode }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await post(reconnect, '/api/client/reconnect', { pairCode: expired.pairCode, recoverySecret: expired.recoverySecret, deviceId: `${marker}-expired-phone` }, 410);
    const afterExpired = await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(afterExpired.miniProgramDeviceId, phoneDeviceId);
    assert.equal(afterExpired.miniProgramTokenHash, refreshed.miniProgramTokenHash);
    assert.equal(afterExpired.desktopTokenHash, desktopToken.tokenHash);
  }

  const racing = await post(createPair, '/api/client/pair', pairInput(marker, session.id), 200, desktopToken.token);
  const concurrent = await Promise.all(['a', 'b'].map(suffix => reconnect(new Request('http://localhost:4031/api/client/reconnect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairCode: racing.pairCode, recoverySecret: racing.recoverySecret, deviceId: `${marker}-race-${suffix}` }),
  }))));
  assert.equal(concurrent.filter(response => response.status === 200).length, 1, 'the recovery capability can be consumed only once across simultaneous requests');
  assert.ok(concurrent.every(response => [200, 403, 410].includes(response.status)));
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } })).desktopTokenHash, desktopToken.tokenHash);

  // A lost initial poll can deliver the same token again without rotating it.
  const initialDeviceId = `${marker}-initial-desktop`;
  const initial = await post(createPair, '/api/client/pair', pairInput(initialDeviceId), 200);
  await post(reconnect, '/api/client/reconnect', { pairCode: initial.pairCode, recoverySecret: initial.pollToken, deviceId: `${marker}-initial-attack` }, 403);
  const sameDeviceAnonymous = await post(createPair, '/api/client/pair', pairInput(marker), 200);
  await post(reconnect, '/api/client/reconnect', { pairCode: sameDeviceAnonymous.pairCode, recoverySecret: sameDeviceAnonymous.pollToken, deviceId: `${marker}-device-attack` }, 403);
  const initialLogin = await prisma.loginRequest.create({ data: { examId, candidateId: candidate.id, status: 'REQUESTING' } });
  const initialSession = await prisma.clientSession.create({ data: {
    examId, candidateId: candidate.id, loginRequestId: initialLogin.id, desktopDeviceId: initialDeviceId,
  } });
  await prisma.pairingSession.update({ where: { pairCode: initial.pairCode }, data: { loginRequestId: initialLogin.id } });
  const issued = await polling(initialDeviceId, initial.pairCode, initial.pollToken);
  assert.ok(issued.desktopSessionToken);
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: initialSession.id } })).desktopTokenHash, hashClientSessionToken(issued.desktopSessionToken));
  assert.equal((await polling(initialDeviceId, initial.pairCode, initial.pollToken)).desktopSessionToken, issued.desktopSessionToken);
  const concurrentPolls = await Promise.all(Array.from({ length: 3 }, () => polling(initialDeviceId, initial.pairCode, initial.pollToken)));
  assert.ok(concurrentPolls.every(result => result.desktopSessionToken === issued.desktopSessionToken));
  assert.equal((await polling(initialDeviceId, initial.pairCode, initial.pollToken, issued.desktopSessionToken)).desktopSessionToken, null);
  const stableSession = await prisma.clientSession.findUniqueOrThrow({ where: { id: initialSession.id } });
  assert.equal(stableSession.desktopTokenHash, hashClientSessionToken(issued.desktopSessionToken));
  assert.ok(stableSession.lastDesktopSeenAt);
  const rotated = createClientSessionToken();
  await prisma.clientSession.update({ where: { id: initialSession.id }, data: { desktopTokenHash: rotated.tokenHash } });
  assert.equal((await polling(initialDeviceId, initial.pairCode, initial.pollToken)).desktopSessionToken, null, 'old pairing never replaces a rotated credential');
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: initialSession.id } })).desktopTokenHash, rotated.tokenHash);

  await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'FINISHED' } });
  await post(createPair, '/api/client/pair', pairInput(marker, session.id), 409, desktopToken.token);
  console.log('PASS: approved/in-exam second-camera recovery without a saved phone token; desktop authentication and token preservation; server-relative QR TTL; expired QR rejection; room requirement overrides; initial pairing token issuance.');
} finally {
  await prisma.pairingSession.deleteMany({ where: { desktopDeviceId: { startsWith: marker } } });
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  assert.equal(await prisma.pairingSession.count({ where: { desktopDeviceId: { startsWith: marker } } }), 0);
  if (examId) assert.equal(await prisma.exam.count({ where: { id: examId } }), 0);
  await prisma.$disconnect();
}
