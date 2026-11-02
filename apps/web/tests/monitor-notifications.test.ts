import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupMonitorAlerts, type GroupableMonitorAlert } from '../src/components/monitor-alerts';
import { createMonitorPoller } from '../src/components/monitor-polling';

const event = (id: string, seconds: number, extra: Partial<GroupableMonitorAlert> = {}): GroupableMonitorAlert => ({
  id, candidate: { id: 'candidate-a' }, sessionId: 'session-a', type: 'PROCESS_POLICY', message: '禁止的进程', severity: 3,
  createdAt: new Date(1_000_000 + seconds * 1000).toISOString(), acknowledgedAt: null, ...extra,
});

test('short identical bursts collapse while preserving every record and fixed five-minute windows', () => {
  const alerts = [event('old', 0), event('middle', 290), event('new', 580), event('latest', 600)];
  const groups = groupMonitorAlerts(alerts);
  assert.deepEqual(groups.map(group => group.alerts.map(alert => alert.id)), [['latest', 'new'], ['middle', 'old']]);
  assert.deepEqual(alerts.map(alert => alert.id), ['old', 'middle', 'new', 'latest'], 'input remains unchanged');
  assert.equal(groups.flatMap(group => group.alerts).length, alerts.length);
});

test('different people, sessions, severity, text, status and system notices never hide behind a group', () => {
  const alerts = [event('a', 100), event('b', 99),
    event('candidate', 98, { candidate: { id: 'candidate-b' } }), event('session', 97, { sessionId: 'session-b' }),
    event('severity', 96, { severity: 5 }), event('message', 95, { message: '禁止的另一个进程' }),
    event('handled', 94, { acknowledgedAt: new Date().toISOString() }), event('type', 93, { type: 'NETWORK_POLICY' }),
    event('system-a', 92, { candidate: null }), event('system-b', 91, { candidate: null })];
  const groups = groupMonitorAlerts(alerts);
  assert.equal(groups.length, 9);
  assert.deepEqual(groups[0].alerts.map(alert => alert.id), ['a', 'b']);
  assert.ok(groups.slice(1).every(group => group.alerts.length === 1));
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('slow reads never overlap and concurrent action refreshes coalesce into one fresh read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, active = 0, maxActive = 0;
  const releases: Array<() => void> = [];
  const poller = createMonitorPoller(async () => {
    calls++; active++; maxActive = Math.max(active, maxActive);
    await new Promise<void>(resolve => releases.push(resolve)); active--;
  }, { intervalMs: 2000, timeoutMs: 60_000 });
  try {
    const initial = poller.refresh(); await flush();
    t.mock.timers.tick(20_000); await flush(); assert.equal(calls, 1);
    const action = poller.refresh(); const another = poller.refresh();
    assert.equal(initial, action); assert.equal(action, another);
    releases.shift()!(); await flush(); assert.equal(calls, 2);
    releases.shift()!(); await initial;
    assert.equal(maxActive, 1);
    t.mock.timers.tick(1999); await flush(); assert.equal(calls, 2);
    t.mock.timers.tick(1); await flush(); assert.equal(calls, 3);
    releases.shift()!(); await flush();
  } finally { poller.stop(); }
});

test('hidden pages cancel reads and pause traffic; resuming refreshes immediately; stop cannot restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const poller = createMonitorPoller(signal => {
    signals.push(signal);
    return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  }, { intervalMs: 2000 });
  void poller.refresh(); await flush();
  poller.setVisible(false); await flush();
  assert.equal(signals[0].aborted, true);
  t.mock.timers.tick(60_000); await poller.refresh(); assert.equal(signals.length, 1);
  poller.setVisible(true); await flush(); assert.equal(signals.length, 2);
  poller.stop(); await flush(); assert.equal(signals[1].aborted, true);
  t.mock.timers.tick(60_000); await poller.refresh(); assert.equal(signals.length, 2);
});

test('an action refresh invalidates the old response before it can restore a handled alert', async () => {
  let displayed = 'pending';
  const reads: Array<{ signal: AbortSignal; resolve: (value: string) => void }> = [];
  const poller = createMonitorPoller(async signal => {
    const value = await new Promise<string>(resolve => reads.push({ signal, resolve }));
    if (!signal.aborted) displayed = value;
  }, { intervalMs: 2000 });
  try {
    void poller.refresh(); await flush();
    displayed = 'handled';
    const action = poller.refresh();
    assert.equal(reads[0].signal.aborted, true);
    reads[0].resolve('pending'); await flush();
    assert.equal(displayed, 'handled');
    reads[1].resolve('handled'); await action;
    assert.equal(displayed, 'handled');
  } finally { poller.stop(); }
});

test('deadline aborts stalled fetches and the next scheduled poll recovers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const poller = createMonitorPoller(signal => {
    signals.push(signal);
    return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  }, { intervalMs: 2000, timeoutMs: 10_000 });
  void poller.refresh(); await flush();
  t.mock.timers.tick(10_000); await flush();
  assert.equal(signals[0].reason.name, 'TimeoutError');
  t.mock.timers.tick(2000); await flush(); assert.equal(signals.length, 2);
  poller.stop(); await flush();
});
