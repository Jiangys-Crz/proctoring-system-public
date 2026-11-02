const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
const start = source.indexOf('function contestWebsiteOrigin()');
const end = source.indexOf('function mediaRtmpBase()', start);

function mobileApi({ server = 'http://localhost:4031', page = '', publicApi = '', student = '' } = {}) {
  const context = vm.createContext({
    URL,
    state: { serverUrl: server },
    window: {
      PROCTOR_CLIENT_WEB_URL: student,
      PROCTOR_MOBILE_WEB_URL: page,
      PROCTOR_PUBLIC_API_URL: publicApi,
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return context.mobileApiBase();
}

function mobilePage(server, student = '') {
  const context = vm.createContext({ URL, state: { serverUrl: server }, window: { PROCTOR_CLIENT_WEB_URL: student } });
  vm.runInContext(source.slice(start, end), context);
  return context.mobileWebsiteUrl();
}
test('both networks use their student domain while older and development deployments remain usable', () => {
  assert.equal(mobilePage('https://proctoring.example.test'), 'https://proctorstu.example.test/');
  assert.equal(mobilePage('https://legacy-proctor.example.test'), 'https://legacy-proctor.example.test/candidate');
  assert.equal(mobilePage('https://proctoring.example.org'), 'https://proctorstu.example.org/');
  assert.equal(mobilePage('http://127.0.0.1:4031'), 'http://127.0.0.1:4032/');
  assert.equal(mobilePage('https://legacy-proctor.example.test', 'https://students.example.test'), 'https://students.example.test/');
});

test('student QR requests still authenticate to the selected backend domain', () => {
  assert.equal(mobileApi({ server: 'https://proctoring.example.test' }), 'https://proctoring.example.test');
  assert.equal(mobileApi({ server: 'https://proctoring.example.org' }), 'https://proctoring.example.org');
});

test('HTTP student page keeps reconnect requests on the backend port', () => {
  assert.equal(mobileApi({ server: 'http://192.168.50.10:4031' }), 'http://192.168.50.10:4031');
  assert.equal(mobileApi({ page: 'http://192.168.50.10:4032' }), 'http://192.168.50.10:4031');
});

test('HTTPS mobile proxy uses its explicitly configured public API', () => {
  assert.equal(mobileApi({ page: 'https://192.168.50.10:3443', publicApi: 'https://192.168.50.10:3443/' }), 'https://192.168.50.10:3443');
});

test('independent HTTPS student and backend domains remain independent', () => {
  assert.equal(mobileApi({ page: 'https://student.example.test', publicApi: 'https://api.example.test/backend/' }), 'https://api.example.test/backend');
});

test('custom backend ports remain intact', () => {
  assert.equal(mobileApi({ page: 'http://student.example.test:4032', publicApi: 'http://api.example.test:9000' }), 'http://api.example.test:9000');
});

test('HTTPS student entry with an HTTP backend reports configuration error', () => {
  assert.throws(() => mobileApi({ page: 'https://student.example.test' }), /HTTPS 后台地址/);
});

test('invalid public API protocol is rejected', () => {
  assert.throws(() => mobileApi({ page: 'http://student.example.test', publicApi: 'file:///tmp/api' }), /监考后台地址/);
});
