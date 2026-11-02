// Dedicated local QA database only. The fixtures never access real media or
// account settings, and cascading exam deletion removes all created rows.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { acknowledgeAlert, refreshCandidateAlertStatus } from '../src/lib/alert-acknowledgement';
import { withSessionWrite } from '../src/lib/session-write';
import { createClientSessionToken } from '../src/lib/client-auth';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';
import { POST as reportAlert } from '../src/app/api/client/alerts/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '33319');
assert.equal(database.pathname, '/proctor_alerts_qa');
const prefix = `ack-${randomUUID()}`;
let examId = '';
const RealDate = Date;
let now = RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [now]); },
  get(target, property, receiver) { return property === 'now' ? () => now : Reflect.get(target, property, receiver); }
});
type Fixture = { id: string; candidateId: string; deviceId: string; token: string };
async function fixture(label: string, candidateId?: string): Promise<Fixture> {
  if (!candidateId) candidateId = (await prisma.candidate.create({ data: {
    examId, examNumber: `${prefix}-${label}`, seatNo: label, password: 'qa-only',
    startedAt: new Date(now - 60_000), status: 'ONLINE_NORMAL'
  } })).id;
  const credentials = createClientSessionToken();
  const deviceId = `${prefix}-${label}`;
  const session = await prisma.clientSession.create({ data: {
    examId, candidateId, desktopDeviceId: deviceId, desktopTokenHash: credentials.tokenHash,
    status: 'IN_EXAM', createdAt: new Date(now - 30_000), approvedAt: new Date(now - 30_000),
    startedAt: new Date(now - 60_000), lastDesktopSeenAt: new Date(now)
  } });
  return { id: session.id, candidateId, deviceId, token: credentials.token };
}
function request(f: Fixture, body: unknown) {
  return new Request('http://localhost/api/client/qa', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proctor-session-token': f.token }, body: JSON.stringify(body) });
}
async function accepted(response: Response) {
  const data = await response.json(); assert.ok(response.ok, JSON.stringify({ status: response.status, data })); return data.data;
}
const beat = (f: Fixture, system: object = {}) => heartbeat(request(f, { sessionId: f.id, deviceId: f.deviceId, side: 'DESKTOP', system })).then(accepted);
const direct = (f: Fixture, severity = 4) => reportAlert(request(f, { sessionId: f.id, type: 'PROCESS_POLICY',
  severity, message: '发现不允许的进程：fixture.exe', eventId: randomUUID(), occurredAt: new Date(now).toISOString() })).then(accepted);
const pending = (f: Fixture) => prisma.alert.findMany({ where: { candidateId: f.candidateId, acknowledgedAt: null } });
const candidate = (f: Fixture) => prisma.candidate.findUniqueOrThrow({ where: { id: f.candidateId } });

try {
  examId = (await prisma.exam.create({ data: {
    examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: prefix,
    startAt: new Date(now - 3_600_000), latestStartAt: new Date(now + 600_000), endAt: new Date(now + 3_600_000),
    durationMinutes: 120, platform: 'HYDRO', platformBaseUrl: 'http://127.0.0.1:1', platformContestId: prefix,
    contestType: 'INDIVIDUAL', rules: 'QA only', requireFrontCamera: false, requireMiniProgram: false
  } })).id;
  const f = await fixture('continuous');
  await beat(f, { processes: ['fixture.exe'], networkRemotes: ['outside.test'] });
  const initial = await pending(f); assert.equal(initial.length, 2);
  await acknowledgeAlert(initial[0]); assert.equal((await candidate(f)).abnormal, true);
  await acknowledgeAlert(initial[1]);
  assert.equal((await candidate(f)).abnormal, false);
  assert.equal((await candidate(f)).status, 'ONLINE_NORMAL');
  for (let i = 0; i < 15; i++) {
    now += 5_000;
    await beat(f, { processes: ['fixture.exe'], networkRemotes: ['outside.test'] });
    await direct(f);
  }
  assert.equal((await candidate(f)).abnormal, false, 'handled persistent episode stays normal through heartbeat/direct retries');
  assert.equal(await prisma.alert.count({ where: { candidateId: f.candidateId } }), 2);
  await direct(f, 5);
  assert.equal((await candidate(f)).abnormal, true, 'severity escalation restores abnormal');
  for (const row of await pending(f)) await acknowledgeAlert(row);
  for (let i = 0; i < 3; i++) { now += 5_000; await beat(f, { processes: [], networkRemotes: [] }); }
  now += 1_000; await beat(f, { processes: ['fixture.exe'] });
  assert.equal((await pending(f)).length, 1, 'real recovery then a new episode still creates an unhandled alert');
  assert.equal((await candidate(f)).abnormal, true);

  // Both transaction orderings must preserve a new alert on another session.
  for (let i = 0; i < 16; i++) {
    const previous = await fixture(`race-old-${i}`);
    await beat(previous, { networkRemotes: ['old.test'] });
    const oldAlert = (await pending(previous))[0];
    const current = await fixture(`race-new-${i}`, previous.candidateId);
    await Promise.all(i % 2
      ? [acknowledgeAlert(oldAlert), beat(current, { processes: ['new.exe'] })]
      : [beat(current, { processes: ['new.exe'] }), acknowledgeAlert(oldAlert)]);
    assert.equal((await pending(current)).length, 1);
    assert.equal((await candidate(current)).abnormal, true, `race ${i} cannot erase the new incident`);
    assert.equal((await candidate(current)).status, 'ONLINE_ABNORMAL');
  }

  // Gate a real locked session transaction after it reads the old candidate
  // snapshot, then let another session repair/create an incident before it
  // resumes. This catches both directions of a lost candidate-state update.
  for (const mode of ['new-alert', 'new-lock', 'old-healthy', 'new-offline'] as const) {
    const first = await fixture(`interleave-a-${mode}`);
    const second = await fixture(`interleave-b-${mode}`, first.candidateId);
    if (mode === 'new-lock') {
      await beat(second, { peripheralScanOk: false });
      for (const row of await pending(second)) await acknowledgeAlert(row);
      await prisma.clientSession.update({ where: { id: second.id }, data: { lockdown: false, lockdownReason: null, status: 'IN_EXAM' } });
    }
    await prisma.candidate.update({ where: { id: first.candidateId }, data: {
      abnormal: mode === 'new-alert' || mode === 'new-lock', status: mode === 'new-alert' || mode === 'new-lock' ? 'ONLINE_ABNORMAL' : 'APPROVED'
    } });
    let release!: () => void, announce!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalTransaction = prisma.$transaction;
    const transaction = originalTransaction.bind(prisma) as <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options?: object) => Promise<T>;
    let held: Promise<unknown> | undefined;
    try {
      prisma.$transaction = (async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => transaction(async tx => operation(new Proxy(tx, {
        get(target, key) {
          if (key === 'clientSession') return new Proxy(target.clientSession, { get(model, method) {
            if (method === 'findUnique') return async (args: Prisma.ClientSessionFindUniqueArgs) => {
              const row = await model.findUnique(args);
              if (args.where.id === second.id) { announce(); await gate; }
              return row;
            };
            return Reflect.get(model, method);
          } });
          return Reflect.get(target, key);
        }
      })), options)) as typeof originalTransaction;
      held = beat(second, mode === 'new-alert' || mode === 'new-offline' ? { processes: ['race.exe'] } : mode === 'new-lock' ? { peripheralScanOk: false } : {});
      await Promise.race([entered, held.then(() => { throw new Error('heartbeat completed before the test gate'); })]);
      if (mode === 'new-offline') await withSessionWrite(first.id, async tx => {
        await tx.clientSession.update({ where: { id: first.id }, data: { status: 'OFFLINE', desktopOfflineAt: new Date(now), lastDesktopSeenAt: new Date(now - 30_000) } });
        await tx.candidate.update({ where: { id: first.candidateId }, data: { abnormal: true, status: 'OFFLINE' } });
      });
      else await beat(first, mode === 'old-healthy' ? { processes: ['newer.exe'] } : {});
      assert.equal((await candidate(first)).abnormal, mode === 'old-healthy' || mode === 'new-offline');
      release(); await held;
      assert.equal((await candidate(first)).abnormal, true, mode);
      assert.equal((await candidate(first)).status, mode === 'new-offline' ? 'OFFLINE' : 'ONLINE_ABNORMAL', mode);
      assert.equal((await pending(first)).length, mode === 'new-lock' ? 0 : 1, mode);
      if (mode === 'new-lock') assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: second.id } })).lockdown, true);
      if (mode === 'new-offline') {
        await beat(second, {}); // first bounded recheck sees the other offline session
        await beat(second, { networkRemotes: ['new-offline-incident.test'] });
        assert.equal((await candidate(first)).status, 'OFFLINE', 'a new incident on an online session preserves an already-offline candidate');
        await beat(second, {}); // falls inside the recheck interval, so uses the fast transition branch
        assert.equal((await candidate(first)).status, 'OFFLINE', 'normal repeated heartbeats cannot clear another session offline state');
      }
    } finally {
      release(); await held?.catch(() => {});
      prisma.$transaction = originalTransaction;
    }
  }

  const locked = await fixture('locked');
  await beat(locked, { peripheralScanOk: false });
  for (const row of await pending(locked)) await acknowledgeAlert(row);
  assert.equal((await candidate(locked)).abnormal, true);
  assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: locked.id } })).lockdown, true);
  await beat(locked, { peripheralScanOk: true });
  assert.equal((await candidate(locked)).abnormal, true, 'scanner recovery alone does not remove a USB lock');
  await withSessionWrite(locked.id, async tx => {
    await tx.clientSession.update({ where: { id: locked.id }, data: { lockdown: false, lockdownReason: null, status: 'IN_EXAM' } });
    await refreshCandidateAlertStatus(tx, locked.candidateId);
  });
  assert.equal((await candidate(locked)).status, 'ONLINE_NORMAL', 'explicit unlock after ack clears the physical safety flag');
  assert.equal((await candidate(locked)).abnormal, false);
  const offline = await fixture('offline');
  await beat(offline, { processes: ['fixture.exe'] });
  await prisma.clientSession.update({ where: { id: offline.id }, data: { status: 'OFFLINE', desktopOfflineAt: new Date(now), lastDesktopSeenAt: new Date(now - 30_000) } });
  for (const row of await pending(offline)) await acknowledgeAlert(row);
  assert.equal((await candidate(offline)).status, 'OFFLINE');
  assert.equal((await candidate(offline)).abnormal, true);
  await beat(offline, { processes: ['fixture.exe'] });
  assert.equal((await candidate(offline)).status, 'ONLINE_NORMAL', 'desktop reconnect after ack restores normal even if handled episode persists');
  assert.equal((await candidate(offline)).abnormal, false);

  const mobile = await fixture('mobile');
  await prisma.examRoom.create({ data: { examId, name: `${prefix}-mobile`, requireSecondCamera: true,
    candidates: { create: { candidateId: mobile.candidateId } } } });
  await beat(mobile, { processes: ['fixture.exe'] });
  const mobileToken = createClientSessionToken();
  await prisma.clientSession.update({ where: { id: mobile.id }, data: {
    miniProgramDeviceId: 'mobile-device', miniProgramTokenHash: mobileToken.tokenHash,
    miniProgramOfflineAt: new Date(now), lastMiniProgramSeenAt: new Date(now - 30_000)
  } });
  for (const row of await pending(mobile)) await acknowledgeAlert(row);
  assert.equal((await candidate(mobile)).abnormal, true);
  await heartbeat(new Request('http://localhost/api/client/heartbeat', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proctor-session-token': mobileToken.token },
    body: JSON.stringify({ sessionId: mobile.id, deviceId: 'mobile-device', side: 'MINIPROGRAM' })
  })).then(accepted);
  assert.equal((await candidate(mobile)).abnormal, false, 'second-camera reconnect after ack restores normal');
  assert.equal((await candidate(mobile)).status, 'ONLINE_NORMAL');

  const historical = await fixture('historical');
  await beat(historical, { processes: ['fixture.exe'] });
  await prisma.alert.updateMany({ where: { candidateId: historical.candidateId }, data: { acknowledgedAt: new Date(now) } });
  assert.equal((await candidate(historical)).abnormal, true);
  await beat(historical, { processes: ['fixture.exe'] });
  assert.equal((await candidate(historical)).abnormal, false, 'legacy ack with sticky abnormal state is repaired despite continuing handled observations');
  assert.equal((await candidate(historical)).status, 'ONLINE_NORMAL');
  const finished = await fixture('finished');
  await beat(finished, { processes: ['fixture.exe'] });
  await prisma.clientSession.update({ where: { id: finished.id }, data: { status: 'FINISHED', endedAt: new Date(now) } });
  await prisma.candidate.update({ where: { id: finished.candidateId }, data: { status: 'FINISHED' } });
  for (const row of await pending(finished)) await acknowledgeAlert(row);
  assert.equal((await candidate(finished)).status, 'FINISHED');
  assert.equal((await candidate(finished)).abnormal, false);
  console.log(JSON.stringify({ repeatedHeartbeats: 15, repeatedDirectReports: 15, crossSessionRaces: 16, controlledInterleavings: 4,
    verified: ['last acknowledgement restores normal', 'remaining alerts preserve abnormal', 'new episodes and escalations restore abnormal', 'USB locks, offline and finished states remain protected', 'ack before reconnect or unlock returns to normal after recovery', 'legacy handled episodes repair sticky status'] }));
} finally {
  globalThis.Date = RealDate;
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.$disconnect();
}
