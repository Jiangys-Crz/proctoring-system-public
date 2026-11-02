const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness(handler = () => ({ ok: true, data: {} })) {
  const storage = new Map(), calls = [], notices = [];
  const app = { globalData: { serverUrl: 'https://api.test', miniProgramDeviceId: 'test-phone' } };
  let page;
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    request(options) { calls.push(options); const body = handler(options, false); if (body !== undefined) options.success({ statusCode: body.code ? 410 : 200, data: body }); },
    uploadFile(options) { calls.push(options); options.success({ statusCode: 200, data: JSON.stringify(handler(options, true)) }); },
    redirectTo: value => notices.push(value), showToast: value => notices.push(value), setClipboardData: value => notices.push(value),
    scanCode: options => { wx.scan = options; }
  };
  const cache = new Map();
  function load(relative) {
    const file = path.resolve(__dirname, '..', relative);
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    const context = { module, exports: module.exports, wx, getApp: () => app, setInterval: () => 1, clearInterval() {}, Page(value) { page = value; page.setData = data => Object.assign(page.data, data); }, require: name => load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(file), name + (path.extname(name) ? '' : '.js')))) };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file }); cache.set(file, module.exports); return module.exports;
  }
  const api = load('utils/api.js');
  return { api, wx, app, storage, calls, notices, load, page: () => page };
}
test('HTTPS validation rejects plaintext, credentials, path, fragments and invalid ports', () => {
  const { api } = harness();
  for (const value of ['http://api.test', 'https://a@api.test', 'https://api.test/x', 'https://api.test#token', 'https://api.test:99999']) assert.throws(() => api.secureOrigin(value));
  assert.equal(api.secureOrigin('https://API.test:443/'), 'https://api.test');
});
test('a token belongs to one HTTPS origin and switching servers clears the entire old session', async () => {
  const h = harness(); h.api.saveSession('s1', 'audit-token');
  await h.api.request('/api/client/heartbeat'); assert.equal(h.calls[0].header.authorization, 'Bearer audit-token');
  h.api.configureServer('https://other.test'); assert.equal(h.storage.size, 0);
  await h.api.request('/api/client/exams'); assert.equal(h.calls[1].header.authorization, undefined);
});
test('direct global server edits cannot send old tokens, and stale responses cannot establish a new session', async () => {
  const h = harness(() => undefined); h.api.saveSession('s1', 'audit-token');
  const request = h.api.request('/api/client/heartbeat'); h.app.globalData.serverUrl = 'https://other.test';
  h.calls[0].success({ statusCode: 200, data: { ok: true, data: { sessionId: 'old' } } });
  await assert.rejects(request, /已切换/); assert.equal(h.storage.size, 0);
});
test('explicit server revocation clears the local token and returns a recognizable logout error', async () => {
  const h = harness(() => ({ code: 'CLIENT_SESSION_REVOKED', message: 'revoked' })); h.api.saveSession('s1', 'audit-token');
  await assert.rejects(h.api.request('/api/client/heartbeat'), error => error.code === 'CLIENT_SESSION_REVOKED'); assert.equal(h.storage.size, 0);
});
test('new QR URLs carry recovery proof or credential ticket, never a polling token', () => {
  const { load } = harness(), { parsePairQr } = load('utils/pair-qr.js');
  const secret = 'x'.repeat(43), url = 'https://student.test/?apiBase=https%3A%2F%2Fapi.test&pairCode=123456&recoverySecret=' + secret;
  assert.equal(parsePairQr(url).recoverySecret, secret);
  assert.equal(parsePairQr('https://student.test/?apiBase=https%3A%2F%2Fapi.test&pairCode=123456#credentialTicket=opaque').credentialTicket, 'opaque');
  assert.throws(() => parsePairQr(url.replace('https%3A', 'http%3A')));
});
test('initial identity materials obtain a scoped ticket before either upload, and submit owned object paths', async () => {
  const h = harness((options, upload) => ({ ok: true, data: upload ? { stored: { objectPath: options.formData.channel + '/owned.jpg', url: 'https://public.invalid/never-use' } } : options.url.endsWith('material-upload-ticket') ? { uploadTicket: 'audit-upload-proof' } : { id: 'login-1', candidateId: 'c1', sessionId: 's1', miniProgramSessionToken: 'audit-token' } }));
  h.load('pages/login/index.js'); const page = h.page(); Object.assign(page.data, { exams: [{ id: 'e1', examCode: '1234567890' }], examIndex: 0, pairCode: '123456', identityPhotoPath: '/photo', roomVideoPath: '/video', name: 'Test', school: 'School', college: 'College', studentId: '1', examNumber: '1', password: 'audit-password' });
  await page.submitLoginRequest(); assert.equal(h.calls.length, 4); assert.match(h.calls[0].url, /material-upload-ticket$/);
  for (const call of h.calls.slice(1, 3)) assert.equal(call.header['x-proctor-upload-ticket'], 'audit-upload-proof');
  assert.equal(h.calls[3].data.uploadTicket, 'audit-upload-proof'); assert.equal(h.calls[3].data.identityPhotoPath, 'IDENTITY_PHOTO/owned.jpg'); assert.equal(h.storage.get('miniProgramSessionToken'), 'audit-token');
});
test('environment video capture rejects durations outside 3–15 seconds and accepts both endpoints', () => {
  const h = harness(); h.load('pages/login/index.js');
  h.wx.chooseMedia = options => { h.wx.media = options; };
  const page = h.page(); page.recordRoomVideo();
  assert.equal(h.wx.media.maxDuration, 15);
  for (const duration of [2.9, 15.1, NaN]) {
    h.wx.media.success({ tempFiles: [{ tempFilePath: '/invalid', duration }] });
    assert.equal(page.data.roomVideoPath, '');
  }
  for (const duration of [3, 15]) {
    h.wx.media.success({ tempFiles: [{ tempFilePath: `/valid-${duration}`, duration }] });
    assert.equal(page.data.roomVideoPath, `/valid-${duration}`);
  }
});
test('recovery scans submit the strong recovery proof and bind the returned token to its server', async () => {
  const h = harness(() => ({ ok: true, data: { session: { id: 's2' }, miniProgramSessionToken: 'new-token' } }));
  h.load('pages/login/index.js'); h.page().scanPairQr(); const secret = 'x'.repeat(43);
  await h.wx.scan.success({ result: 'https://student.test/?apiBase=https%3A%2F%2Fapi.test&pairCode=123456&recoverySecret=' + secret });
  assert.equal(h.calls[0].data.recoverySecret, secret); assert.equal(h.calls[0].data.deviceId, 'test-phone'); assert.equal(h.storage.get('sessionServerOrigin'), 'https://api.test');
});
test('unsupported WeChat RTMPS never starts a plaintext pusher or claims a live camera, and exposes HTTPS fallback', async () => {
  const h = harness(() => ({ ok: true, data: { session: { id: 's1', status: 'IN_EXAM' } } })); h.api.saveSession('s1', 'audit-token');
  h.load('pages/monitor/index.js'); const page = h.page(); page.data.sessionId = 's1'; page.data.deviceId = 'test-phone';
  await page.sendHeartbeat(); assert.equal(h.calls[0].data.capture.mobileCameraOk, false); assert.equal(page.data.rtmpUrl, '');
  page.openSecureWeb(); assert.match(h.notices[0].data, /^https:\/\//); assert.equal(h.notices[0].data.includes('audit-token'), false);
});
