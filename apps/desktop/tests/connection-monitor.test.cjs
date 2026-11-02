const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness() {
  let elapsed = 0;
  const events = [], context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/connection-monitor.js'), 'utf8'), context);
  const monitor = context.createExamConnectionMonitor({ now: () => elapsed, changed: value => events.push(value) });
  return { monitor, events, advance: ms => { elapsed += ms; return monitor.tick(); } };
}
test('an explicit network failure warns at exactly 15 seconds, and a short interruption does not warn', () => {
  const h = harness(); h.monitor.start(); h.monitor.connected(); h.monitor.disconnected();
  assert.equal(h.advance(14999).warning, false);
  assert.equal(h.advance(1).warning, true);
  assert.equal(h.monitor.snapshot().offlineSeconds, 15);
  h.monitor.connected(); assert.equal(h.monitor.snapshot().warning, false);
  assert.equal(h.monitor.snapshot().phase, 'connected');
  h.monitor.disconnected(); h.advance(5000); h.monitor.connected();
  assert.equal(h.monitor.snapshot().warning, false);
});
test('stalled heartbeat responses trigger a warning without waiting for a pending request to time out', () => {
  const h = harness(); h.monitor.start(); h.monitor.connected();
  h.advance(5000); h.monitor.connected();
  assert.equal(h.advance(14999).phase, 'connected');
  assert.equal(h.advance(1).warning, true);
  assert.equal(h.monitor.snapshot().phase, 'offline');
});
test('acknowledging a warning keeps retries active, and a later separate outage can warn again', () => {
  const h = harness(); h.monitor.start(); h.monitor.disconnected(); h.advance(15000);
  h.monitor.dismiss(); assert.equal(h.advance(30000).warning, false);
  assert.equal(h.monitor.snapshot().active, true); assert.equal(h.monitor.snapshot().phase, 'offline');
  h.monitor.connected(); h.monitor.disconnected();
  assert.equal(h.advance(15000).warning, true);
});
test('ending or revoking an exam hides both status and warning, and late responses cannot reactivate them', () => {
  const h = harness(); h.monitor.start(); h.monitor.disconnected(); h.advance(15000);
  h.monitor.stop(); h.monitor.connected(); h.monitor.disconnected();
  const status = h.advance(60000); assert.equal(status.active, false); assert.equal(status.warning, false);
  h.monitor.start(); assert.equal(h.monitor.snapshot().active, true); assert.equal(h.monitor.snapshot().warning, false);
});
