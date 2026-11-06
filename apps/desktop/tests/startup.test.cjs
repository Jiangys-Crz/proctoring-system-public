const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { test } = require('node:test');
const { configureWindowsRendering, writeStartupDiagnostic } = require('../dist/main/startup');
const { RendererRecoveryStore } = require('../dist/main/renderer-recovery');

test('Windows configures rendering and verifies elevation before loading the application module', async () => {
  const order = [], listeners = {};
  const app = { disableHardwareAcceleration: () => order.push('software-rendering'), commandLine: { appendSwitch: value => order.push(value) }, on: (name, listener) => { listeners[name] = listener; },
    whenReady: async () => { order.push('ready'); }, requestSingleInstanceLock: () => { order.push('ownership'); return true; } };
  configureWindowsRendering(app, 'darwin'); assert.equal(order.length, 0);
  const electron = { app, crashReporter: { start: options => { assert.equal(options.uploadToServer, false); order.push('local-crash-reports'); } }, dialog: { showErrorBox: () => assert.fail('normal startup must not show a failure') } };
  const exports = {};
  vm.runInNewContext(readFileSync(require.resolve('../dist/main/bootstrap'), 'utf8'), {
    exports, process: { platform: 'win32', versions: { electron: '22.3.27' }, argv: [], on() {} }, require: name => {
      if (name === 'electron') return electron;
      if (name === './startup') return { configureWindowsRendering: value => configureWindowsRendering(value, 'win32'), writeStartupDiagnostic() {} };
      if (name === './windows-admin-startup') return { ensureWindowsAdministrator: async () => { order.push('administrator'); return true; } };
      if (name === './main') { order.push('application'); return {}; }
      throw new Error(name);
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['software-rendering', 'disable-gpu-shader-disk-cache', 'local-crash-reports', 'ready', 'ownership', 'administrator', 'application']);
  assert.equal(typeof listeners['child-process-gone'], 'function');
});

test('cancelled Windows elevation and secondary launches cannot create a browser or load the updater', async () => {
  for (const primary of [false, true]) {
    let checks = 0, quits = 0;
    vm.runInNewContext(readFileSync(require.resolve('../dist/main/bootstrap'), 'utf8'), {
      exports: {}, process: { platform: 'win32', versions: {}, argv: [], on() {} }, require: name => {
        if (name === 'electron') return { app: { on() {}, whenReady: async () => {}, requestSingleInstanceLock: () => primary, quit: () => quits++ }, crashReporter: { start() {} }, dialog: {} };
        if (name === './startup') return { configureWindowsRendering() {}, writeStartupDiagnostic() {} };
        if (name === './windows-admin-startup') return { ensureWindowsAdministrator: async () => { checks++; return false; } };
        assert.fail(`startup loaded ${name} before admin authorization`);
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, primary ? 1 : 0); assert.equal(quits, 1);
  }
});

test('startup exceptions show native diagnostics, including asynchronous main-process failures', async () => {
  const reports = [], handlers = {};
  let quits = 0;
  vm.runInNewContext(readFileSync(require.resolve('../dist/main/bootstrap'), 'utf8'), {
    exports: {}, process: { platform: 'win32', versions: {}, argv: [], on: (name, callback) => { handlers[name] = callback; } }, require: name => {
      if (name === 'electron') return { app: { on() {}, whenReady: async () => {}, requestSingleInstanceLock: () => true, quit: () => quits++ }, crashReporter: { start() {} }, dialog: { showErrorBox: (...args) => reports.push(args) } };
      if (name === './startup') return { configureWindowsRendering() {}, writeStartupDiagnostic() {}, startupFailureDetail: () => 'local logs' };
      if (name === './windows-admin-startup') return { ensureWindowsAdministrator: async () => true };
      if (name === './main') throw new Error('module failed');
      throw new Error(name);
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports.length, 1); assert.equal(quits, 1);
  assert.match(reports[0][0], /启动失败/); assert.equal(reports[0][1], 'local logs');
  handlers.uncaughtException(new Error('async failure'));
  handlers.unhandledRejection(new Error('rejected failure'));
  assert.equal(reports.length, 1, 'a fatal failure must not show repeated error dialogs');
});

test('startup diagnostics persist locally and logging errors cannot abort startup', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'proctor-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = { getPath: () => directory, getVersion: () => '0.1.31' };
  writeStartupDiagnostic(runtime, 'render-process-gone', 'crashed exit=1');
  assert.match(readFileSync(path.join(directory, 'logs/startup.log'), 'utf8'), /v0.1.31.*render-process-gone: crashed exit=1/);
  assert.doesNotThrow(() => writeStartupDiagnostic({ ...runtime, getPath: () => { throw new Error('profile unavailable'); } }, 'startup', 'failed'));
});

test('login window stays hidden until loaded, recovers one renderer crash and reports persistent failures', () => {
  const source = readFileSync(require.resolve('../src/main/main.ts'), 'utf8');
  const start = source.indexOf('function createWindow()');
  const code = source.slice(start, source.indexOf('function pickPrimaryScreenSource(', start));
  let window, failures = 0, cleanup = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super(); window = this; this.options = options; this.shown = 0; this.maximized = 0; this.reloaded = 0;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.reload = () => { this.reloaded++; };
    }
    async loadFile() {}
    isDestroyed() { return false; }
    maximize() { this.maximized++; }
    show() { this.shown++; }
  }
  const context = vm.createContext({ BrowserWindow: Window, mainWindow: null, path, __dirname: '/fixture', rendererFile: '/fixture/index.html',
    process: { env: {} }, screenControlWatcher: { isDisplaying: false }, windowMode: 'setup',
    cleanupMonitoring: () => { cleanup++; }, writeStartupDiagnostic() {}, startupFailureDetail: () => 'fixture diagnostics',
    rendererRecovery: new RendererRecoveryStore(), app: {}, dialog: { showErrorBox: () => { failures++; } },
  });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  context.createWindow();
  assert.equal(window.options.show, false); assert.equal(window.shown, 0); assert.equal(window.maximized, 0);
  assert.equal(window.options.webPreferences.backgroundThrottling, false, 'evidence capture must continue when the window is hidden or unfocused');
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.webSecurity, true);
  window.emit('ready-to-show'); assert.equal(window.shown, 1); assert.equal(window.maximized, 1);
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(window.reloaded, 1); assert.equal(failures, 0); assert.equal(cleanup, 1);
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(window.reloaded, 1); assert.equal(failures, 1);
  context.createWindow(); context.windowMode = 'floating';
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(window.reloaded, 0, 'an active exam is not silently replaced with a fresh login page');
  assert.equal(failures, 2);
});
