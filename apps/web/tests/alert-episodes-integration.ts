// Real MySQL/session-lock regression. Time advances only in this test process;
// no waiting, external services, global settings, or real media files are used.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createClientSessionToken, publicClientSession } from '../src/lib/client-auth';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';
import { POST as reportAlert } from '../src/app/api/client/alerts/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_performance_qa');
const prefix = `alert-episodes-${randomUUID()}`;
const RealDate = Date;
let now = RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [now]); },
  get(target, property, receiver) { return property === 'now' ? () => now : Reflect.get(target, property, receiver); }
});
let examId = '';
const metrics: Record<string, unknown> = {};

type Fixture = { id: string; deviceId: string; token: string; candidateId: string };
async function fixture(label: string): Promise<Fixture> {
  const candidate = await prisma.candidate.create({ data: {
    examId, examNumber: `${prefix}-${label}`, password: 'qa-only', seatNo: label, startedAt: new Date(now - 30_000)
  } });
  const credentials = createClientSessionToken();
  const deviceId = `${prefix}-${label}`;
  const session = await prisma.clientSession.create({ data: {
    examId, candidateId: candidate.id, desktopDeviceId: deviceId, desktopTokenHash: credentials.tokenHash,
    status: 'IN_EXAM', createdAt: new Date(now - 60_000), startedAt: candidate.startedAt, lastDesktopSeenAt: new Date(now),
    peripheralsBaselineFingerprint: `usb-v3:${'a'.repeat(64)}`, lastPeripheralsFingerprint: `usb-v3:${'a'.repeat(64)}`
  } });
  return { id: session.id, candidateId: candidate.id, deviceId, token: credentials.token };
}
function request(f: Fixture, body: unknown) {
  return new Request('http://localhost/api/client/integration', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': f.token }, body: JSON.stringify(body)
  });
}
async function body(response: Response) {
  const json = await response.json();
  assert.ok(response.status === 200 || response.status === 201, JSON.stringify({ status: response.status, json }));
  return json.data;
}
function beat(f: Fixture, system: Record<string, unknown> = {}, capture?: Record<string, boolean>) {
  return heartbeat(request(f, { sessionId: f.id, deviceId: f.deviceId, side: 'DESKTOP', system, capture }));
}
function direct(f: Fixture, type: string, message: string, eventId: string, occurredAt = now, severity = 4) {
  return reportAlert(request(f, { sessionId: f.id, type, message, severity, eventId, occurredAt: new Date(occurredAt).toISOString() }));
}
const count = (f: Fixture, type?: string) => prisma.alert.count({ where: { sessionId: f.id, ...(type ? { type: type as never } : {}) } });
function checkPublicSession(session: Record<string, unknown>) {
  for (const field of ['monitoringAlertState', 'desktopTokenHash', 'miniProgramTokenHash']) assert.equal(field in session, false, `${field} must stay private`);
}

try {
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: prefix,
    startAt: new Date(now - 60_000), latestStartAt: new Date(now + 600_000), endAt: new Date(now + 3600_000),
    durationMinutes: 60, platform: 'HYDRO', platformBaseUrl: 'http://127.0.0.1:1', platformContestId: prefix,
    contestType: 'INDIVIDUAL', rules: 'Synthetic alert episode regression', requireMiniProgram: false,
    requireFrontCamera: false, saveIncidentRecording: true
  } });
  examId = exam.id;
  const f = await fixture('process');
  const objectPath = `${prefix}/synthetic-screen.webm`;
  await prisma.mediaSegment.create({ data: {
    examId, sessionId: f.id, candidateId: f.candidateId, channel: 'DESKTOP_SCREEN', objectPath,
    startedAt: new Date(now - 1000), endedAt: new Date(now)
  } });
  const firstAt = now;
  const started = performance.now();
  const concurrent = await Promise.all(Array.from({ length: 30 }, (_, index) => index % 2
    ? direct(f, 'PROCESS_POLICY', '发现新启动或仍在运行的非白名单进程：b.exe、a.exe', `first-${index}`)
    : beat(f, { processes: index % 4 ? ['a.exe', 'b.exe'] : ['b.exe', 'a.exe'] })));
  for (const response of concurrent) {
    const data = await body(response);
    if (data.session) checkPublicSession(data.session);
  }
  assert.equal(await count(f), 1, '30 simultaneous heartbeat/direct writers must create one durable incident');
  const initial = await prisma.alert.findFirstOrThrow({ where: { sessionId: f.id } });
  assert.equal(initial.evidencePath, objectPath);
  metrics.concurrentWriters = 30;
  metrics.concurrentMs = Math.round(performance.now() - started);
  metrics.firstIncidentAlerts = await count(f);

  // The peer sees every normal heartbeat; a five-minute jump with no heartbeat
  // would instead exercise the unrelated fully-offline revocation policy.
  for (let index = 0; index < 66; index++) {
    now += 5000;
    await body(await beat(f, { processes: index % 2 ? ['a.exe', 'b.exe'] : ['b.exe', 'a.exe'] }));
  }
  await body(await direct(f, 'PROCESS_POLICY', '发现不允许的进程：a.exe、b.exe', 'legacy-repeat'));
  assert.equal(await count(f), 1, 'continuous abnormal state does not reset after the old five-minute cooldown');
  metrics.continuousSeconds = (now - firstAt) / 1000;

  // One healthy sample and an unknown result must not establish recovery.
  await body(await beat(f, { processes: [] }));
  now += 5000;
  await body(await beat(f));
  now += 5000;
  await body(await beat(f, { processes: ['a.exe', 'b.exe'] }));
  assert.equal(await count(f), 1);
  await body(await beat(f, { processes: [] }));
  now += 5000;
  await body(await beat(f, { processes: [] }));
  const stateBeforeRecovery = await prisma.clientSession.findUniqueOrThrow({ where: { id: f.id } });
  assert.equal((stateBeforeRecovery.monitoringAlertState as any).PROCESS_POLICY.active, true);
  now += 5000;
  await body(await beat(f, { processes: [] }));
  const recovered = await prisma.clientSession.findUniqueOrThrow({ where: { id: f.id } });
  assert.equal((recovered.monitoringAlertState as any).PROCESS_POLICY.active, false);
  checkPublicSession(publicClientSession(recovered));
  const recoveredAt = now;

  // Both a retry of an old ID and a previously unseen, delayed old event must
  // stay within the recovered incident rather than creating a fresh one.
  for (const eventId of ['first-1', 'old-offline-new-id']) {
    await body(await direct(f, 'PROCESS_POLICY', '发现不允许的进程：a.exe、b.exe', eventId, firstAt));
  }
  assert.equal(await count(f), 1);
  now += 1000;
  await body(await direct(f, 'PROCESS_POLICY', '发现不允许的进程：a.exe、b.exe', 'new-after-recovery'));
  await body(await beat(f, { processes: ['a.exe', 'b.exe'] }));
  assert.equal(await count(f), 2, 'confirmed recovery permits a new incident inside the ordinary cooldown');
  await body(await direct(f, 'PROCESS_POLICY', '发现不允许的进程：a.exe、b.exe', 'new-after-recovery'));
  await body(await direct(f, 'PROCESS_POLICY', '发现不允许的进程：a.exe、b.exe', 'first-1', firstAt));
  assert.equal(await count(f), 2, 'retries cannot duplicate either incident');
  metrics.recoveryMilliseconds = recoveredAt - ((stateBeforeRecovery.monitoringAlertState as any).PROCESS_POLICY.healthySince);

  await body(await direct(f, 'PROCESS_POLICY', '发现严重进程异常', 'severity-escalation', now, 5));
  assert.equal(await count(f), 3, 'severity escalation must remain visible during a continuous incident');
  await body(await beat(f, { processes: ['a.exe', 'b.exe'] }));
  assert.equal(await count(f), 3);

  const other = await fixture('other-conditions');
  await prisma.exam.update({ where: { id: examId }, data: { requireFrontCamera: true } });
  await body(await beat(other, { networkRemotes: ['outside.test'], vmSignals: ['hypervisor'] }, { screenOk: false, desktopCameraOk: false }));
  assert.equal(await count(other), 4);
  for (let index = 0; index < 62; index++) {
    now += 5000;
    await body(await beat(other, { networkRemotes: ['outside.test'], vmSignals: ['hypervisor'] }, { screenOk: false, desktopCameraOk: false }));
  }
  assert.equal(await count(other), 4, 'network, VM, screen, and camera conditions also stay deduplicated beyond five minutes');
  await body(await direct(other, 'NETWORK_POLICY', '整机域名检测状态：检测暂不可用', 'scanner-diagnostic'));
  await body(await direct(other, 'NETWORK_POLICY', '内置浏览器尝试访问非考试范围页面：https://outside.test', 'navigation-attempt'));
  assert.equal(await count(other, 'NETWORK_POLICY'), 3, 'scanner diagnostics and navigation are distinct from remote-activity episodes');

  const usb = await fixture('usb');
  for (const char of ['b', 'c']) {
    const data = await body(await beat(usb, { peripheralsFingerprint: `usb-v3:${char.repeat(64)}` }));
    assert.equal(data.session.lockdown, true);
    checkPublicSession(data.session);
  }
  assert.equal(await count(usb, 'PERIPHERAL_CHANGED'), 2, 'two confirmed USB changes inside five minutes must not be collapsed');
  const usbState = await prisma.clientSession.findUniqueOrThrow({ where: { id: usb.id } });
  assert.equal(usbState.lastPeripheralsFingerprint, `usb-v3:${'c'.repeat(64)}`);
  metrics.otherContinuousConditions = 4;
  metrics.usbChanges = 2;
  console.log(JSON.stringify(metrics));
  console.log('PASS: real MySQL concurrency, long-lived episodes, explicit recovery, late event retries, severity/USB escalation, independent network diagnostics, evidence, and private session state.');
} finally {
  globalThis.Date = RealDate;
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.$disconnect();
}
