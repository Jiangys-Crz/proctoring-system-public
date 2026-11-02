const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const renderer = readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const source = renderer.slice(renderer.indexOf('async function checkServerConnection()'), renderer.indexOf('async function saveServerUrlFromInput()'));
function harness(api, probes) {
  const classes = new Set(), errors = [];
  const state = { serverUrl: 'https://old.test', serverCheckRequestId: 0 };
  const element = { parentElement: { classList: { add: value => classes.add(value), remove: (...values) => values.forEach(value => classes.delete(value)) } } };
  const context = vm.createContext({ state, api, $: () => element, allowCurrentServerHost: async () => {},
    buildConnectionDiagnostics: async () => { state.networkAccessProbe = probes; },
    networkAccessOk: () => !!state.networkAccessProbe?.some(probe => probe.ok), showError: error => errors.push(error),
    setCheck() {}, ensureUploadFlushTimer() {}, flushUploadQueue() {}, flushPendingAlerts() {}, friendlyNetworkError: error => error.message,
  });
  vm.runInContext(source, context);
  return { context, state, element, classes, errors };
}
test('an older failed check cannot overwrite a successful check after backend selection', async () => {
  let reject;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  let calls = 0;
  const h = harness(() => ++calls === 1 ? pending : Promise.resolve({}));
  const old = h.context.checkServerConnection(); await new Promise(resolve => setImmediate(resolve));
  h.state.serverUrl = 'https://selected.test';
  assert.equal(await h.context.checkServerConnection(), true);
  reject(new Error('服务器或会话已切换，请重试'));
  assert.equal(await old, false);
  assert.equal(h.errors.length, 0); assert.equal(h.classes.has('bad'), false);
  assert.equal(h.element.textContent, '已连接：https://selected.test');
});
test('a working alternate channel renders connected without a false failure toast', async () => {
  const h = harness(async () => { throw new Error('channel unavailable'); }, [{ ok: true, channel: 'node-http' }]);
  assert.equal(await h.context.checkServerConnection(), true);
  assert.equal(h.classes.has('ok'), true); assert.equal(h.errors.length, 0);
});
test('an actual outage still renders failure even after a previous success', async () => {
  const h = harness(async () => { throw new Error('network unavailable'); }, [{ ok: false }]);
  h.state.networkAccessProbe = [{ ok: true }];
  assert.equal(await h.context.checkServerConnection(), false);
  assert.equal(h.classes.has('bad'), true); assert.equal(h.errors.length, 1);
});
