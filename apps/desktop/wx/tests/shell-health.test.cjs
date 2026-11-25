const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../resources/shell-health.js'), 'utf8');
function shell({ origin = 'https://proctor-client.invalid', subframe = false, renderer = true, bridge = true,
  guest = true, documentPresent = true } = {}) {
  const messages = [], events = new Map();
  const window = {
    chrome: { webview: { postMessage: value => messages.push(JSON.parse(JSON.stringify(value))) } },
    addEventListener: (name, callback) => events.set(name, callback),
    __proctorRendererReady: renderer,
    proctorApi: bridge ? {} : undefined
  };
  window.top = subframe ? {} : window;
  const document = {
    addEventListener: (name, callback) => events.set(name, callback),
    getElementById: name => name === 'ojView' ? (guest ? { loadURL() {} } : {}) : documentPresent ? {} : null
  };
  vm.runInNewContext(source, { window, document, location: new URL(origin + '/index.html') });
  return { window, messages, fire: (name, event) => events.get(name)?.(event) };
}

test('shell is ready only after its document, renderer and both native bridges load', () => {
  const browser = shell();
  assert.deepEqual(browser.messages, []);
  browser.fire('DOMContentLoaded');
  assert.deepEqual(browser.messages, [{ shellStatus: 'ready', reason: '' }]);
  browser.fire('DOMContentLoaded');
  browser.fire('error', { target: browser.window, lineno: 1 });
  assert.equal(browser.messages.length, 1, 'runtime failures after startup must not reclassify the shell');
});

test('partial upgrades and script initialization failures cannot masquerade as successful navigation', () => {
  for (const [setting, reason] of [['renderer', 'renderer-incomplete'], ['bridge', 'native-bridge'],
    ['guest', 'contest-bridge'], ['documentPresent', 'interface-document']]) {
    const browser = shell({ [setting]: false });
    browser.fire('DOMContentLoaded');
    assert.deepEqual(browser.messages, [{ shellStatus: 'failed', reason }]);
  }
});

test('missing scripts and styles fail startup; error messages and URLs remain private', () => {
  for (const type of ['script', 'link', 'execution']) {
    const browser = shell();
    browser.fire('error', { target: type === 'execution' ? browser.window : { localName: type },
      lineno: 12, colno: 3, message: 'secret-session-token', filename: 'https://example.test/?password=secret' });
    browser.fire('DOMContentLoaded');
    assert.deepEqual(browser.messages, [{ shellStatus: 'failed',
      reason: type === 'execution' ? 'script-execution:12:3' : 'resource-' + type }]);
  }
});

test('candidate images cannot abort startup and remote pages/subframes cannot report shell readiness', () => {
  const browser = shell();
  browser.fire('error', { target: { localName: 'img' } });
  browser.fire('DOMContentLoaded');
  assert.equal(browser.messages[0].shellStatus, 'ready');
  for (const options of [{ origin: 'https://hydro.example' }, { subframe: true }]) {
    const other = shell(options);
    other.fire('DOMContentLoaded');
    assert.deepEqual(other.messages, []);
  }
});
