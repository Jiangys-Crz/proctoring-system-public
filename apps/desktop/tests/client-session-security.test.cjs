const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
function between(a, b) { return source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a))); }
function deferred() { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; }
function context(overrides = {}) {
  const state = { serverUrl: 'https://api.test', sessionServerOrigin: 'https://api.test', sessionToken: 'test-token', session: { id: 's1' }, pairCode: '123456', pairPollToken: 'private-poll-proof', desktopInfo: { deviceId: 'd1' }, pairPollBusy: false };
  const resets = [], calls = [];
  const env = { state, URL, FormData, errorMessage: e => e.message, lastPairError: '', resets, calls, showError() {}, async resetWaitingLogin(text) { resets.push(text); state.sessionToken = ''; state.session = null; }, fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true, data: {} }) }; }, window: { proctorApi: { jsonRequest: async (url, path, options) => { calls.push({ url, path, options }); return {}; } } }, ...overrides };
  const ctx = vm.createContext(env);
  vm.runInContext(between('function clientAuthHeaders(', 'function watchScreenControl(') + between('function shouldFallbackToRendererFetch(', 'async function diagnoseFromRenderer(') + between('async function api(', 'function openUploadDb('), ctx);
  return { ctx, state, resets, calls };
}
test('session credentials are sent only to the origin that issued them, including explicit upload destinations', async () => {
  const h = context(); await h.ctx.fetchJsonFromRenderer('/api/client/upload', { serverUrl: 'https://other.test' }).catch(() => {});
  assert.equal(h.calls[0].options.headers['x-proctor-session-token'], undefined);
  assert.equal(h.calls[0].options.redirect, 'error'); assert.equal(h.calls[0].options.credentials, 'omit');
  h.state.serverUrl = 'https://other.test'; await h.ctx.api('/api/client/heartbeat'); assert.equal(h.calls[1].options.headers['x-proctor-session-token'], undefined);
});
test('both desktop request channels clear a revoked session exactly once', async () => {
  const main = context({ window: { proctorApi: { jsonRequest: async () => { throw new Error('[CLIENT_SESSION_REVOKED] revoked'); } } } });
  await assert.rejects(main.ctx.api('/api/client/heartbeat')); await assert.rejects(main.ctx.api('/api/client/heartbeat')); assert.equal(main.resets.length, 1); assert.equal(main.state.sessionToken, '');
  const renderer = context({ fetch: async () => ({ ok: false, json: async () => ({ code: 'CLIENT_SESSION_REVOKED', ok: false }) }) });
  await assert.rejects(renderer.ctx.fetchJsonFromRenderer('/api/client/heartbeat')); assert.equal(renderer.resets.length, 1);
});
test('a late revoked response from the previous server cannot log out the new session', async () => {
  const pending = deferred(), h = context({ window: { proctorApi: { jsonRequest: async () => pending.promise } } });
  const request = h.ctx.api('/api/client/heartbeat'); h.state.serverUrl = 'https://new.test'; h.state.sessionToken = 'new-token'; h.state.sessionServerOrigin = 'https://new.test'; h.state.session = { id: 's2' };
  pending.resolve(Promise.reject(new Error('[CLIENT_SESSION_REVOKED] old revoked')));
  await assert.rejects(request); assert.equal(h.resets.length, 0); assert.equal(h.state.sessionToken, 'new-token');
});
test('health checks stay valid across login/token changes and never transmit session credentials', async () => {
  for (const renderer of [false, true]) {
    const pending = deferred();
    const h = renderer ? context({ fetch: async (_url, options) => {
      assert.equal(options.headers['x-proctor-session-token'], undefined);
      return pending.promise;
    } }) : context({ window: { proctorApi: { jsonRequest: async (_url, _path, options) => {
      assert.equal(options.headers['x-proctor-session-token'], undefined);
      return pending.promise;
    } } } });
    const check = renderer ? h.ctx.fetchJsonFromRenderer('/api/health') : h.ctx.api('/api/health');
    h.state.session = { id: 'new-session' }; h.state.sessionToken = 'new-token';
    const data = { status: 'ok' };
    pending.resolve(renderer ? { ok: true, json: async () => ({ ok: true, data }) } : data);
    assert.deepEqual(await check, data);
    assert.equal(h.resets.length, 0);
  }
});
test('authenticated requests still reject a late result when the session changes', async () => {
  const pending = deferred(), h = context({ window: { proctorApi: { jsonRequest: async () => pending.promise } } });
  const request = h.ctx.api('/api/client/heartbeat'); h.state.sessionToken = 'new-token';
  pending.resolve({ session: { id: 'old-session' } });
  await assert.rejects(request, /会话已切换/);
});
test('anonymous polling needs its private proof, and it is carried in a header rather than the QR URL', async () => {
  const h = context(); vm.runInContext(between('async function pollPair()', 'async function startSubmittedMonitoring('), h.ctx);
  await h.ctx.pollPair(); assert.equal(h.calls[0].options.headers['x-proctor-pair-poll-token'], 'private-poll-proof'); assert.equal(h.calls[0].path.includes('private-poll-proof'), false);
  h.state.pairPollToken = ''; await h.ctx.pollPair(); assert.equal(h.calls.length, 1);
});
test('late polling cannot install another pair token or clear a newer polling request', async () => {
  const pending = deferred(), h = context({ window: { proctorApi: { jsonRequest: async () => pending.promise } } });
  vm.runInContext(between('async function pollPair()', 'async function startSubmittedMonitoring('), h.ctx);
  const request = h.ctx.pollPair(); h.state.pairCode = '654321'; h.state.pairPollToken = 'new-proof'; h.state.pairPollContext = {}; h.state.pairPollBusy = true;
  pending.resolve({ loginRequest: { candidate: {} }, desktopSessionToken: 'stale-token' }); await request;
  assert.equal(h.state.sessionToken, 'test-token'); assert.equal(h.state.pairPollBusy, true);
});

test('automatic backend selection clears pending login proofs, binds phone QR requests to the new backend, and preserves active exam sessions', () => {
  const h = context(); h.state.session = null; h.state.pairTimer = 1;
  const removed = [], checks = [];
  const element = { classList: { toggle() {} }, contains: () => true, focus() {} };
  Object.assign(h.ctx, { $: () => element, document: { activeElement: null }, clearInterval() {},
    localStorage: { removeItem: key => removed.push(key) }, setOnly() {}, setCheck() {}, updateSetupButtons() {},
    checkServerConnection: async () => checks.push(h.state.serverUrl) });
  h.ctx.window.PROCTOR_RELEASE_CHANNEL = 'unified';
  vm.runInContext(between('function renderClientUpdate(', 'async function ensureLatestClient('), h.ctx);
  h.ctx.renderClientUpdate({ serverOrigin: 'https://proctoring.example.test', releaseChannel: 'intranet', phase: 'current', required: false, message: 'current' });
  assert.equal(h.state.serverUrl, 'https://proctoring.example.test'); assert.equal(h.state.sessionToken, '');
  assert.equal(h.state.pairCode, ''); assert.equal(h.state.pairPollToken, ''); assert.equal(h.state.pairPollContext, null);
  assert.equal(h.ctx.window.PROCTOR_PUBLIC_API_URL, 'https://proctoring.example.test');
  assert.deepEqual(removed, ['proctorServerUrl']); assert.deepEqual(checks, ['https://proctoring.example.test']);
  h.state.session = { id: 'active' }; h.state.sessionToken = 'bound-token';
  h.ctx.renderClientUpdate({ serverOrigin: 'https://proctoring.example.org', releaseChannel: 'public', phase: 'current', required: false, message: 'current' });
  assert.equal(h.state.serverUrl, 'https://proctoring.example.test'); assert.equal(h.state.sessionToken, 'bound-token');
  assert.equal(h.ctx.window.PROCTOR_PUBLIC_API_URL, 'https://proctoring.example.test'); assert.equal(checks.length, 1);
});


test('a late successful response using the old token cannot refresh the reauthenticated session with the same ID', async () => {
  const pending = deferred(), h = context({ window: { proctorApi: { jsonRequest: async () => pending.promise } } });
  const request = h.ctx.api('/api/client/heartbeat');
  h.state.sessionToken = 'recovered-token';
  pending.resolve({ session: { id: 's1', status: 'OFFLINE' } });
  await assert.rejects(request, /会话已切换/);
  assert.equal(h.state.sessionToken, 'recovered-token');
  assert.equal(h.resets.length, 0);
});
