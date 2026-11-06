import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/lib/db';
import { hashClientSessionToken } from '../src/lib/client-auth';
import { createPairSecret } from '../src/lib/pairing-security';
import { POST as reconnect } from '../src/app/api/client/reconnect/route';
import { GET as pollPair } from '../src/app/api/client/pair/route';

test('bidirectional QR recovery retains the exam session and expires only when both sides are offline', async t => {
  const proof = createPairSecret('RECOVERY'), poll = createPairSecret('POLL');
  let session: any, pairing: any;
  let sessionLocks = 0;
  const settings = new Map<string, unknown>();
  const room = { requireSecondCamera: true, requireFrontCamera: true, loginMode: 'SECOND_CAMERA_QR' };
  const reset = () => {
    settings.clear();
    const now = Date.now();
    const exam = { id: 'exam', name: '考试', endAt: new Date(now + 3_600_000), contestRule: 'IOI', flexible: false, requireMiniProgram: true, requireFrontCamera: true, ipLoginRestrictionEnabled: true };
    session = { id: 'session', examId: exam.id, candidateId: 'candidate', loginRequestId: 'login', exam, status: 'OFFLINE', revokedAt: null, lockdown: false,
      createdAt: new Date(now - 300_000), startedAt: new Date(now - 200_000), approvedAt: new Date(now - 240_000),
      lastDesktopSeenAt: new Date(now - 60_000), lastMiniProgramSeenAt: new Date(now - 1000), desktopDeviceId: 'old-desktop', miniProgramDeviceId: 'phone-device',
      desktopTokenHash: hashClientSessionToken('old-desktop-token'), miniProgramTokenHash: hashClientSessionToken('phone-token'), candidate: { id: 'candidate' } };
    pairing = { id: 'pair', pairCode: '123456', purpose: 'INITIAL', desktopDeviceId: 'new-desktop', desktopLoginIp: '127.0.0.1', screenOk: true, desktopCameraOk: true,
      peripheralsFingerprint: 'new-baseline', claimedAt: null, expiresAt: new Date(now + 300_000), recoveryTokenHash: proof.hash, pollTokenHash: poll.hash, desktopTokenIssuedAt: null };
  };
  const replace = (target: object, key: string, implementation: unknown) => {
    const item = target as Record<string, unknown>, before = item[key]; item[key] = implementation;
    t.after(() => { item[key] = before; });
  };
  replace(prisma, '$queryRaw', async (query: TemplateStringsArray) => { if (query.join('').includes('ClientSession')) sessionLocks++; return []; });
  replace(prisma, '$transaction', async (callback: any) => callback(prisma));
  replace(prisma.systemSetting, 'findUnique', async ({ where }: any) => settings.get(where.key) || null);
  replace(prisma.systemSetting, 'upsert', async ({ where, create, update }: any) => {
    const row = settings.has(where.key) ? { ...settings.get(where.key) as object, ...update } : create;
    settings.set(where.key, row); return row;
  });
  replace(prisma.exam, 'findUnique', async () => session.exam);
  replace(prisma.candidate, 'findUnique', async () => ({ id: 'candidate', examId: 'exam', loginIp: '127.0.0.1' }));
  replace(prisma.examRoom, 'findFirst', async () => room);
  replace(prisma.clientSession, 'findUnique', async ({ where }: any) => where.id === session.id ? session : null);
  replace(prisma.clientSession, 'update', async ({ data }: any) => { session = { ...session, ...data }; return session; });
  replace(prisma.clientSession, 'count', async () => 0);
  replace(prisma.candidate, 'update', async () => ({}));
  replace(prisma.loginRequest, 'updateMany', async () => ({ count: 0 }));
  replace(prisma.pairingSession, 'findUnique', async ({ where }: any) => (where.pairCode === pairing.pairCode || where.id === pairing.id) ? { ...pairing,
    loginRequest: pairing.loginRequestId ? { id: 'login', status: 'APPROVED', candidateId: session.candidateId, examId: session.examId,
      candidate: session.candidate, exam: session.exam, clientSessions: [session] } : null } : null);
  replace(prisma.pairingSession, 'updateMany', async ({ where, data }: any) => {
    if (where.OR) { pairing = { ...pairing, ...data }; return { count: 1 }; }
    for (const key of ['id', 'purpose', 'recoverySessionId', 'recoveryTokenHash', 'pollTokenHash', 'claimedAt', 'desktopTokenIssuedAt']) {
      if (key in where && where[key] !== pairing[key]) return { count: 0 };
    }
    if (where.expiresAt && pairing.expiresAt <= where.expiresAt.gt) return { count: 0 };
    pairing = { ...pairing, ...data }; return { count: 1 };
  });
  const post = async (overrides: object = {}, token = 'phone-token') => {
    const response = await reconnect(new Request('https://api.test/api/client/reconnect', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-proctor-session-token': token, 'x-forwarded-for': '192.0.2.50' },
      body: JSON.stringify({ side: 'DESKTOP', sessionId: 'session', deviceId: 'phone-device', pairCode: '123456', recoverySecret: proof.secret, ...overrides }) }));
    return { response, body: await response.json() };
  };
  await t.test('online phone restores a disconnected desktop and only the desktop poll receives its replacement token', async () => {
    reset(); const startedAt = session.startedAt, phoneHash = session.miniProgramTokenHash;
    const result = await post(); assert.equal(result.response.status, 200, result.body.message);
    assert.equal(result.body.data.sessionId, 'session'); assert.equal(result.body.data.miniProgramSessionToken, undefined);
    assert.equal(result.body.data.session.desktopTokenHash, undefined);
    assert.equal(session.startedAt, startedAt); assert.equal(session.status, 'IN_EXAM');
    assert.equal(session.desktopDeviceId, 'new-desktop'); assert.equal(session.desktopTokenHash, null);
    assert.equal(settings.size, 1, 'recovery retires the previous desktop credential without using a live database');
    assert.equal(session.miniProgramTokenHash, phoneHash); assert.equal(pairing.purpose, 'DESKTOP_RECOVERY');
    assert.equal(pairing.loginRequestId, 'login');
    assert.equal(pairing.recoveryTokenHash, proof.hash, 'the current recovery proof remains available for an idempotent response retry');
    const request = (token = poll.secret, desktopToken?: string) => new Request('https://api.test/api/client/pair?deviceId=new-desktop&pairCode=123456', {
      headers: { 'x-proctor-pair-poll-token': token, 'x-forwarded-for': '127.0.0.1', ...(desktopToken ? { authorization: `Bearer ${desktopToken}` } : {}) },
    });
    assert.equal((await pollPair(request(''))).status, 401);
    const polled = await pollPair(request()); assert.equal(polled.status, 200);
    const data = (await polled.json()).data;
    assert.equal(data.loginRequest.session.id, 'session'); assert.ok(data.desktopSessionToken);
    assert.equal(session.desktopTokenHash, hashClientSessionToken(data.desktopSessionToken));
    const afterIssuanceLocks = sessionLocks;
    assert.equal((await (await pollPair(request())).json()).data.desktopSessionToken, data.desktopSessionToken, 'a retry without installed credentials returns the same token');
    assert.equal((await (await pollPair(request(poll.secret, data.desktopSessionToken))).json()).data.desktopSessionToken, null);
    assert.equal(sessionLocks, afterIssuanceLocks, 'fresh authenticated pair polling must not compete with heartbeats for a write lock');
    session.lastDesktopSeenAt = new Date(Date.now() - 6_000);
    assert.equal((await pollPair(request())).status, 200);
    assert.equal(sessionLocks, afterIssuanceLocks + 1, 'stale pairing polls still refresh liveness under the session lock');
    const retry = await post();
    assert.equal(retry.response.status, 200, 'the same authenticated recovery may retry without rotating the binding');
    assert.equal(session.desktopTokenHash, hashClientSessionToken(data.desktopSessionToken));
    assert.equal(settings.size, 1, 'an idempotent retry must not retire the newly issued desktop credential');
  });
  await t.test('unauthenticated phones, wrong devices, online desktops and failed hardware checks cannot authorize replacement', async () => {
    reset(); assert.equal((await post({}, '')).response.status, 401);
    assert.equal((await post({ deviceId: 'other-phone' })).response.status, 401);
    assert.equal((await post({ recoverySecret: 'x'.repeat(43) })).response.status, 403);
    session.lastDesktopSeenAt = new Date(); assert.equal((await post()).response.status, 409);
    session.lastDesktopSeenAt = new Date(Date.now() - 60_000); pairing.desktopCameraOk = false;
    assert.equal((await post()).response.status, 409); assert.equal(pairing.claimedAt, null);
  });
  await t.test('expired desktop login codes cannot rotate a token', async () => {
    reset(); pairing.expiresAt = new Date(Date.now() - 1);
    assert.equal((await post()).response.status, 410); assert.equal(session.desktopDeviceId, 'old-desktop');
  });
  await t.test('online desktop restores a phone after a long phone outage without changing its own token', async () => {
    reset(); pairing.purpose = 'RECOVERY'; pairing.recoverySessionId = session.id; pairing.desktopDeviceId = session.desktopDeviceId;
    session.status = 'IN_EXAM'; session.lastDesktopSeenAt = new Date(); session.lastMiniProgramSeenAt = new Date(Date.now() - 600_000);
    const desktopHash = session.desktopTokenHash, startedAt = session.startedAt;
    const result = await post({ side: 'MINIPROGRAM', deviceId: 'replacement-phone' }, '');
    assert.equal(result.response.status, 200, result.body.message);
    assert.equal(session.desktopTokenHash, desktopHash); assert.equal(session.startedAt, startedAt);
    assert.equal(session.miniProgramDeviceId, 'replacement-phone');
    assert.equal(session.miniProgramTokenHash, hashClientSessionToken(result.body.data.miniProgramSessionToken));
  });
  await t.test('both sides offline beyond two minutes can resume the original session without resetting the clock', async () => {
    for (const side of ['DESKTOP', 'MINIPROGRAM']) {
      reset(); const startedAt = session.startedAt;
      session.lastDesktopSeenAt = session.lastMiniProgramSeenAt = new Date(Date.now() - 121_000);
      if (side === 'MINIPROGRAM') { pairing.purpose = 'RECOVERY'; pairing.recoverySessionId = session.id; pairing.desktopDeviceId = session.desktopDeviceId; }
      const result = await post({ side }); assert.equal(result.response.status, 200, result.body.message);
      assert.ok(!session.revokedAt);
      assert.equal(session.startedAt, startedAt);
      assert.ok(side === 'DESKTOP' ? session.miniProgramTokenHash : session.desktopTokenHash);
    }
  });
});
