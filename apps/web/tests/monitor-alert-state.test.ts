import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Alert, AlertType, Prisma } from '@prisma/client';
import { MonitorAlertState, monitoredCondition, USB_SCAN_FAILURE_MESSAGE } from '../src/lib/monitor-alert-state';

function store() {
  const rows: Alert[] = [];
  const reads = { alerts: 0, evidence: 0 };
  const tx = {
    alert: {
      findFirst: async ({ where }: { where: { id?: string; sessionId?: string } }) => {
        reads.alerts++;
        return rows.find(row => row.id === where.id && (!where.sessionId || row.sessionId === where.sessionId)) || null;
      },
      create: async ({ data }: { data: Prisma.AlertUncheckedCreateInput }) => {
        const row = { id: `alert-${rows.length}`, createdAt: new Date(), ...data } as Alert;
        rows.push(row); return row;
      }
    }
  } as unknown as Prisma.TransactionClient;
  const evidence = async () => { reads.evidence++; return 'owned/evidence.webm'; };
  const data = (type: AlertType = 'PROCESS_POLICY', severity = 4) => ({
    examId: 'exam', candidateId: 'candidate', sessionId: 'session', type, severity, message: 'condition'
  });
  return { rows, reads, tx, evidence, data };
}

test('persistent conditions across 24 hours/reloads retain first evidence with no per-heartbeat alert or media reads', async () => {
  const { tx, data, evidence, rows, reads } = store();
  let state = new MonitorAlertState(null);
  const now = new Date('2026-10-11T00:00:00Z');
  await state.report(tx, data(), { now, evidence });
  assert.equal(rows[0].evidencePath, 'owned/evidence.webm');
  for (let i = 1; i <= 288; i++) {
    state = new MonitorAlertState(JSON.parse(JSON.stringify(state.toJson())));
    assert.equal((await state.report(tx, data(), { now: new Date(+now + i * 300_000), evidence })).created, false);
    assert.equal(state.changed, false);
  }
  assert.equal(rows.length, 1);
  assert.deepEqual(reads, { alerts: 0, evidence: 1 });
});

test('recovery requires ten seconds of explicit healthy observations and missing/abnormal observations interrupt it', async () => {
  const { tx, data, evidence, rows } = store();
  const state = new MonitorAlertState({});
  const at = (offset: number) => new Date(1_800_000_000_000 + offset);
  await state.report(tx, data(), { now: at(0), evidence });
  state.observe('PROCESS_POLICY', true, at(1_000));
  state.observe('PROCESS_POLICY', undefined, at(8_000));
  state.observe('PROCESS_POLICY', true, at(12_000));
  await state.report(tx, data(), { now: at(15_000), evidence });
  assert.equal(rows.length, 1);
  state.observe('PROCESS_POLICY', true, at(20_000));
  state.observe('PROCESS_POLICY', true, at(29_999));
  assert.equal((state.toJson().PROCESS_POLICY as { active: boolean }).active, true);
  state.observe('PROCESS_POLICY', true, at(30_000));
  await state.report(tx, data(), { now: at(31_000), evidence });
  assert.equal(rows.length, 2, 'a confirmed recovery permits a new episode inside the old five-minute cooldown');
});

test('merged event IDs and old occurrence timestamps stay idempotent after recovery without preventing healthy confirmation', async () => {
  const { tx, data, evidence, rows } = store();
  const state = new MonitorAlertState({});
  const at = (offset: number) => new Date(1_800_000_000_000 + offset);
  await state.report(tx, data(), { now: at(0), evidence });
  await state.report(tx, { ...data(), id: 'merged-report' }, { now: at(1_000), eventId: 'merged-report', occurredAt: at(0), evidence });
  state.observe('PROCESS_POLICY', true, at(2_000));
  for (let i = 0; i < 30; i++) {
    await state.report(tx, { ...data(), id: 'merged-report' }, { now: at(8_000), eventId: 'merged-report', occurredAt: at(0), evidence });
  }
  state.observe('PROCESS_POLICY', true, at(12_000));
  assert.equal((state.toJson().PROCESS_POLICY as { active: boolean }).active, false);
  await state.report(tx, { ...data(), id: 'merged-report' }, { now: at(13_000), eventId: 'merged-report', occurredAt: at(0), evidence });
  await state.report(tx, { ...data(), id: 'old-unseen' }, { now: at(13_000), eventId: 'old-unseen', occurredAt: at(1_000), evidence });
  assert.equal(rows.length, 1);
  await state.report(tx, { ...data(), id: 'new-report' }, { now: at(13_000), eventId: 'new-report', occurredAt: at(13_000), evidence });
  assert.equal(rows.length, 2);
  state.observe('PROCESS_POLICY', true, at(14_000));
  state.observe('PROCESS_POLICY', true, at(24_000));
  await state.report(tx, { ...data(), id: 'new-report' }, { now: at(30_000), eventId: 'new-report', occurredAt: at(13_000), evidence });
  assert.equal(rows.length, 2, 'persisted IDs remain idempotent across subsequent episodes');
});

test('new current direct reports interrupt recovery; delayed earlier reports do not', async () => {
  const { tx, data } = store();
  const state = new MonitorAlertState({});
  const at = (offset: number) => new Date(1_800_000_000_000 + offset);
  await state.report(tx, data(), { now: at(0) });
  state.observe('PROCESS_POLICY', true, at(1_000));
  await state.report(tx, { ...data(), id: 'new-current' }, { now: at(9_000), eventId: 'new-current', occurredAt: at(9_000) });
  state.observe('PROCESS_POLICY', true, at(11_000));
  assert.equal((state.toJson().PROCESS_POLICY as { active: boolean }).active, true);
  state.observe('PROCESS_POLICY', true, at(21_000));
  assert.equal((state.toJson().PROCESS_POLICY as { active: boolean }).active, false);
});

test('long silence, clock reversal and old persisted states cannot count as continuous recovery', async () => {
  const { tx, data, rows } = store();
  const at = (offset: number) => new Date(1_800_000_000_000 + offset);
  let state = new MonitorAlertState({});
  await state.report(tx, data(), { now: at(0) });
  state.observe('PROCESS_POLICY', true, at(1_000));
  state = new MonitorAlertState(state.toJson());
  state.observe('PROCESS_POLICY', true, at(60_000));
  assert.equal((state.toJson().PROCESS_POLICY as { active: boolean }).active, true);
  await state.report(tx, data(), { now: at(60_001) });
  assert.equal(rows.length, 1, 'a reconnect cannot create a fresh episode from a missing observation interval');
  state.observe('PROCESS_POLICY', true, at(70_000));
  state.observe('PROCESS_POLICY', true, at(69_000));
  assert.equal((state.toJson().PROCESS_POLICY as { healthySince: number }).healthySince, +at(69_000));
  const old = JSON.parse(JSON.stringify(state.toJson()));
  delete old.PROCESS_POLICY.lastHealthyAt;
  state = new MonitorAlertState(old);
  state.observe('PROCESS_POLICY', true, at(90_000));
  assert.equal((state.toJson().PROCESS_POLICY as { active: boolean }).active, true);
  state.observe('PROCESS_POLICY', true, at(95_000));
  state.observe('PROCESS_POLICY', true, at(100_000));
  assert.equal((state.toJson().PROCESS_POLICY as { active: boolean }).active, false);
});

test('severity escalation and independent types retain evidence; late escalation remains historical', async () => {
  const { tx, data, evidence, rows, reads } = store();
  const state = new MonitorAlertState({});
  const at = (offset: number) => new Date(1_800_000_000_000 + offset);
  await state.report(tx, data(), { now: at(0), evidence });
  await state.report(tx, data('VIRTUAL_MACHINE', 3), { now: at(0), evidence });
  state.observe('PROCESS_POLICY', true, at(1_000));
  state.observe('PROCESS_POLICY', true, at(11_000));
  await state.report(tx, { ...data('PROCESS_POLICY', 5), id: 'late-high' }, { now: at(12_000), eventId: 'late-high', occurredAt: at(500), evidence });
  assert.equal(rows.length, 3);
  assert.equal((state.toJson().PROCESS_POLICY as { active: boolean }).active, false);
  await state.report(tx, data(), { now: at(15_000), evidence });
  await state.report(tx, data('PROCESS_POLICY', 5), { now: at(16_000), evidence });
  await state.report(tx, data('PROCESS_POLICY', 5), { now: at(17_000), evidence });
  assert.equal(rows.length, 5);
  assert.equal(reads.evidence, 5);
});

test('bounded state accepts only known conditions and retains at most 32 merged IDs per type', async () => {
  const { tx, data } = store();
  const state = new MonitorAlertState({ invented: { active: true, alertId: 'no', severity: 4 } });
  for (let i = 0; i < 100; i++) await state.report(tx, { ...data(), id: `event-${i}` }, { now: new Date(), eventId: `event-${i}` });
  assert.deepEqual(Object.keys(state.toJson()), ['PROCESS_POLICY']);
  assert.equal((state.toJson().PROCESS_POLICY as { eventIds: string[] }).eventIds.length, 32);
});

test('unobservable recorder failures and network diagnostics remain independent of healthy capture/network heartbeats', () => {
  assert.equal(monitoredCondition('SCREEN_CAPTURE_LOST', '监考录像编码或保存失败'), undefined);
  assert.equal(monitoredCondition('MOBILE_CAMERA_LOST', '第二机位录像本地暂存失败，正在尝试直接补传'), undefined);
  assert.equal(monitoredCondition('NETWORK_POLICY', '整机域名检测状态：扫描失败'), undefined);
  assert.equal(monitoredCondition('NETWORK_POLICY', '内置浏览器尝试访问非考试范围页面：example.test'), undefined);
  assert.equal(monitoredCondition('NETWORK_POLICY', '发现外部域名活动：example.test'), 'NETWORK_POLICY');
  assert.equal(monitoredCondition('SCREEN_CAPTURE_LOST', '电脑屏幕采集被停止'), 'SCREEN_CAPTURE_LOST');
});

test('USB scanner failure has its own recoverable condition and does not absorb real device changes', async () => {
  const { tx, data, rows, evidence, reads } = store();
  let state = new MonitorAlertState({});
  const at = (offset: number) => new Date(1_800_000_000_000 + offset);
  const report = { ...data('PERIPHERAL_CHANGED', 5), message: USB_SCAN_FAILURE_MESSAGE };
  assert.equal(monitoredCondition(report.type, report.message), 'USB_SCAN_FAILED');
  assert.equal(monitoredCondition('PERIPHERAL_CHANGED', '检测到外设接入或移除'), undefined);
  await state.report(tx, report, { now: at(0), evidence });
  for (let i = 1; i <= 100; i++) {
    state = new MonitorAlertState(state.toJson());
    await state.report(tx, report, { now: at(i * 1_000), evidence });
  }
  assert.equal(rows.length, 1);
  assert.equal(reads.evidence, 1);
  state.observe('USB_SCAN_FAILED', true, at(101_000));
  state.observe('USB_SCAN_FAILED', undefined, at(105_000));
  state.observe('USB_SCAN_FAILED', true, at(110_000));
  state.observe('USB_SCAN_FAILED', true, at(120_000));
  await state.report(tx, report, { now: at(121_000), evidence });
  assert.equal(rows.length, 2);
});
