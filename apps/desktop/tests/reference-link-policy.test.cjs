const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const path = require('node:path');
const policy = require('../dist/main/reference-link-policy');

test('references accept any website but only the exact clicked document, with rendering assets and dynamic data but no frames', () => {
  const target = 'https://arbitrary.example/guide?chapter=1#intro';
  assert.equal(policy.referenceLinkUrl(target), target);
  assert.equal(policy.referenceRequestAllowed(target, 'mainFrame', target), true);
  for (const url of ['https://arbitrary.example/other', 'https://arbitrary.example/guide?chapter=2#intro',
    'https://arbitrary.example/guide?chapter=1#other', 'https://other.example/guide',
    'file:///tmp/private', 'javascript:alert(1)', 'https://user:password@arbitrary.example/guide']) {
    assert.equal(policy.referenceNavigationAllowed(url, target), false);
    assert.equal(policy.referenceRequestAllowed(url, 'mainFrame', target), false);
  }
  assert.equal(policy.referenceRequestAllowed('https://cdn.example/style.css', 'stylesheet', target), true);
  assert.equal(policy.referenceRequestAllowed('https://cdn.example/embedded', 'subFrame', target), false);
  assert.equal(policy.referenceRequestAllowed('https://arbitrary.example/api/content', 'xhr', target), true);
});

test('files from arbitrary websites download without rendering redirects; page popups cannot download a different address', () => {
  for (const target of ['https://files.example/data.zip', 'https://files.example/data.PDF?ticket=1', 'https://files.example/download/123', 'https://files.example/solution.rs']) {
    assert.equal(policy.referenceIsFile(target), true);
    assert.equal(policy.referenceDownloadAllowed([target, 'https://storage.example/data.zip'], target, true), true);
    assert.equal(policy.referenceDownloadAllowed([target, 'file:///tmp/private'], target, true), false);
    assert.equal(policy.referenceDownloadAllowed(['https://other.example/a.zip'], target, true), false);
  }
  const target = 'https://reference.example/docs';
  assert.equal(policy.referenceIsFile(target), false);
  assert.equal(policy.referenceIsFile('https://reference.example/chapter.html'), false);
  assert.equal(policy.referenceDownloadAllowed([target], target, false), true);
  assert.equal(policy.referenceDownloadAllowed([target, 'https://reference.example/next'], target, false), false);
});

function windowHarness() {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.loads = []; this.downloads = []; this.closed = false; this.shown = false;
      const contents = this.webContents = new EventEmitter();
      contents.session = Object.assign(new EventEmitter(), {
        setPermissionCheckHandler: fn => { this.permissionCheck = fn; },
        setPermissionRequestHandler: fn => { this.permissionRequest = fn; },
        webRequest: { onBeforeRequest: fn => { this.request = fn; } },
      });
      contents.setWindowOpenHandler = fn => { this.popup = fn; };
      contents.closeDevTools = () => {};
      contents.downloadURL = url => this.downloads.push(url);
      windows.push(this);
    }
    loadURL(url) { this.loads.push(url); return Promise.resolve(); }
    isDestroyed() { return this.closed; }
    close() { this.closed = true; }
    show() { this.shown = true; }
  }
  const source = readFileSync(path.join(__dirname, '../dist/main/main.js'), 'utf8');
  const offset = source.indexOf('function openRestrictedExternalWindow(');
  const approvals = new Map();
  const context = vm.createContext({ BrowserWindow: Window, electron_1: { BrowserWindow: Window, app: { getPath: () => '/downloads' } },
    reference_link_policy_1: policy, contest_download_policy_1: require('../dist/main/contest-download-policy'),
    node_path_1: { default: path }, screenControlWatcher: { isDisplaying: false }, mainWindow: {},
    referenceDomainApprovals: approvals, novaJudgeScope: null, URL, Date, Math,
  });
  vm.runInContext(source.slice(offset, source.indexOf('\nfunction createWindow(', offset)), context);
  return { open: url => context.openRestrictedExternalWindow(url), windows, context, approvals };
}

test('the actual desktop window blocks link clicks, redirects, History API paths, child windows and form posts', () => {
  const fixture = windowHarness(), target = 'https://unconfigured.example/reference';
  fixture.open(target); const window = fixture.windows[0];
  assert.deepEqual(window.loads, [target]); assert.equal(window.options.modal, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false); assert.equal(window.permissionCheck(), false);
  let denied = false;
  for (const name of ['will-navigate', 'will-redirect']) {
    window.webContents.emit(name, { preventDefault: () => { denied = true; } }, target + '/next');
    assert.equal(denied, true); denied = false;
  }
  assert.equal(window.popup({ url: target + '/next' }).action, 'deny'); assert.equal(fixture.windows.length, 1);
  window.webContents.emit('did-navigate-in-page', {}, target + '?search=answer', true);
  assert.deepEqual(window.loads, [target, target]);
  const request = (url, resourceType, method = 'GET') => { let cancel; window.request({ url, resourceType, method }, result => { cancel = result.cancel; }); return cancel; };
  assert.equal(request(target, 'mainFrame'), false);
  assert.equal(request(target + '/next', 'mainFrame'), true);
  assert.equal(request(target, 'mainFrame', 'POST'), true);
  assert.equal(request('https://cdn.example/style.css', 'stylesheet'), false);
  assert.equal(fixture.approvals.has('unconfigured.example'), true);
  assert.equal(fixture.approvals.has('cdn.example'), true);
  assert.equal(fixture.approvals.has('other.example'), false);
  fixture.context.screenControlWatcher.isDisplaying = true;
  assert.equal(request(target, 'mainFrame'), true);
});

test('the actual file window saves the requested file, rejects unrelated downloads and closes after completion', () => {
  const fixture = windowHarness(), target = 'https://unconfigured.example/样例.zip';
  fixture.open(target); const window = fixture.windows[0], canonical = new URL(target).href;
  assert.deepEqual(window.downloads, [canonical]); assert.deepEqual(window.loads, []);
  const item = Object.assign(new EventEmitter(), { getURLChain: () => [canonical, 'https://storage.example/file.zip'],
    getFilename: () => '样例.zip', setSaveDialogOptions: options => { item.options = options; } });
  let blocked = false;
  window.webContents.session.emit('will-download', { preventDefault: () => { blocked = true; } }, item);
  assert.equal(blocked, false); assert.equal(item.options.defaultPath, '/downloads/样例.zip');
  item.emit('done'); assert.equal(window.closed, true);
  item.getURLChain = () => ['https://unrelated.example/a.zip'];
  window.webContents.session.emit('will-download', { preventDefault: () => { blocked = true; } }, item);
  assert.equal(blocked, true);
});
