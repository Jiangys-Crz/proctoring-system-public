import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/lib/db';
import { hashClientSessionToken } from '../src/lib/client-auth';
import { POST as reportAlert } from '../src/app/api/client/alerts/route';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';

type Row = Record<string, any>;
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((item: Row) => matches(row, item));
    if (key === 'NOT') return (Array.isArray(condition) ? condition : [condition]).every((item: Row) => !matches(row, item));
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      return Object.entries(condition).every(([operator, operand]) => {
        if (operator === 'gte') return row[key] >= (operand as Date);
        if (operator === 'lte') return row[key] <= (operand as Date);
        if (operator === 'startsWith') return String(row[key]).startsWith(String(operand));
        if (operator === 'contains') return String(row[key]).includes(String(operand));
        throw new Error(`Unsupported test predicate: ${operator}`);
      });
    }
    return row[key] === condition;
  });
}

async function withStore(operation: (rows: Row[], session: Row) => Promise<void>) {
  const now = Date.now();
  const rows: Row[] = [];
  const session: Row = {
    id: 'session', examId: 'exam', candidateId: 'candidate', status: 'IN_EXAM', createdAt: new Date(now - 3_600_000),
    desktopDeviceId: 'desktop-device', miniProgramDeviceId: 'mobile-device',
    desktopTokenHash: hashClientSessionToken('desktop-token'), miniProgramTokenHash: hashClientSessionToken('mobile-token'),
    candidate: { startedAt: new Date(now - 3_000_000), status: 'ONLINE_NORMAL', abnormal: false },
    exam: { endAt: new Date(now + 3_600_000), contestRule: 'XCPC', requireFrontCamera: true, requireMiniProgram: true },
    startedAt: new Date(now - 3_000_000), endedAt: null, lockdown: false,
    lastDesktopSeenAt: new Date(now), lastMiniProgramSeenAt: new Date(now), revokedAt: null,
  };
  let locked = false;
  const tx = {
    $queryRaw: async () => { locked = true; return [{ id: session.id }]; },
    systemSetting: { findUnique: async () => null },
    clientSession: { findUnique: async () => session, findUniqueOrThrow: async () => session, findMany: async () => [session], count: async () => 0,
      update: async ({ data }: Row) => Object.assign(session, data),
      updateMany: async ({ data }: Row) => { Object.assign(session, data); return { count: 1 }; } },
    pairingSession: { updateMany: async () => { assert.fail('a live heartbeat fixture must never be revoked'); } },
    candidate: { findUniqueOrThrow: async () => ({ ...session.candidate, examId: session.examId, exam: session.exam, rooms: [] }),
      update: async ({ data }: Row) => Object.assign(session.candidate, data) },
    cheatingRecord: { count: async () => 0 },
    examRoom: { findFirst: async () => null },
    mediaSegment: { findFirst: async () => null },
    alert: {
      count: async () => rows.filter(row => !row.acknowledgedAt).length,
      findFirst: async ({ where }: Row) => { assert.equal(locked, true); return rows.find((row) => matches(row, where)) || null; },
      create: async ({ data }: Row) => { assert.equal(locked, true); const row = { id: `row-${rows.length}`, createdAt: new Date(), evidenceDeletedAt: null, ...data }; rows.push(row); return row; }
    }
  };
  const originals = { session: prisma.clientSession.findUnique, media: prisma.mediaSegment.findFirst, transaction: prisma.$transaction,
    marker: prisma.systemSetting.findUnique, recordingEvents: prisma.alert.findMany };
  let queue = Promise.resolve<unknown>(null);
  prisma.clientSession.findUnique = (async () => session) as unknown as typeof originals.session;
  prisma.mediaSegment.findFirst = (async () => null) as unknown as typeof originals.media;
  prisma.systemSetting.findUnique = (async () => null) as typeof originals.marker;
  prisma.alert.findMany = (async ({ where }: Row) => rows.filter(row => matches(row, where))) as unknown as typeof originals.recordingEvents;
  prisma.$transaction = (async (callback: (client: unknown) => Promise<unknown>) => {
    const result = queue.then(async () => { locked = false; return callback(tx); });
    queue = result.catch(() => {});
    return result;
  }) as typeof originals.transaction;
  try { await operation(rows, session); }
  finally {
    prisma.clientSession.findUnique = originals.session;
    prisma.mediaSegment.findFirst = originals.media;
    prisma.$transaction = originals.transaction;
    prisma.systemSetting.findUnique = originals.marker;
    prisma.alert.findMany = originals.recordingEvents;
  }
}

function request(body: Row, token = 'desktop-token') {
  return new Request('http://localhost/api/client/test', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body)
  });
}

test('parallel direct reports and heartbeat detection create only one alert for the same incident', async () => {
  await withStore(async (rows) => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => index % 2
      ? reportAlert(request({ sessionId: 'session', type: 'SCREEN_CAPTURE_LOST', message: '屏幕采集异常', eventId: 'same-event', occurredAt: new Date().toISOString() }))
      : heartbeat(request({ sessionId: 'session', deviceId: 'desktop-device', side: 'DESKTOP', capture: { screenOk: false } }))));
    assert.ok(results.every((response) => response.ok));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'SCREEN_CAPTURE_LOST');
  });
});

test('mobile and desktop screen-switch incidents remain separate; delayed retries reuse the original occurrence', async () => {
  await withStore(async (rows) => {
    const occurredAt = new Date(Date.now() - 15 * 60_000).toISOString();
    const event = { sessionId: 'session', type: 'SCREEN_SWITCH', message: '切换页面', eventId: 'same-id', occurredAt };
    assert.equal((await reportAlert(request(event))).status, 201);
    assert.equal((await reportAlert(request(event, 'mobile-token'))).status, 201);
    assert.equal((await reportAlert(request(event))).status, 200);
    assert.equal((await reportAlert(request(event, 'mobile-token'))).status, 200);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.id.startsWith('mobile_alert_')));
    assert.ok(rows.every((row) => row.createdAt.toISOString() === occurredAt));
  });
});

test('second-camera credentials cannot lock the desktop or attach another session media path', async () => {
  await withStore(async (rows) => {
    assert.equal((await reportAlert(request({ sessionId: 'session', type: 'PERIPHERAL_CHANGED', message: 'fake lock' }, 'mobile-token'))).status, 403);
    assert.equal((await reportAlert(request({ sessionId: 'session', type: 'SCREEN_SWITCH', message: 'fake evidence', evidencePath: 'another-session/secret.webm' }))).status, 403);
    assert.equal(rows.length, 0);
  });
});

test('legacy direct USB reports cannot race a format migration into a false lock', async () => {
  await withStore(async (rows, session) => {
    const baseline = `mac-usb-v2:${'a'.repeat(64)}`;
    const current = `mac-usb-v3:${'b'.repeat(64)}`;
    Object.assign(session, { peripheralsBaselineFingerprint: baseline, lastPeripheralsFingerprint: baseline });
    const oldReport = { sessionId: session.id, type: 'PERIPHERAL_CHANGED', message: '检测到外设接入或移除', eventId: 'legacy-comparison' };
    const beat = { sessionId: session.id, deviceId: session.desktopDeviceId, side: 'DESKTOP', system: { peripheralsFingerprint: current } };
    const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => index % 2 ? reportAlert(request(oldReport)) : heartbeat(request(beat))));
    assert.ok(responses.every(response => response.status === 200));
    assert.equal(rows.length, 0);
    assert.equal(session.status, 'IN_EXAM');
    assert.equal(session.lockdown, false);
    assert.equal(session.peripheralsBaselineFingerprint, current);
    const delayed = await reportAlert(request({ ...oldReport, eventId: 'delayed-comparison' }));
    assert.equal((await delayed.json()).data.discarded, true);
    assert.equal(session.lockdown, false);
  });
});

test('a real USB change after migration still locks once and returns a recording event', async () => {
  await withStore(async (rows, session) => {
    const baseline = `usb-v3:${'a'.repeat(64)}`, current = `usb-v3:${'b'.repeat(64)}`;
    Object.assign(session, { peripheralsBaselineFingerprint: baseline, lastPeripheralsFingerprint: baseline });
    session.exam.saveIncidentRecording = true;
    const beat = { sessionId: session.id, deviceId: session.desktopDeviceId, side: 'DESKTOP', system: { peripheralsFingerprint: current } };
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => index % 2
      ? reportAlert(request({ sessionId: session.id, type: 'PERIPHERAL_CHANGED', message: 'legacy report' }))
      : heartbeat(request(beat))));
    assert.ok(responses.every(response => response.ok));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'PERIPHERAL_CHANGED');
    assert.equal(rows[0].severity, 5);
    assert.match(rows[0].message, new RegExp(baseline));
    assert.match(rows[0].message, new RegExp(current));
    assert.equal(session.lockdown, true);
    assert.equal(session.status, 'LOCKED');
    assert.equal(session.peripheralsBaselineFingerprint, baseline);
    const data = (await responses[0].json()).data;
    assert.deepEqual(data.recordingEvents, [{ id: rows[0].id, occurredAt: rows[0].createdAt.toISOString(), channel: 'DESKTOP_SCREEN' }]);
  });
});

test('compatibility USB reports still require current desktop credentials', async () => {
  await withStore(async (rows, session) => {
    const report = { sessionId: session.id, type: 'PERIPHERAL_CHANGED', message: 'legacy report' };
    assert.equal((await reportAlert(request(report, 'wrong-token'))).status, 401);
    assert.equal((await reportAlert(request(report, 'mobile-token'))).status, 403);
    session.revokedAt = new Date();
    assert.equal((await reportAlert(request(report))).status, 401);
    assert.equal(rows.length, 0);
    assert.equal(session.lockdown, false);
  });
});
