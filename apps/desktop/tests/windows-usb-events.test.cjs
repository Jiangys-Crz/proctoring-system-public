const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { WindowsUsbEvents, usbDeviceIdentity } = require('../dist/main/windows-usb-events');
const path = '\\\\?\\USB#VID_1234&PID_5678#SERIAL#{A5DCBF10-6530-11D2-901F-00C04FB951ED}';
const device = 'USB\\VID_1234&PID_5678\\SERIAL';
const other = 'USB\\VID_1234&PID_5678\\OTHER';
const fingerprint = ids => 'usb-v6:' + createHash('sha256').update(JSON.stringify(ids)).digest('hex');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function harness(initial = [], approved) {
  const children = [], timers = new Map(), diagnostics = [], promoted = [];
  let devices = initial, now = 0, nextTimer = 1, scans = 0, launchFailure = null;
  const monitor = new WindowsUsbEvents(() => '/trusted/inventory-probe.exe', async () => {
    scans++;
    const sample = typeof devices === 'function' ? await devices() : [...devices];
    return { devices: sample, observedAt: now };
  }, {
    now: () => now,
    schedule: (callback, ms) => { const id = nextTimer++; timers.set(id, { callback, at: now + ms }); return id; },
    cancel: id => timers.delete(id), diagnostic: value => diagnostics.push(value),
    confirmFingerprint: (hash, observedAt) => promoted.push({ hash, observedAt }),
    confirmedBaseline: hash => approved && fingerprint(approved) === hash ? approved : undefined,
    launch: (_file, args, options) => {
      assert.deepEqual(args, ['peripheral-events', String(process.pid)]);
      assert.equal(options.windowsHide, true);
      if (launchFailure) throw launchFailure;
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.killed = 0; child.kill = () => { child.killed++; return true; }; children.push(child); return child;
    }
  });
  const emit = (index, value) => children[index].stdout.write(JSON.stringify(value) + '\n');
  return {
    monitor, children, emit, diagnostics, promoted, set: value => { devices = value; }, get scans() { return scans; },
    setLaunchFailure: value => { launchFailure = value; },
    async start(session = 'session', baseline) { const ready = monitor.watch(session, baseline); emit(children.length - 1, { ready: true }); await ready; },
    async advance(ms = 1500) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = end; await flush();
    }
  };
}

test('physical USB interfaces share inventory identities across Win7 vendor buses and revision metadata', () => {
  assert.equal(usbDeviceIdentity(path), device);
  assert.equal(usbDeviceIdentity(path.toLowerCase()), device);
  assert.equal(usbDeviceIdentity(path.replace('PID_5678', 'PID_5678&REV_0100')), device);
  for (const bus of ['IUSB3', 'NUSB3', 'VENDORUSB3']) assert.equal(usbDeviceIdentity(path.replace('USB#', bus + '#')), device);
  for (const bus of ['HID', 'USBSTOR', 'SCSI', 'STORAGE', 'ROOT', 'HTREE', 'PCI', 'SWD']) assert.equal(usbDeviceIdentity(path.replace('USB#', bus + '#')), null);
  for (const bad of [path.replace('PID_5678', 'PID_5678&MI_00'), path.replace('VID_1234&PID_5678', 'ROOT_HUB30'), path.replace('A5DCBF10', '00000000'), 'garbage']) assert.equal(usbDeviceIdentity(bad), null);
});

test('duplicate notifications and a known-device driver reset do not lock a Win7 machine without a camera', async () => {
  const h = harness([device]); await h.start();
  h.emit(0, { action: 'INSERT', path }); h.emit(0, { action: 'INSERT', path });
  await h.advance(4500);
  assert.deepEqual(h.monitor.read('session').events, []);
  h.set([]); h.emit(0, { action: 'REMOVE', path }); await h.advance();
  h.set([device]); h.emit(0, { action: 'INSERT', path }); await h.advance(4500);
  assert.equal(h.monitor.read('session').available, true);
  assert.deepEqual(h.monitor.read('session').events, []); h.monitor.stop();
});

test('an interface can disappear while its physical PnP device remains present', async () => {
  const h = harness([device]); await h.start(); h.emit(0, { action: 'REMOVE', path }); await h.advance(6000);
  assert.equal(h.scans, 3, 'an early read plus delayed unchanged physical inventory stops verification polling');
  assert.deepEqual(h.monitor.read('session').events, []); h.monitor.stop();
});

test('an arrival during an in-flight inventory gets its own verification even if the older inventory matched', async () => {
  const h = harness(); await h.start();
  const inFlight = deferred(); h.set(() => inFlight.promise);
  h.emit(0, { action: 'REMOVE', path }); await h.advance();
  h.emit(0, { action: 'INSERT', path });
  h.set([device]); inFlight.resolve([]); await flush();
  assert.equal(h.monitor.read('session').available, true);
  assert.deepEqual(h.monitor.read('session').events, []);
  await h.advance(4500);
  assert.deepEqual(h.monitor.read('session').events.map(event => [event.action, event.deviceId]), [['INSERT', device]]);
  h.monitor.stop();
});

test('a departure arriving during inventory is checked in a later sample before emitting a brief pair', async () => {
  const h = harness(); await h.start();
  h.set([device]); h.emit(0, { action: 'INSERT', path }); await h.advance();
  const inFlight = deferred(); h.set(() => inFlight.promise); await h.advance();
  h.emit(0, { action: 'REMOVE', path });
  h.set([]); inFlight.resolve([]); await flush();
  assert.deepEqual(h.monitor.read('session').events, [], 'the earlier sample cannot confirm a later hint');
  await h.advance();
  assert.deepEqual(h.monitor.read('session').events.map(event => event.action), ['INSERT', 'REMOVE']);
  h.monitor.stop();
});

test('actual additions and removals require stable physical observations; duplicates create one transition', async () => {
  const h = harness(); await h.start(); h.set([device]);
  h.emit(0, { action: 'INSERT', path }); h.emit(0, { action: 'INSERT', path });
  await h.advance(3000); assert.equal(h.monitor.read('session').events.length, 0);
  await h.advance(250); assert.deepEqual(h.monitor.read('session').events.map(x => x.action), ['INSERT']);
  assert.equal(h.monitor.read('session').events[0].observedAgeMs, 3000, 'age starts at the first physical observation');
  h.set([]); h.emit(0, { action: 'REMOVE', path }); h.emit(0, { action: 'REMOVE', path }); await h.advance(4500);
  const events = h.monitor.read('session').events;
  assert.deepEqual(events.map(x => x.action), ['INSERT', 'REMOVE']);
  assert.deepEqual(events.map(x => x.inventoryFingerprint), [fingerprint([device]), fingerprint([])]);
  assert.match(h.diagnostics.join('\n'), /confirmed REMOVE USB/); h.monitor.stop();
});

test('simultaneous physical changes share the same ordered, confirmed inventory fingerprint', async () => {
  const h = harness(); await h.start();
  h.set([device, other]);
  h.emit(0, { action: 'INSERT', path }); await h.advance(3250);
  const events = h.monitor.read('session').events;
  assert.deepEqual(events.map(x => x.deviceId), [device, other]);
  assert.deepEqual(events.map(x => x.inventoryFingerprint), Array(2).fill(fingerprint([other, device])));
  assert.deepEqual(h.promoted, [{ hash: fingerprint([other, device]), observedAt: 3250 }]);
  h.monitor.stop();
});

test('an uncorroborated insert/remove interface pair never becomes a physical change', async () => {
  const h = harness([other]); await h.start();
  h.emit(0, { action: 'REMOVE', path }); assert.equal(h.monitor.read('session').events.length, 0, 'unknown removals are not short insertions');
  h.emit(0, { action: 'INSERT', path }); h.emit(0, { action: 'INSERT', path });
  h.emit(0, { action: 'REMOVE', path }); h.emit(0, { action: 'REMOVE', path });
  await h.advance(6000);
  assert.equal(h.monitor.read('session').available, true);
  assert.deepEqual(h.monitor.read('session').events, []);
  h.monitor.stop();
});

test('a brief insertion seen by the inventory and then removed stays queued until acknowledged', async () => {
  const h = harness([other]); await h.start();
  h.set([other, device]); h.emit(0, { action: 'INSERT', path }); await h.advance(400);
  assert.deepEqual(h.monitor.read('session').events, []);
  h.set([other]); h.emit(0, { action: 'REMOVE', path }); await h.advance(1350);
  const events = h.monitor.read('session').events;
  assert.deepEqual(events.map(x => x.action), ['INSERT', 'REMOVE']); assert.notEqual(events[0].id, events[1].id);
  assert.deepEqual(events.map(x => x.observedAgeMs), [1500, 0]);
  assert.equal(events.some(x => 'inventoryFingerprint' in x), false);
  assert.deepEqual(h.promoted, []);
  await h.advance(2000);
  assert.deepEqual(h.monitor.read('session').events.map(x => x.observedAgeMs), [3500, 2000]);
  h.monitor.acknowledge('other', [events[0].id]); assert.equal(h.monitor.read('session').events.length, 2);
  h.monitor.acknowledge('session', [events[0].id]); assert.equal(h.monitor.read('session').events.length, 1);
  assert.deepEqual(h.monitor.read('other').events, []); h.monitor.stop();
});

test('one watcher serves repeated starts and renderer recovery preserves unacknowledged events', async () => {
  const h = harness(), a = h.monitor.watch('session'), b = h.monitor.watch('session'); assert.equal(a, b);
  h.emit(0, { ready: true }); await a;
  h.set([device]); h.emit(0, { action: 'INSERT', path }); await h.advance(4500);
  const ids = h.monitor.read('session').events.map(x => x.id);
  assert.equal(ids.length, 1);
  h.monitor.stop(); await h.start(); assert.deepEqual(h.monitor.read('session').events.map(x => x.id), ids);
  await h.start('new-session'); assert.equal(h.monitor.read('new-session').events.length, 0); h.monitor.stop();
});

test('startup waits for inventory and reconciles initialization notifications against that baseline', async () => {
  const initial = deferred(), h = harness(() => initial.promise);
  const ready = h.monitor.watch('session'); h.emit(0, { ready: true }); h.emit(0, { action: 'INSERT', path });
  assert.equal(h.monitor.read('session').available, false);
  initial.resolve([device]); await ready; h.set([device]); await h.advance(4500);
  assert.equal(h.monitor.read('session').available, true); assert.deepEqual(h.monitor.read('session').events, []); h.monitor.stop();
});

test('an early old inventory result is checked again after device publication', async () => {
  const h = harness([other]); await h.start();
  h.emit(0, { action: 'INSERT', path });
  await h.advance(250);
  assert.equal(h.scans, 2);
  h.set([other, device]);
  await h.advance(4500);
  assert.deepEqual(h.monitor.read('session').events.map(event => event.action), ['INSERT']);
  h.monitor.stop();
});

test('watcher startup compares against the matching approved inventory instead of adopting a new USB device', async () => {
  const approved = [other];
  const h = harness([other, device], approved);
  await h.start('session', fingerprint(approved));
  // This device appeared before notification registration. SetupAPI still
  // saw it during watcher startup and corroborates its later removal.
  await h.advance(300);
  h.set(approved);
  h.emit(0, { action: 'REMOVE', path });
  await h.advance(1200);
  assert.deepEqual(h.monitor.read('session').events.map(event => event.action), ['INSERT', 'REMOVE']);
  h.monitor.stop();

  const stale = harness([other, device], approved);
  await stale.start('session', fingerprint([]));
  await stale.advance(5000);
  assert.deepEqual(stale.monitor.read('session').events, []);
  stale.monitor.stop();
});

test('partial JSON does not create events; malformed streams and sustained verification failures report detector failure', async () => {
  const h = harness(), ready = h.monitor.watch('session');
  h.children[0].stdout.write('{"ready":'); h.children[0].stdout.write('true}\n'); await ready;
  h.emit(0, { action: 'INSERT', path: path.replace('PID_5678', 'PID_5678&MI_00') }); assert.equal(h.monitor.read('session').events.length, 0);
  h.children[0].stdout.write('not-json\n'); assert.equal(h.children[0].killed, 1);
  assert.equal(h.monitor.read('session').available, false); h.monitor.stop();
  const failed = harness(); await failed.start();
  failed.set(() => { throw new Error('probe failed'); }); failed.emit(0, { action: 'INSERT', path }); await failed.advance();
  assert.equal(failed.children[0].killed, 0); assert.equal(failed.monitor.read('session').available, true);
  assert.match(failed.diagnostics.join('\n'), /inventory retry/);
  await failed.advance();
  assert.equal(failed.children[0].killed, 1); assert.equal(failed.monitor.read('session').available, false);
  assert.match(failed.diagnostics.join('\n'), /probe failed/); failed.monitor.stop();
});

test('listener recovery reconciles a real persistent change against the same session baseline', async () => {
  const h = harness([device]); await h.start();
  h.children[0].emit('exit', 1);
  h.set([device, other]);
  const restarting = h.monitor.watch('session'); h.emit(1, { ready: true }); await restarting;
  assert.deepEqual(h.monitor.read('session').events, []);
  await h.advance(3000);
  assert.deepEqual(h.monitor.read('session').events.map(({ action, deviceId }) => [action, deviceId]), [['INSERT', other]]);
  await h.start('new-session'); await h.advance(5000);
  assert.deepEqual(h.monitor.read('new-session').events, []);
  h.monitor.stop();
});

test('a synchronous listener startup failure can recover on the next read', async () => {
  const h = harness();
  h.setLaunchFailure(new Error('temporarily unable to launch helper'));
  await assert.rejects(h.monitor.watch('session'), /USB 设备通知监听不可用/);
  assert.match(h.diagnostics.join('\n'), /failed launch/);
  h.setLaunchFailure(null);
  assert.equal(h.monitor.read('session').available, false);
  assert.equal(h.children.length, 1);
  h.emit(0, { ready: true }); await flush();
  assert.equal(h.monitor.read('session').available, true);
  h.monitor.stop();
});

test('startup timeout cannot leave an apparently healthy watcher', async () => {
  const initial = deferred(), h = harness(() => initial.promise);
  const pending = h.monitor.watch('session'); h.emit(0, { ready: true });
  const rejected = assert.rejects(pending, /监听不可用/); await h.advance(10000); await rejected;
  assert.equal(h.children[0].killed, 1); h.monitor.stop(); initial.resolve([]); await flush();
});

test('stopping cancels confirmation and stale inventory/output cannot cross into a new session', async () => {
  const h = harness(), pending = h.monitor.watch('old'); h.monitor.stop(); await assert.rejects(pending, /已结束/);
  await h.start(); const scan = deferred(); h.set(() => scan.promise); h.emit(1, { action: 'INSERT', path }); await h.advance();
  h.monitor.stop(); h.set([]); await h.start('new');
  h.emit(1, { ready: true }); h.emit(1, { action: 'INSERT', path }); scan.resolve([device]); await flush(); await h.advance(6000);
  assert.deepEqual(h.monitor.read('new').events, []); assert.equal(h.monitor.read('new').available, true); h.monitor.stop();
});
