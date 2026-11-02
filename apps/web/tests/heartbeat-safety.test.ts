import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { hashClientSessionToken } from '../src/lib/client-auth';
import { POST } from '../src/app/api/client/heartbeat/route';
import { createAlertOnce } from '../src/lib/alert-dedup';
import { SessionWriteQueueError } from '../src/lib/session-write';

const token = 'test-secret-session-token';
function fixture(changes: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'session', examId: 'exam', candidateId: 'candidate', status: 'IN_EXAM',
    desktopDeviceId: 'desktop-device', miniProgramDeviceId: 'mobile-device',
    desktopTokenHash: hashClientSessionToken(token), miniProgramTokenHash: hashClientSessionToken('mobile-token'),
    candidate: { id: 'candidate', status: 'ONLINE_NORMAL', startedAt: new Date(now - 60_000), abnormal: false },
    exam: { startAt: new Date(now - 120_000), endAt: new Date(now + 3_600_000), latestStartAt: new Date(now + 60_000), durationMinutes: 60, contestRule: 'XCPC', requireFrontCamera: true, requireMiniProgram: true },
    approvedAt: new Date(now - 90_000), startedAt: new Date(now - 60_000), endedAt: null,
    lastDesktopSeenAt: new Date(now - 10_000), lastMiniProgramSeenAt: new Date(now - 1_000), desktopOfflineAt: null, miniProgramOfflineAt: null,
    lockdown: false, lockdownReason: null, peripheralsBaselineFingerprint: 'baseline', lastPeripheralsFingerprint: 'baseline',
    ...changes
  };
}

async function heartbeat(session: ReturnType<typeof fixture>, input: Record<string, unknown> = {}, requestToken = token, transactionError?: Error, savedAlerts = new Map<string, Record<string, unknown>>()) {
  const sessionWrites: Record<string, unknown>[] = [];
  const candidateWrites: Record<string, unknown>[] = [];
  let preliminaryLookups = 0, evidenceLookups = 0, candidateLookups = 0;
  let locked = false;
  const tx = {
    $queryRaw: async () => { locked = true; return [{ id: session.id }]; },
    systemSetting: { findUnique: async () => null },
    clientSession: {
      findUnique: async () => { assert.equal(locked, true); return session; },
      update: async ({ data }: { data: Record<string, unknown> }) => { sessionWrites.push(data); return { ...session, ...data }; },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { sessionWrites.push(data); return { count: 1 }; }
    },
    candidate: { findUniqueOrThrow: async () => { candidateLookups++; return session.candidate; }, update: async ({ data }: { data: Record<string, unknown> }) => { candidateWrites.push(data); return session.candidate; } },
    examRoom: { findFirst: async () => null },
    mediaSegment: { findFirst: async () => { evidenceLookups++; return null; } },
    alert: { findFirst: async ({ where }: { where: { id?: string } }) => where.id ? savedAlerts.get(where.id) || null : null, create: async ({ data }: { data: Record<string, unknown> }) => { const alert = { id: 'created-alert', ...data }; if (typeof alert.id === 'string') savedAlerts.set(alert.id, alert); return alert; } }
  };
  const findUnique = prisma.clientSession.findUnique;
  const marker = prisma.systemSetting.findUnique;
  const recordingEvents = prisma.alert.findMany;
  const transaction = prisma.$transaction;
  prisma.clientSession.findUnique = (async () => { preliminaryLookups++; return { id: session.id }; }) as unknown as typeof findUnique;
  prisma.systemSetting.findUnique = (async () => null) as typeof marker;
  prisma.alert.findMany = (async () => []) as typeof recordingEvents;
  prisma.$transaction = (async (operation: (client: unknown) => Promise<unknown>) => {
    if (transactionError) throw transactionError;
    return operation(tx);
  }) as typeof transaction;
  try {
    const response = await POST(new Request('http://localhost/api/client/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(requestToken ? { authorization: `Bearer ${requestToken}` } : {}) },
      body: JSON.stringify({ sessionId: session.id, deviceId: 'desktop-device', side: 'DESKTOP', ...input })
    }));
    return { response, body: await response.json(), sessionWrites, candidateWrites, preliminaryLookups, evidenceLookups, candidateLookups };
  } finally {
    prisma.clientSession.findUnique = findUnique;
    prisma.systemSetting.findUnique = marker;
    prisma.alert.findMany = recordingEvents;
    prisma.$transaction = transaction;
  }
}

test('knowing a device/session ID never issues a missing token or writes an unauthenticated heartbeat', async () => {
  const result = await heartbeat(fixture({ desktopTokenHash: null }), {}, '');
  assert.equal(result.response.status, 401);
  assert.equal(result.sessionWrites.length, 0);
  assert.equal(result.candidateWrites.length, 0);
});

test('an overloaded or expired heartbeat queue returns a retryable response without writes', async () => {
  const result = await heartbeat(fixture(), {}, token, new SessionWriteQueueError());
  assert.equal(result.response.status, 503);
  assert.match(result.body.message, /繁忙/);
  assert.equal(result.sessionWrites.length, 0);
  assert.equal(result.candidateWrites.length, 0);
});

test('valid session tokens cannot heartbeat on behalf of a different bound device', async () => {
  const result = await heartbeat(fixture(), { deviceId: 'different-device' });
  assert.equal(result.response.status, 401);
  assert.equal(result.sessionWrites.length, 0);
});

test('desktop heartbeat updates only its own clock and does not erase mobile reconnection state', async () => {
  const result = await heartbeat(fixture());
  assert.equal(result.response.status, 200);
  assert.ok(result.sessionWrites[0].lastDesktopSeenAt instanceof Date);
  assert.equal('lastMiniProgramSeenAt' in result.sessionWrites[0], false);
  assert.equal('miniProgramOfflineAt' in result.sessionWrites[0], false);
  assert.equal(result.preliminaryLookups, 0, 'session lookup happens only after taking the row lock');
  assert.equal(result.candidateLookups, 0, 'normal steady-state heartbeats need no candidate reconciliation read');
  assert.equal(result.candidateWrites.length, 0, 'normal steady-state heartbeats do not rewrite the candidate');
});

test('concurrent policy violations share one evidence lookup for the same channel', async () => {
  const result = await heartbeat(fixture(), {
    capture: { screenOk: false }, system: { processes: ['fake.exe'], networkRemotes: ['example.invalid'], vmSignals: ['test-hypervisor'] }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.alertsCreated, 4);
  assert.equal(result.evidenceLookups, 1);
});

test('formal sessions keep both tokens and their state while awaiting review, awaiting start, and in exam', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const status of ['WAITING_REVIEW', 'APPROVED', 'IN_EXAM']) {
    const startedAt = status === 'IN_EXAM' ? new Date(Date.now() - 60_000) : null;
    const session = fixture({ status, createdAt: new Date(Date.now() - 86_400_000), startedAt,
      approvedAt: status === 'WAITING_REVIEW' ? null : new Date(Date.now() - 60_000),
      candidate: { id: 'candidate', startedAt, abnormal: false },
    });
    for (let tick = 0; tick < 15; tick++) {
      t.mock.timers.tick(5000);
      const desktop = await heartbeat(session);
      assert.equal(desktop.response.status, 200);
      assert.equal(desktop.body.data.session.status, status);
      assert.equal(desktop.body.data.desktopSessionToken, null);
      Object.assign(session, desktop.sessionWrites[0]);
      const mobile = await heartbeat(session, { side: 'MINIPROGRAM', deviceId: 'mobile-device' }, 'mobile-token');
      assert.equal(mobile.response.status, 200);
      assert.equal(mobile.body.data.session.status, status);
      assert.equal(mobile.body.data.miniProgramSessionToken, null);
      Object.assign(session, mobile.sessionWrites[0]);
      assert.equal(session.desktopTokenHash, hashClientSessionToken(token));
      assert.equal(session.miniProgramTokenHash, hashClientSessionToken('mobile-token'));
      assert.equal(session.startedAt, startedAt);
    }
  }
});

test('a formal session is retained when either required side is still online after a long single-side outage', async () => {
  for (const offlineSide of ['DESKTOP', 'MINIPROGRAM']) {
    const offlineAt = new Date(Date.now() - 600_000);
    const session = fixture({ createdAt: offlineAt,
      ...(offlineSide === 'DESKTOP' ? { lastDesktopSeenAt: offlineAt } : { lastMiniProgramSeenAt: offlineAt }),
    });
    const result = offlineSide === 'DESKTOP'
      ? await heartbeat(session, { side: 'MINIPROGRAM', deviceId: 'mobile-device' }, 'mobile-token')
      : await heartbeat(session);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.session.status, 'IN_EXAM');
    assert.equal(result.body.data.session.revokedAt, undefined);
    assert.equal(session.desktopTokenHash, hashClientSessionToken(token));
    assert.equal(session.miniProgramTokenHash, hashClientSessionToken('mobile-token'));
  }
});

test('heartbeats from a finished old login cannot finish or reactivate the candidate new login', async () => {
  const result = await heartbeat(fixture({ status: 'FINISHED', endedAt: new Date() }));
  assert.equal(result.body.data.session.status, 'FINISHED');
  assert.equal(result.candidateWrites.length, 0);
});

test('acknowledged peripheral fingerprints do not repeatedly lock the client', async () => {
  const result = await heartbeat(fixture({ lastPeripheralsFingerprint: 'changed' }), { system: { peripheralsFingerprint: 'changed' } });
  assert.equal(result.body.data.session.status, 'IN_EXAM');
  assert.equal(result.body.data.alertsCreated, 0);
  assert.notEqual(result.sessionWrites[0].lockdown, true);
});

test('upgrading the macOS USB scan rebases a legacy fingerprint once without a false lock', async () => {
  const legacy = 'a'.repeat(64);
  const current = `mac-usb-v2:${'b'.repeat(64)}`;
  const result = await heartbeat(fixture({ peripheralsBaselineFingerprint: legacy, lastPeripheralsFingerprint: legacy }), {
    system: { peripheralsFingerprint: current }
  });
  assert.equal(result.body.data.session.status, 'IN_EXAM');
  assert.equal(result.body.data.alertsCreated, 0);
  assert.equal(result.sessionWrites[0].peripheralsBaselineFingerprint, current);
  assert.notEqual(result.sessionWrites[0].lockdown, true);
});

test('a USB change after the new baseline still locks the exam', async () => {
  const baseline = `mac-usb-v2:${'b'.repeat(64)}`;
  const changed = `mac-usb-v2:${'c'.repeat(64)}`;
  const result = await heartbeat(fixture({ peripheralsBaselineFingerprint: baseline, lastPeripheralsFingerprint: baseline }), {
    system: { peripheralsFingerprint: changed }
  });
  assert.equal(result.body.data.session.status, 'LOCKED');
  assert.equal(result.body.data.alertsCreated, 1);
  assert.equal(result.sessionWrites[0].lockdown, true);
});

test('only explicit forward USB fingerprint formats establish a new approved baseline', async () => {
  for (const [baseline, current] of [
    ['a'.repeat(64), `usb-v3:${'b'.repeat(64)}`],
    ['a'.repeat(64), `usb-v4:${'b'.repeat(64)}`],
    [`usb-v3:${'a'.repeat(64)}`, `usb-v4:${'b'.repeat(64)}`],
    ['a'.repeat(64), `usb-v5:${'b'.repeat(64)}`],
    [`usb-v3:${'a'.repeat(64)}`, `usb-v5:${'b'.repeat(64)}`],
    [`usb-v4:${'a'.repeat(64)}`, `usb-v5:${'b'.repeat(64)}`],
    ['a'.repeat(64), `usb-v6:${'b'.repeat(64)}`],
    [`usb-v3:${'a'.repeat(64)}`, `usb-v6:${'b'.repeat(64)}`],
    [`usb-v4:${'a'.repeat(64)}`, `usb-v6:${'b'.repeat(64)}`],
    [`usb-v5:${'a'.repeat(64)}`, `usb-v6:${'b'.repeat(64)}`],
    ['a'.repeat(64), `mac-usb-v3:${'b'.repeat(64)}`],
    [`mac-usb-v2:${'a'.repeat(64)}`, `mac-usb-v3:${'b'.repeat(64)}`]
  ]) {
    const result = await heartbeat(fixture({ peripheralsBaselineFingerprint: baseline, lastPeripheralsFingerprint: baseline }), {
      system: { peripheralsFingerprint: current }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.session.status, 'IN_EXAM');
    assert.equal(result.body.data.alertsCreated, 0);
    assert.equal(result.sessionWrites[0].peripheralsBaselineFingerprint, current);
    assert.equal(result.sessionWrites[0].lastPeripheralsFingerprint, current);
  }
});

test('same-version changes, downgrades, cross-platform versions and malformed upgrades never reset the baseline', async () => {
  const oldHash = 'a'.repeat(64), newHash = 'b'.repeat(64);
  for (const [baseline, current] of [
    [oldHash, newHash],
    [`usb-v3:${oldHash}`, `usb-v3:${newHash}`],
    [`usb-v4:${oldHash}`, `usb-v4:${newHash}`],
    [`usb-v4:${oldHash}`, `usb-v3:${newHash}`],
    [`usb-v5:${oldHash}`, `usb-v5:${newHash}`],
    [`usb-v5:${oldHash}`, `usb-v4:${newHash}`],
    [`usb-v5:${oldHash}`, `usb-v3:${newHash}`],
    [`usb-v6:${oldHash}`, `usb-v6:${newHash}`],
    [`usb-v6:${oldHash}`, `usb-v5:${newHash}`],
    [`usb-v6:${oldHash}`, `usb-v4:${newHash}`],
    [`usb-v6:${oldHash}`, newHash],
    [`usb-v6:${oldHash}`, `mac-usb-v3:${newHash}`],
    [`mac-usb-v3:${oldHash}`, `mac-usb-v3:${newHash}`],
    [`mac-usb-v3:${oldHash}`, `mac-usb-v2:${newHash}`],
    [`mac-usb-v3:${oldHash}`, newHash],
    [`usb-v3:${oldHash}`, newHash],
    [`mac-usb-v2:${oldHash}`, `usb-v3:${newHash}`],
    [`usb-v3:${oldHash}`, `mac-usb-v3:${newHash}`],
    [`mac-usb-v3:${oldHash}`, `usb-v3:${newHash}`],
    [`mac-usb-v3:${oldHash}`, `usb-v5:${newHash}`],
    [`mac-usb-v3:${oldHash}`, `usb-v6:${newHash}`],
    [oldHash, `usb-v3:${newHash.slice(1)}`],
    [oldHash, `mac-usb-v3:${'B'.repeat(64)}`],
    ['unknown-format', `usb-v3:${newHash}`]
  ]) {
    const result = await heartbeat(fixture({ peripheralsBaselineFingerprint: baseline, lastPeripheralsFingerprint: baseline }), {
      system: { peripheralsFingerprint: current }
    });
    assert.equal(result.body.data.session.status, 'LOCKED', `${baseline} -> ${current}`);
    assert.equal(result.body.data.alertsCreated, 1);
    assert.equal(result.sessionWrites[0].peripheralsBaselineFingerprint, baseline);
  }
});

test('explicit USB scan failure locks once without accepting a stale or migrated fingerprint', async () => {
  const session = fixture();
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await heartbeat(session, { system: { peripheralScanOk: false, peripheralsFingerprint: 'untrusted-new-sample' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.session.status, 'LOCKED');
    assert.equal(result.body.data.session.lockdown, true);
    assert.match(result.body.data.session.lockdownReason, /USB/);
    assert.equal(result.body.data.alertsCreated, attempt === 0 ? 1 : 0);
    assert.equal(result.evidenceLookups, attempt === 0 ? 1 : 0);
    assert.equal('lastPeripheralsFingerprint' in result.sessionWrites[0], false);
    assert.equal('peripheralsBaselineFingerprint' in result.sessionWrites[0], false);
    Object.assign(session, result.sessionWrites[0]);
  }
  const recovered = await heartbeat(session, { system: { peripheralScanOk: true, peripheralsFingerprint: 'baseline' } });
  assert.equal(recovered.body.data.session.lockdown, true, 'restoring the scanner still requires a proctor unlock');
  assert.equal(recovered.body.data.alertsCreated, 0);
});

test('mobile scan errors and old clients without a scan-status field cannot falsely lock a desktop', async () => {
  const oldClient = await heartbeat(fixture(), { system: { peripheralsFingerprint: 'baseline' } });
  assert.equal(oldClient.body.data.session.lockdown, false);
  const mobile = await heartbeat(fixture(), { side: 'MINIPROGRAM', deviceId: 'mobile-device', system: { peripheralScanOk: false } }, 'mobile-token');
  assert.equal(mobile.body.data.session.lockdown, false);
  assert.equal(mobile.body.data.alertsCreated, 0);
});

test('heartbeat response preserves its row snapshot without leaking loaded candidate/exam relations', async () => {
  const result = await heartbeat(fixture());
  assert.equal(result.response.status, 200);
  const session = result.body.data.session;
  assert.equal(session.id, 'session');
  assert.equal(session.lastDesktopSeenAt, (result.sessionWrites[0].lastDesktopSeenAt as Date).toISOString());
  assert.equal(session.updatedAt, (result.sessionWrites[0].updatedAt as Date).toISOString());
  for (const field of ['candidate', 'exam', 'desktopTokenHash', 'miniProgramTokenHash', 'monitoringAlertState']) {
    assert.equal(field in session, false, field);
  }
});

test('format migration neither clears an existing lock nor accepts an unapproved previous change', async () => {
  for (const [oldFormat, newFormat] of [['mac-usb-v2', 'mac-usb-v3'], ['usb-v5', 'usb-v6']]) {
    const baseline = `${oldFormat}:${'a'.repeat(64)}`;
    for (const state of [
      { lockdown: true, status: 'LOCKED', lastPeripheralsFingerprint: baseline },
      { lockdown: false, status: 'IN_EXAM', lastPeripheralsFingerprint: `${oldFormat}:${'c'.repeat(64)}` }
    ]) {
      const result = await heartbeat(fixture({ peripheralsBaselineFingerprint: baseline, ...state }), {
        system: { peripheralsFingerprint: `${newFormat}:${'b'.repeat(64)}` }
      });
      assert.equal(result.body.data.session.status, 'LOCKED');
      assert.equal(result.body.data.session.lockdown, true);
      assert.equal(result.sessionWrites[0].peripheralsBaselineFingerprint, baseline);
    }
  }
});

test('missing or empty USB samples never overwrite the previous scan or report a change', async () => {
  for (const fingerprint of [undefined, '', '   ']) {
    const result = await heartbeat(fixture(), { system: { peripheralsFingerprint: fingerprint } });
    assert.equal(result.body.data.alertsCreated, 0);
    assert.equal(result.body.data.session.status, 'IN_EXAM');
    assert.equal('peripheralsBaselineFingerprint' in result.sessionWrites[0], false);
    assert.equal('lastPeripheralsFingerprint' in result.sessionWrites[0], false);
  }
});

test('mobile heartbeat does not report desktop process or screen state', async () => {
  const result = await heartbeat(fixture(), { side: 'MINIPROGRAM', deviceId: 'mobile-device', capture: { screenOk: false, desktopCameraOk: false }, system: { processes: ['fake.exe'] } }, 'mobile-token');
  assert.equal(result.body.data.alertsCreated, 0);
  assert.equal('lastDesktopSeenAt' in result.sessionWrites[0], false);
});

test('direct alerts and heartbeat alerts reuse existing cooldown rows rather than creating another', async () => {
  const existing = { id: 'existing', type: 'SCREEN_CAPTURE_LOST' };
  let creates = 0;
  const tx = { alert: { findFirst: async () => existing, create: async () => { creates++; return {}; } } } as unknown as Prisma.TransactionClient;
  const result = await createAlertOnce(tx, { examId: 'exam', candidateId: 'candidate', sessionId: 'session', type: 'SCREEN_CAPTURE_LOST', message: 'second reporter' });
  assert.ok(result.alert);
  assert.equal(result.alert.id, existing.id);
  assert.equal(result.created, false);
  assert.equal(creates, 0);
});


test('physical insert/remove notifications cannot disappear between fingerprint polls and retries cannot re-lock after a proctor unlocks', async () => {
  const events = [
    { id: 'd695ef66-9236-4666-a149-e0068ff0942d', action: 'INSERT', deviceId: 'USB\\VID_1234&PID_5678\\SERIAL' },
    { id: '56acf7cc-ce81-40ac-82a8-214fc4af8bfe', action: 'REMOVE', deviceId: 'USB\\VID_1234&PID_5678\\SERIAL' }
  ];
  const alerts = new Map<string, Record<string, unknown>>();
  const input = { system: { peripheralsFingerprint: 'baseline', peripheralScanOk: true, peripheralEvents: events } };
  const first = await heartbeat(fixture(), input, token, undefined, alerts);
  assert.equal(first.response.status, 200); assert.equal(first.body.data.alertsCreated, 2);
  assert.equal(first.body.data.session.lockdown, true); assert.equal(alerts.size, 2);
  assert.deepEqual(first.body.data.acceptedPeripheralEventIds, events.map(event => event.id));
  const replay = await heartbeat(fixture(), input, token, undefined, alerts);
  assert.equal(replay.body.data.alertsCreated, 0); assert.equal(replay.body.data.session.lockdown, false);
  assert.deepEqual(replay.body.data.acceptedPeripheralEventIds, events.map(event => event.id));
  const phone = await heartbeat(fixture(), { ...input, side: 'MINIPROGRAM', deviceId: 'mobile-device' }, 'mobile-token');
  assert.equal(phone.body.data.alertsCreated, 0); assert.equal(phone.body.data.session.lockdown, false);
});
