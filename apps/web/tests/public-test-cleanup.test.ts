import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/lib/db';
import { cleanupPublicTestState, PUBLIC_TEST_STATE_SECONDS } from '../src/lib/public-test';
import { hashClientSessionToken } from '../src/lib/client-auth';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';

type Row = Record<string, any>;
const now = new Date();
const old = new Date(now.getTime() - 2 * PUBLIC_TEST_STATE_SECONDS * 1000);
const desktopToken = 'test-desktop-token';
const mobileToken = 'test-mobile-token';

async function withStore(changes: Row, operation: (store: Row) => Promise<void>) {
  const candidate: Row = {
    id: 'candidate', examId: 'exam', name: '体验考生', examNumber: 'TEST', password: 'permanent-password',
    status: 'APPROVED', startedAt: null, abnormal: false, createdAt: old, updatedAt: now,
    publicTestAccount: { externalUserId: '123', candidateId: 'candidate' }, ...changes,
  };
  const exam = { id: 'exam', durationMinutes: 30, flexible: true, startAt: old,
    endAt: new Date('9999-12-31T23:30:00Z'), requireFrontCamera: true, requireMiniProgram: true };
  const store: Row = { candidate, sessions: [{ id: 'test_session', examId: 'exam', candidateId: candidate.id,
    status: 'APPROVED', createdAt: now, approvedAt: now, startedAt: null, endedAt: null, revokedAt: null,
    desktopDeviceId: 'desktop-device', miniProgramDeviceId: 'mobile-device',
    desktopTokenHash: hashClientSessionToken(desktopToken), miniProgramTokenHash: hashClientSessionToken(mobileToken),
    lastDesktopSeenAt: now, lastMiniProgramSeenAt: now, lockdown: false }], pairs: 1, submissions: 1, writes: 0 };
  const countSessions = ({ where }: Row) => store.sessions.filter((session: Row) =>
    session.candidateId === where.candidateId && (!where.status || session.status !== where.status.not)).length;
  const sessionWithRelations = () => store.sessions[0] ? { ...store.sessions[0], candidate: store.candidate, exam } : null;
  const tx = {
    $queryRaw: async () => [],
    systemSetting: { findUnique: async () => ({ value: { examId: 'exam' } }) },
    candidate: {
      findUnique: async () => store.candidate,
      update: async ({ data }: Row) => { store.writes++; return Object.assign(store.candidate, data); },
      delete: async () => { store.candidate = null; },
    },
    clientSession: {
      findMany: async () => store.sessions,
      findUnique: async () => sessionWithRelations(),
      count: async (query: Row) => countSessions(query),
      update: async ({ data }: Row) => Object.assign(store.sessions[0], data),
      updateMany: async ({ data }: Row) => { Object.assign(store.sessions[0], data); return { count: 1 }; },
      deleteMany: async () => { store.sessions = []; },
    },
    loginRequest: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    pairingSession: { deleteMany: async () => { store.pairs = 0; } },
    contestSubmission: { deleteMany: async () => { store.submissions = 0; } },
    examRoom: { findFirst: async () => null },
  };
  const originals = {
    marker: prisma.systemSetting.findUnique, deleteSettings: prisma.systemSetting.deleteMany,
    exam: prisma.exam.findUnique, candidates: prisma.candidate.findMany,
    session: prisma.clientSession.findUnique, transaction: prisma.$transaction,
  };
  prisma.systemSetting.findUnique = (async () => ({ value: { examId: 'exam' } })) as unknown as typeof originals.marker;
  prisma.systemSetting.deleteMany = (async () => ({ count: 0 })) as typeof originals.deleteSettings;
  prisma.exam.findUnique = (async () => exam) as unknown as typeof originals.exam;
  // Return a stale scan result to exercise the checks after the candidate row lock.
  prisma.candidate.findMany = (async () => [{ id: candidate.id }]) as unknown as typeof originals.candidates;
  prisma.clientSession.findUnique = (async () => sessionWithRelations()) as unknown as typeof originals.session;
  prisma.$transaction = (async (callback: (client: unknown) => Promise<unknown>) => callback(tx)) as typeof originals.transaction;
  try { await operation(store); }
  finally {
    prisma.systemSetting.findUnique = originals.marker;
    prisma.systemSetting.deleteMany = originals.deleteSettings;
    prisma.exam.findUnique = originals.exam;
    prisma.candidate.findMany = originals.candidates;
    prisma.clientSession.findUnique = originals.session;
    prisma.$transaction = originals.transaction;
  }
}

async function sendHeartbeat(side: 'DESKTOP' | 'MINIPROGRAM') {
  return heartbeat(new Request('http://localhost/api/client/heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${side === 'DESKTOP' ? desktopToken : mobileToken}` },
    body: JSON.stringify({ sessionId: 'test_session', deviceId: side === 'DESKTOP' ? 'desktop-device' : 'mobile-device', side }),
  }));
}

test('reused old test accounts retain both authenticated heartbeats across the first minute of cleanup', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  await withStore({}, async store => {
    for (const seconds of [0, 30, 60, 90]) {
      t.mock.timers.setTime(now.getTime() + seconds * 1000);
      await cleanupPublicTestState(new Date());
      assert.equal((await sendHeartbeat('DESKTOP')).status, 200);
      assert.equal((await sendHeartbeat('MINIPROGRAM')).status, 200);
      assert.equal(store.candidate.startedAt, null, 'waiting for start must not start or end the exam clock');
    }
    assert.equal(store.sessions.length, 1);
    assert.equal(store.sessions[0].desktopTokenHash, hashClientSessionToken(desktopToken));
    assert.equal(store.sessions[0].miniProgramTokenHash, hashClientSessionToken(mobileToken));
    assert.equal(store.pairs, 1);
    assert.equal(store.submissions, 1);
  });
});

test('an active waiting session is retained even when the candidate activity timestamp is stale', async () => {
  await withStore({ updatedAt: old }, async store => {
    await cleanupPublicTestState(now);
    assert.equal(store.sessions.length, 1);
    assert.equal(store.writes, 0);
  });
});

test('recently reset or reactivated accounts survive stale cleanup scans', async () => {
  await withStore({ status: 'NOT_REQUESTED' }, async store => {
    store.sessions = [];
    await cleanupPublicTestState(now);
    assert.equal(store.writes, 0);
    assert.equal(store.candidate.password, 'permanent-password');
  });
});

test('an ongoing started test survives cleanup until its own thirty-minute duration ends', async () => {
  const startedAt = new Date(now.getTime() - 5 * 60_000);
  await withStore({ status: 'ONLINE_NORMAL', startedAt }, async store => {
    await cleanupPublicTestState(now);
    assert.equal(store.sessions.length, 1);
    assert.equal(store.candidate.startedAt, startedAt);
    assert.equal(store.writes, 0);
  });
});

test('finished tests still retire temporary state and retain permanent credentials', async () => {
  await withStore({ status: 'FINISHED', updatedAt: new Date(now.getTime() - 120_000) }, async store => {
    await cleanupPublicTestState(now);
    assert.equal(store.sessions.length, 0);
    assert.equal(store.pairs, 0);
    assert.equal(store.submissions, 0);
    assert.equal(store.candidate.status, 'NOT_REQUESTED');
    assert.equal(store.candidate.password, 'permanent-password');
    assert.equal(store.candidate.publicTestAccount.externalUserId, '123');
  });
});

test('expired tests still reset after the duration and cleanup grace period', async () => {
  await withStore({ status: 'ONLINE_NORMAL', startedAt: new Date(now.getTime() - 32 * 60_000) }, async store => {
    await cleanupPublicTestState(now);
    assert.equal(store.sessions.length, 0);
    assert.equal(store.candidate.startedAt, null);
    assert.equal(store.candidate.status, 'NOT_REQUESTED');
  });
});

test('unused stale state with only finished sessions is cleaned for permanent accounts', async () => {
  await withStore({ status: 'OFFLINE', updatedAt: old }, async store => {
    store.sessions[0].status = 'FINISHED';
    await cleanupPublicTestState(now);
    assert.equal(store.sessions.length, 0);
    assert.equal(store.candidate.status, 'NOT_REQUESTED');
    assert.equal(store.candidate.password, 'permanent-password');
  });
});

test('abandoned anonymous test accounts are removed after their last activity expires', async () => {
  await withStore({ status: 'NOT_REQUESTED', updatedAt: old, publicTestAccount: null }, async store => {
    store.sessions = [];
    await cleanupPublicTestState(now);
    assert.equal(store.candidate, null);
    assert.equal(store.pairs, 0);
  });
});

test('public test cleanup cannot retire a formal exam candidate from a stale scan', async () => {
  await withStore({ examId: 'formal-exam', status: 'FINISHED', updatedAt: old }, async store => {
    await cleanupPublicTestState(now);
    assert.equal(store.sessions.length, 1);
    assert.equal(store.pairs, 1);
    assert.equal(store.submissions, 1);
    assert.equal(store.writes, 0);
  });
});
