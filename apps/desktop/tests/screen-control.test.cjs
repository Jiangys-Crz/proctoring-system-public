const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { ScreenControlWatcher, parseScreenControlState, screenControlImageUrl, validateScreenControlIdentity } = require('../dist/main/screen-control');
const { assertScreenControlImage } = require('../dist/main/screen-control-network');

const identity = { baseUrl: 'https://exam.example.org', sessionId: 'session_1', token: 'desktop-token' };
const epoch = Date.parse('2026-10-07T06:00:00Z');
const iso = (time) => new Date(time).toISOString();
function response(options = {}) {
  return {
    serverNow: iso(options.now ?? epoch), nextStartsAt: options.nextStartsAt ?? null,
    active: options.stopped ? null : {
      id: options.id || 'broadcast_1', groupName: '比赛通知', intervalMs: 5000,
      startsAt: iso(epoch - 5000), endsAt: options.endsAt === undefined ? null : iso(options.endsAt),
      images: [{ id: 'image_1', name: '通知.png', order: 0, url: '/api/client/screen-control/images/image_1?sessionId=session_1' }]
    }
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function runtime(reads, readImage = async () => 'data:image/png;base64,aGVsbG8=') {
  let now = epoch + 9 * 60 * 60 * 1000; // Client clock may differ substantially from server time.
  let nextTimer = 0;
  const timers = new Map();
  const displays = [], errors = [];
  const watcher = new ScreenControlWatcher({
    now: () => now,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    readState: async () => {
      const result = reads.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    readImage, display: (value) => displays.push(value), reportError: (error) => errors.push(error)
  });
  return { watcher, displays, errors, timers,
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, item]) => item.at <= now);
      for (const [id, item] of due) { timers.delete(id); item.callback(); }
      await flush();
    }
  };
}

test('only authenticated same-origin image endpoints for the current session are accepted', () => {
  assert.equal(validateScreenControlIdentity({ ...identity, baseUrl: `${identity.baseUrl}/ignored/` }).baseUrl, identity.baseUrl);
  for (const token of ['', 'bad\r\ntoken']) assert.throws(() => validateScreenControlIdentity({ ...identity, token }));
  for (const url of [
    'https://external.example.com/api/client/screen-control/images/image_1?sessionId=session_1',
    '/api/client/screen-control/images/image_1?sessionId=another_session',
    '/api/client/screen-control/images/image_1?sessionId=session_1&token=secret',
    '/api/client/screen-control/images/other_image?sessionId=session_1',
    'file:///tmp/image.png', '/api/client/screen-control/images/image_1?sessionId=session_1#fragment'
  ]) assert.throws(() => screenControlImageUrl(identity, { id: 'image_1', url }));
  assert.throws(() => parseScreenControlState({ ...response(), serverNow: 'invalid' }, identity));
  assert.throws(() => parseScreenControlState(response({ endsAt: epoch - 1 }), identity));
  assert.throws(() => parseScreenControlState({ ...response(), active: { ...response().active, intervalMs: 1000 } }, identity));
});

test('image validation rejects executable formats and MIME spoofing', () => {
  assert.doesNotThrow(() => assertScreenControlImage('image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.doesNotThrow(() => assertScreenControlImage('image/jpeg', Buffer.from([255, 216, 255, 224])));
  assert.throws(() => assertScreenControlImage('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')));
  assert.throws(() => assertScreenControlImage('image/png', Buffer.from('<html>not a png</html>')));
});

test('login immediately locks and keeps polling independently of exam/renderer state', async () => {
  const env = runtime([response(), response({ stopped: true })]);
  await env.watcher.watch(identity);
  await flush();
  assert.equal(env.watcher.isDisplaying, true);
  assert.equal(env.displays.at(-1).images.length, 1);
  assert.equal(env.displays.at(-1).intervalMs, 5000);
  await env.advance(2000);
  assert.equal(env.watcher.isDisplaying, false);
  assert.equal(env.displays.at(-1), null);
  env.watcher.release();
  assert.equal(env.timers.size, 0);
});

test('administrator STOP is polled while an image is still downloading; late images cannot relock', async () => {
  let finishImage;
  const pending = new Promise((resolve) => { finishImage = resolve; });
  const env = runtime([response(), response({ stopped: true })], () => pending);
  await env.watcher.watch(identity);
  assert.equal(env.watcher.isDisplaying, true);
  assert.equal(env.watcher.displayState.images.length, 0);
  await env.advance(2000);
  assert.equal(env.watcher.isDisplaying, false);
  const events = env.displays.length;
  finishImage('data:image/png;base64,aGVsbG8=');
  await flush();
  assert.equal(env.watcher.isDisplaying, false);
  assert.equal(env.displays.length, events);
  env.watcher.release();
});

test('disconnect past the deadline retains the lock until the server confirms completion', async () => {
  const env = runtime([response({ endsAt: epoch + 5000 }), new Error('offline'), new Error('offline'), response({ stopped: true })]);
  await env.watcher.watch(identity);
  await env.advance(2000);
  assert.equal(env.watcher.isDisplaying, true);
  assert.equal(env.errors.length, 1);
  await env.advance(3000);
  assert.equal(env.watcher.isDisplaying, true);
  await env.advance(2000);
  assert.equal(env.watcher.isDisplaying, false);
  env.watcher.release();
});

test('renderer release cannot cancel a broadcast, change session, or stop manual-until-ended polling', async () => {
  const env = runtime([response(), response({ stopped: true })]);
  await env.watcher.watch(identity);
  env.watcher.release();
  assert.equal(env.watcher.isDisplaying, true);
  await assert.rejects(env.watcher.watch({ ...identity, sessionId: 'session_2' }), /不能切换/);
  await env.advance(2000);
  assert.equal(env.watcher.isDisplaying, false);
  assert.equal(env.timers.size, 0);
});

test('replacing a broadcast invalidates the preceding download task', async () => {
  let finishOld;
  const old = new Promise((resolve) => { finishOld = resolve; });
  let calls = 0;
  const env = runtime([response(), response({ id: 'broadcast_2' })], () => ++calls === 1 ? old : Promise.resolve('data:image/png;base64,new'));
  await env.watcher.watch(identity);
  await env.advance(2000);
  assert.equal(env.watcher.displayState.id, 'broadcast_2');
  finishOld('data:image/png;base64,old');
  await flush();
  assert.equal(env.watcher.displayState.id, 'broadcast_2');
  assert.equal(env.watcher.displayState.images[0].dataUrl, 'data:image/png;base64,new');
});

test('scheduled displays use next server start time even when the local clock differs', async () => {
  const env = runtime([response({ stopped: true, nextStartsAt: iso(epoch + 500) }), response({ now: epoch + 500 })]);
  await env.watcher.watch(identity);
  assert.equal(env.watcher.isDisplaying, false);
  await env.advance(499);
  assert.equal(env.watcher.isDisplaying, false);
  await env.advance(1);
  assert.equal(env.watcher.isDisplaying, true);
});

test('display starts with image one and advances every five seconds; mouse/key input has no action', () => {
  let receive, tick, now = epoch;
  const image = { hidden: true, removeAttribute() { this.src = ''; } };
  const loading = { hidden: false };
  const listeners = new Map();
  const context = {
    document: { getElementById: (id) => id === 'screenControlImage' ? image : loading },
    window: { screenControlDisplay: { subscribe: (callback) => { receive = callback; } }, addEventListener: (name, listener) => listeners.set(name, listener) },
    Date: { now: () => now }, setInterval: (callback) => { tick = callback; }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/renderer/screen-control-display.js'), 'utf8'), context);
  const display = { id: 'b1', startsAtLocal: epoch - 120_000, images: [
    { id: 'i1', name: '图一', dataUrl: 'data:image/png;base64,one' }, { id: 'i2', name: '图二', dataUrl: 'data:image/png;base64,two' }
  ] };
  receive(display);
  assert.equal(image.src, display.images[0].dataUrl);
  now += 4999; tick(); assert.equal(image.src, display.images[0].dataUrl);
  now += 1; tick(); assert.equal(image.src, display.images[1].dataUrl);
  now += 5000; tick(); assert.equal(image.src, display.images[0].dataUrl);
  let prevented = 0, stopped = 0;
  for (const name of ['keydown', 'click', 'wheel', 'contextmenu']) listeners.get(name)({ preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
  assert.equal(prevented, 4); assert.equal(stopped, 4);
});

test('native display windows cover all screens and deny close, input, navigation and page privileges', () => {
  const nativeWindows = [];
  let guardOptions, guardStarts = 0, guardStops = 0, handles = [];
  class Guard {
    constructor(options) { guardOptions = options; }
    start() { guardStarts++; }
    stop() { guardStops++; }
    updateWindows(value) { handles = value; }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      this.loading = true;
      this.webContents.isLoading = () => this.loading; this.webContents.send = (_channel, state) => { this.state = state; };
      nativeWindows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setFullScreen(value) { this.fullscreen = value; }
    setKiosk(value) { this.kiosk = value; } setBounds() {} setFocusable() {}
    isMinimized() { return false; } restore() {} show() {} showInactive() {} focus() {}
    loadFile() { return Promise.resolve(); }
    getNativeWindowHandle() { return Buffer.from([nativeWindows.indexOf(this) + 1, 0, 0, 0]); }
  }
  const screen = new EventEmitter();
  let displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }];
  screen.getAllDisplays = () => displays;
  screen.getPrimaryDisplay = () => screen.getAllDisplays()[0];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/main/screen-control-windows'), 'utf8'), {
    module, exports: module.exports, __dirname: '/client/main', process: { platform: 'win32', arch: 'x64' }, setTimeout, clearTimeout, console,
    require: (id) => id === 'electron' ? { app: { isPackaged: false }, BrowserWindow: Window, screen }
      : id === './windows-screen-control-guard' ? { WindowsScreenControlGuard: Guard } : require(id)
  });
  let restored = 0;
  const overlays = new module.exports.ScreenControlWindows(() => restored++);
  overlays.show({ id: 'b1', images: [] });
  overlays.show({ id: 'b1', images: [] });
  assert.equal(nativeWindows.length, 2);
  assert.equal(guardStarts, 1);
  assert.equal(handles.length, 2);
  const downloaded = { id: 'b1', images: [{ id: 'image1', name: '图一', dataUrl: 'data:image/png;base64,one' }] };
  overlays.show(downloaded);
  overlays.rendererReady({ send() { assert.fail('An untrusted renderer must not receive broadcast images'); } });
  for (const window of nativeWindows) {
    window.webContents.emit('did-finish-load');
    assert.equal(window.state, undefined, 'Electron 22 still reports loading at did-finish-load');
    window.loading = false;
    window.webContents.emit('did-stop-loading');
    assert.equal(window.state.images[0].dataUrl, downloaded.images[0].dataUrl, 'cached images must be replayed when loading stops');
    window.state = undefined;
    window.loading = true;
    overlays.rendererReady(window.webContents);
    assert.equal(window.state.images[0].id, 'image1', 'a registered display subscription receives the current images even during loading');
    window.loading = false;
  }
  for (const window of nativeWindows) {
    assert.equal(window.options.closable, false);
    assert.equal(window.options.minimizable, false);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.kiosk, true);
    assert.equal(window.fullscreen, true);
    assert.equal(window.openHandler().action, 'deny');
    let prevented = 0;
    const event = { preventDefault: () => prevented++ };
    window.emit('close', event);
    window.webContents.emit('before-input-event', event, { key: 'Escape' });
    window.webContents.emit('will-navigate', event, 'https://other.example.com');
    assert.equal(prevented, 3);
  }
  guardOptions.onDesktopChanged();
  assert.equal(nativeWindows.length, 4, 'a new HWND must be created on the new virtual desktop for every monitor');
  assert.equal(nativeWindows.slice(0, 2).every(window => window.destroyed), true);
  assert.equal(nativeWindows.slice(2).every(window => !window.destroyed), true);
  for (const window of nativeWindows.slice(2)) { window.loading = false; window.webContents.emit('did-stop-loading'); }
  guardOptions.onStatus('屏幕控制保护异常，请联系监考老师。');
  assert.equal(nativeWindows.at(-1).state.guardError, '屏幕控制保护异常，请联系监考老师。');
  guardOptions.onStatus(null);
  assert.equal(nativeWindows.at(-1).state.guardError, null);
  displays = [...displays, { id: 3, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } }];
  screen.emit('display-added');
  assert.equal(handles.length, 3, 'hot-plugging a monitor extends native window validation');
  assert.equal(nativeWindows.length, 5);
  displays = displays.slice(1);
  screen.emit('display-removed');
  assert.equal(handles.length, 2);
  overlays.show(null);
  assert.equal(guardStops, 1);
  assert.equal(restored, 1);
  assert.equal(nativeWindows.every((window) => window.destroyed), true);
  assert.equal(screen.listenerCount('display-added'), 0);
  guardOptions.onDesktopChanged();
  assert.equal(nativeWindows.length, 5, 'late native events cannot relock an ended broadcast');
});

test('focusing the administrator broadcast does not report a false candidate screen-switch incident', async () => {
  const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
  const start = source.indexOf("window.addEventListener('blur', async () => {");
  const end = source.indexOf('\nconst performPermissionAction', start);
  let listener, displaying = true, alerts = 0;
  vm.runInNewContext(source.slice(start, end), {
    window: {
      addEventListener: (_name, callback) => { listener = callback; },
      proctorApi: { isScreenControlDisplaying: async () => displaying }
    },
    state: { session: { id: 'session_1', status: 'IN_EXAM' } },
    reportAlert: async () => { alerts++; }
  });
  await listener();
  assert.equal(alerts, 0);
  displaying = false;
  await listener();
  assert.equal(alerts, 1);
});
