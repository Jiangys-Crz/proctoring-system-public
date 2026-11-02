// Uses only a disposable exam/session and synthetic media metadata, never files.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { withSessionWrite } from '../src/lib/session-write';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';
import { POST as reportAlert } from '../src/app/api/client/alerts/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/proctor_[a-z_]*qa$/);
const prefix = `peripheral-${randomUUID()}`;
const baseline = `usb-v5:${'a'.repeat(64)}`;
const upgraded = `usb-v6:${'b'.repeat(64)}`;
const changed = `usb-v6:${'c'.repeat(64)}`;
const desktop = createClientSessionToken(), mobile = createClientSessionToken();
let examId = '';
try {
  const now = Date.now();
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: prefix,
    startAt: new Date(now - 60_000), latestStartAt: new Date(now + 600_000), endAt: new Date(now + 3_600_000),
    durationMinutes: 60, platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: prefix,
    contestType: 'INDIVIDUAL', rules: 'Synthetic USB regression test',
    requireMiniProgram: false, requireFrontCamera: false, saveIncidentRecording: true
  } });
  examId = exam.id;
  const candidate = await prisma.candidate.create({ data: { examId, examNumber: prefix, password: prefix, seatNo: 'QA', startedAt: new Date(now - 30_000) } });
  const session = await prisma.clientSession.create({ data: {
    examId, candidateId: candidate.id, desktopDeviceId: prefix, status: 'IN_EXAM', startedAt: candidate.startedAt,
    desktopTokenHash: desktop.tokenHash, miniProgramTokenHash: mobile.tokenHash,
    peripheralsBaselineFingerprint: baseline, lastPeripheralsFingerprint: baseline, lastDesktopSeenAt: new Date()
  } });
  const request = (body: unknown, token = desktop.token) => new Request('http://localhost/api/client/test', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': token }, body: JSON.stringify(body)
  });
  const beat = (fingerprint: string) => heartbeat(request({ sessionId: session.id, deviceId: prefix, side: 'DESKTOP', system: { peripheralsFingerprint: fingerprint } }));
  const legacyReport = (token = desktop.token) => reportAlert(request({ sessionId: session.id, type: 'PERIPHERAL_CHANGED',
    message: '检测到外设接入或移除', eventId: prefix, occurredAt: new Date().toISOString() }, token));

  const migrations = await Promise.all(Array.from({ length: 30 }, (_, index) => index % 2 ? legacyReport() : beat(upgraded)));
  assert.ok(migrations.every(response => response.status === 200));
  let current = await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal(current.lockdown, false);
  assert.equal(current.peripheralsBaselineFingerprint, upgraded);
  assert.equal(current.lastPeripheralsFingerprint, upgraded);
  assert.equal(await prisma.alert.count({ where: { sessionId: session.id } }), 0);

  const objectPath = `${prefix}/synthetic-screen.webm`;
  await prisma.mediaSegment.create({ data: { examId, candidateId: candidate.id, sessionId: session.id, channel: 'DESKTOP_SCREEN',
    objectPath, startedAt: new Date(Date.now() - 1000), endedAt: new Date() } });
  const incidents = await Promise.all(Array.from({ length: 30 }, (_, index) => index % 2 ? legacyReport() : beat(changed)));
  assert.ok(incidents.every(response => response.status === 200));
  const alerts = await prisma.alert.findMany({ where: { sessionId: session.id } });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'PERIPHERAL_CHANGED');
  assert.equal(alerts[0].severity, 5);
  assert.equal(alerts[0].evidencePath, objectPath);
  const body = (await incidents[0].json()).data;
  assert.deepEqual(body.recordingEvents, [{ id: alerts[0].id, occurredAt: alerts[0].createdAt.toISOString(), channel: 'DESKTOP_SCREEN' }]);
  current = await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal(current.lockdown, true);
  assert.equal(current.status, 'LOCKED');
  assert.equal(current.peripheralsBaselineFingerprint, upgraded);
  assert.equal(current.lastPeripheralsFingerprint, changed);

  // Apply the admin unlock's persisted state while holding the same session lock.
  await withSessionWrite(session.id, async tx => {
    const locked = await tx.clientSession.findUniqueOrThrow({ where: { id: session.id } });
    await tx.clientSession.update({ where: { id: session.id }, data: { lockdown: false, lockdownReason: null, status: 'IN_EXAM',
      peripheralsBaselineFingerprint: locked.lastPeripheralsFingerprint, unlockNonce: randomUUID() } });
  });
  const retry = await legacyReport();
  assert.equal((await retry.json()).data.discarded, true);
  const unlocked = (await (await beat(changed)).json()).data.session;
  assert.equal(unlocked.lockdown, false);
  assert.equal(unlocked.peripheralsBaselineFingerprint, changed);
  assert.equal(await prisma.alert.count({ where: { sessionId: session.id } }), 1);
  assert.equal((await legacyReport(mobile.token)).status, 403);
  assert.equal((await legacyReport('invalid-token')).status, 401);
  console.log('PASS: 30 concurrent migration/direct reports, 30 concurrent real-change reports, one evidence event, unlock retry, and current desktop authorization.');
} finally {
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.$disconnect();
}
