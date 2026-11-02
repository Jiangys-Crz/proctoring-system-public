const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const renderer = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const source = renderer.slice(renderer.indexOf('async function testDesktopDisconnect()'));

function harness(api) {
  const state = { requirements: { isPublicTest: true }, session: { id: 'session' }, sessionToken: 'old-token', desktopInfo: { deviceId: 'desktop' } };
  const elements = new Map(), calls = [], restored = [];
  const element = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  const context = vm.createContext({ state, $: element,
    api: async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return api(); },
    stopMonitoringTimers() {}, stopRecorders: async () => {}, stopRtmpStreams: async () => {},
    resetWaitingLogin: async () => { state.session = null; state.sessionToken = ''; },
    showPair: async pair => { element('pairQr').src = `qr:${pair.pairCode}`; },
    startSubmittedMonitoring: async session => restored.push(session.id),
    window: { proctorApi: { stopRtmpStreams: async () => {}, stopRtmpPipes: async () => {} } },
  });
  vm.runInContext(source, context);
  return { state, context, element, calls, restored };
}

test('disconnect test gives immediate button feedback, rejects duplicate clicks and installs the recovery QR', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const h = harness(() => response);
  const clicking = h.context.testDesktopDisconnect();
  assert.equal(h.element('testDisconnectBtn').disabled, true);
  assert.equal(h.element('testDisconnectBtn').textContent, '正在断开连接…');
  await h.context.testDesktopDisconnect();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.side, 'DESKTOP');
  resolve({ pairCode: '123456', pollToken: 'new-poll-proof', recoverySecret: 'phone-scan-proof' });
  await clicking;
  assert.equal(h.state.session, null);
  assert.equal(h.state.sessionToken, '');
  assert.equal(h.state.pairPollToken, 'new-poll-proof');
  assert.equal(h.element('pairQr').src, 'qr:123456');
  assert.equal(h.element('ojView').src, 'about:blank');
  assert.equal(h.element('testDisconnectBtn').disabled, false);
  assert.equal(h.state.testDisconnecting, false);
});

test('a rejected disconnect restores monitoring and leaves the active credentials available', async () => {
  const h = harness(async () => { throw new Error('network unavailable'); });
  await assert.rejects(h.context.testDesktopDisconnect(), /network unavailable/);
  assert.deepEqual(h.restored, ['session']);
  assert.equal(h.state.sessionToken, 'old-token');
  assert.equal(h.state.testDisconnecting, false);
  assert.equal(h.element('testDisconnectBtn').disabled, false);
});
