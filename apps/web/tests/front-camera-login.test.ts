import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Exam, PairingSession } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { createCandidateLoginRequest } from '../src/lib/candidate-login';
import { reconnectDesktop } from '../src/lib/desktop-reconnect';
import { hashClientSessionToken } from '../src/lib/client-auth';
import { POST as reportAlert } from '../src/app/api/client/alerts/route';

function fixture(method: 'CREDENTIALS' | 'SECOND_CAMERA_QR') {
  const now = Date.now();
  const exam = { id: 'exam', published: true, startAt: new Date(now - 60_000), latestStartAt: new Date(now + 60_000),
    endAt: new Date(now + 3_600_000), durationMinutes: 60, contestRule: 'IOI', flexible: false,
    requireFrontCamera: true, requireMiniProgram: false, ipLoginRestrictionEnabled: false } as Exam;
  const candidate = { id: 'candidate', examId: exam.id, status: 'NOT_REQUESTED', startedAt: null, loginIp: null };
  const room = { id: 'room', requireFrontCamera: true, requireSecondCamera: false, loginMode: method, loginReviewMode: 'MANUAL' };
  const pairing = { id: 'pair', purpose: 'INITIAL', desktopDeviceId: 'new-desktop', screenOk: true, desktopCameraOk: false,
    pollTokenHash: 'poll-proof', recoveryTokenHash: 'recovery-proof', claimedAt: null, expiresAt: new Date(now + 60_000) } as PairingSession;
  const session = { id: 'session', examId: exam.id, candidateId: candidate.id, exam, candidate,
    status: 'APPROVED', desktopDeviceId: 'old-desktop', desktopTokenHash: null as string | null,
    miniProgramDeviceId: 'phone', miniProgramTokenHash: hashClientSessionToken('phone-token'),
    createdAt: new Date(now - 60_000), lastDesktopSeenAt: new Date(now - 60_000), startedAt: null, revokedAt: null };
  let created = 0, retired = 0;
  const tx = {
    $queryRaw: async () => [],
    exam: { findUnique: async () => exam },
    candidate: { findUnique: async () => candidate, update: async () => candidate },
    examRoom: { findFirst: async () => room },
    systemSetting: { findUnique: async () => null, upsert: async () => { retired++; } },
    clientSession: {
      findMany: async () => [], findUnique: async () => session,
      create: async ({ data }: { data: object }) => { created++; return { id: 'created-session', ...data }; },
      update: async ({ data }: { data: object }) => ({ ...Object.assign(session, data) }),
    },
    pairingSession: {
      findUnique: async () => ({ ...pairing }),
      updateMany: async ({ where, data }: { where: { id: unknown }; data: object }) => {
        if (where.id === pairing.id) Object.assign(pairing, data);
        return { count: 1 };
      },
      update: async ({ data }: { data: object }) => ({ ...Object.assign(pairing, data) }),
    },
    loginRequest: { create: async ({ data }: { data: object }) => ({ id: 'login', ...data }) },
    liveWebRtcConnection: { deleteMany: async () => ({ count: 0 }) },
    contestLiveConnection: { deleteMany: async () => ({ count: 0 }) },
  };
  async function run<T>(operation: () => Promise<T>) {
    const restores: Array<() => void> = [];
    function replace<Target extends object, Key extends keyof Target>(target: Target, key: Key, value: unknown) {
      const previous = target[key];
      target[key] = value as Target[Key];
      restores.push(() => { target[key] = previous; });
    }
    replace(prisma.systemSetting, 'findUnique', tx.systemSetting.findUnique);
    replace(prisma.candidate, 'findUnique', tx.candidate.findUnique);
    replace(prisma.examRoom, 'findFirst', tx.examRoom.findFirst);
    replace(prisma, '$transaction', async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    try { return await operation(); } finally { restores.reverse().forEach(restore => restore()); }
  }
  return { exam, room, pairing, candidate, session, run, created: () => created, retired: () => retired };
}

for (const method of ['CREDENTIALS', 'SECOND_CAMERA_QR'] as const) {
  test(`${method} login succeeds without a camera even when both exam and room enable it`, async () => {
    const f = fixture(method);
    const result = await f.run(() => createCandidateLoginRequest({
      exam: f.exam, pairing: f.pairing, candidateId: f.candidate.id, memberIdentity: null, materials: {}, method,
    }));
    assert.equal(result.sessionId, 'created-session');
    assert.equal(result.requirements.requireFrontCamera, true, 'available cameras must still be enabled');
    assert.equal(f.pairing.desktopCameraOk, false, 'do not fake a successful device check');
    assert.equal(f.created(), 1);
  });
}

test('a missing screen still prevents a formal login', async () => {
  const f = fixture('CREDENTIALS');
  f.pairing.screenOk = false;
  await f.run(() => assert.rejects(createCandidateLoginRequest({
    exam: f.exam, pairing: f.pairing, candidateId: f.candidate.id, memberIdentity: null, materials: {}, method: 'CREDENTIALS',
  }), /屏幕/));
  assert.equal(f.created(), 0);
});

test('an authenticated phone can reconnect a desktop with no front camera after the old media stops', async (t) => {
  const f = fixture('SECOND_CAMERA_QR');
  f.room.requireSecondCamera = true;
  f.session.desktopTokenHash = hashClientSessionToken('old-desktop-token');
  const request = new Request('http://localhost/reconnect', { headers: { authorization: 'Bearer phone-token' } });
  let mediaReads = 0;
  let controlAvailable = false;
  const previousSecret = process.env.MEDIA_PUBLISH_SECRET;
  process.env.MEDIA_PUBLISH_SECRET = 'local-test-media-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.MEDIA_PUBLISH_SECRET;
    else process.env.MEDIA_PUBLISH_SECRET = previousSecret;
  });
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    assert.match(new URL(input).pathname, /^\/v3\/(?:paths|webrtc\/sessions|hls\/sessions|rtmp\/conns|rtmps\/conns)\/list$/);
    assert.equal(f.pairing.claimedAt, null, 'the replacement cannot publish while the old stream is being closed');
    assert.equal(f.session.desktopTokenHash, null);
    mediaReads++;
    return controlAvailable ? Response.json({ items: [], pageCount: 0 }) : new Response(null, { status: 503 });
  });
  t.mock.method(console, 'error', () => {});
  const reconnect = () => f.run(() => reconnectDesktop(request, { sessionId: f.session.id, deviceId: 'phone' }, f.pairing));
  assert.equal((await reconnect()).status, 503);
  assert.equal(f.pairing.claimedAt, null, 'a control outage must not release the desktop token');
  assert.equal(f.retired(), 1);
  controlAvailable = true;
  const response = await reconnect();
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.session.desktopDeviceId, 'new-desktop');
  assert.equal(body.data.requirements.requireFrontCamera, true);
  assert.ok(mediaReads > 0);
  assert.ok(f.pairing.claimedAt);
  const reads = mediaReads;
  assert.equal((await reconnect()).status, 200);
  assert.equal(f.retired(), 1);
  assert.equal(mediaReads, reads, 'a successful recovery replay must not kick the replacement stream');
});

test('legacy front-camera alerts are discarded only after authenticating the desktop', async () => {
  const original = prisma.clientSession.findUnique;
  prisma.clientSession.findUnique = (async () => ({ id: 'session', examId: 'exam', revokedAt: null,
    desktopTokenHash: hashClientSessionToken('desktop-token'), miniProgramTokenHash: null,
  })) as unknown as typeof original;
  const request = (token: string) => new Request('http://localhost/api/client/alerts', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: 'session', type: 'CAMERA_CAPTURE_LOST', message: '电脑摄像头采集异常' }),
  });
  try {
    const response = await reportAlert(request('desktop-token'));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.discarded, true);
    assert.equal((await reportAlert(request('invalid-token'))).status, 401);
  } finally { prisma.clientSession.findUnique = original; }
});
