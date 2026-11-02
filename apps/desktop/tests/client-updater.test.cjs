const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { ClientUpdater, trustedUpdateOrigin, updaterTarget, validateUpdateFile } = require('../dist/main/client-updater');
const { submitContextAllows } = require('../dist/main/novajudge-submit');
const file = { url: '/api/desktop/releases/files/00000000-0000-4000-8000-000000000000.exe', sha512: Buffer.alloc(64, 1).toString('base64'), size: 4096 };
const release = { channel: 'public', installationMode: 'manual', target: 'windows', version: '0.1.21', notes: '<b>plain text</b>', update: file, feedUrl: '/api/desktop/updates/public/windows/' };
function fixture(options = {}) {
  const events = [], calls = []; let manifestCalls = 0;
  const native = new EventEmitter();
  native.checkForUpdates = async () => { calls.push('native-check'); return { isUpdateAvailable: true, updateInfo: { version: release.version, files: [file] } }; };
  native.downloadUpdate = async () => { calls.push('download'); native.emit('download-progress', { percent: 55 }); };
  native.quitAndInstall = (...args) => calls.push(['install', ...args]);
  const dependencies = { version: '0.1.20', platform: 'win32', arch: 'x64', packaged: true, channel: 'public', origin: 'https://proctor.example.org',
    createUpdater: feed => { calls.push(feed); return native; }, beforeInstall: () => true, changed: status => events.push(status),
    readManifest: async () => { manifestCalls++; return { ok: true, data: [release] }; }, ...options };
  return { updater: new ClientUpdater(dependencies), native, calls, events, manifestCalls: () => manifestCalls };
}
test('packaged updater only trusts a HTTPS origin and platform-specific immutable update file', () => {
  for (const value of ['http://localhost:4031', 'https://user:password@proctor.example.org', 'https://proctor.example.org/path', 'https://proctor.example.org/?token=abc']) assert.throws(() => trustedUpdateOrigin(value, true));
  assert.equal(trustedUpdateOrigin('https://proctor.example.org', true), 'https://proctor.example.org');
  assert.equal(trustedUpdateOrigin('http://localhost:4031', false), 'http://localhost:4031');
  assert.equal(updaterTarget('darwin', 'arm64'), 'mac-arm64'); assert.equal(updaterTarget('win32', 'ia32'), 'windows'); assert.equal(updaterTarget('linux', 'x64'), null);
  for (const bad of [{ ...file, url: 'https://other.example.org/api/desktop/releases/files/00000000-0000-4000-8000-000000000000.exe' }, { ...file, url: 'file:///tmp/a.exe' }, { ...file, url: file.url + '?token=private' }, { ...file, sha512: 'bad' }, { ...file, size: undefined }]) assert.throws(() => validateUpdateFile(bad, 'https://proctor.example.org', 'exe'));
});
test('version check remains mandatory on failure, unpublished platform, mismatch and even a newer unapproved local version', async () => {
  for (const version of ['0.1.20', '0.1.22']) {
    const f = fixture({ version }); assert.equal((await f.updater.check()).phase, 'available'); assert.equal(f.updater.isCurrent(), false);
  }
  const current = fixture({ version: release.version }); assert.equal((await current.updater.check()).required, false); assert.equal(current.updater.isCurrent(), true);
  for (const readManifest of [async () => { throw new Error('offline'); }, async () => ({ ok: true, data: [] }), async () => ({ ok: true, data: [{ ...release, version: 'garbage' }] })]) {
    const f = fixture({ readManifest }); assert.equal((await f.updater.check()).phase, 'error'); assert.equal(f.updater.status.required, true); assert.equal(f.updater.isCurrent(), false);
  }
});
test('startup is checked once and remains current throughout the same app process', async (t) => {
  const f = fixture({ version: release.version });
  await Promise.all([f.updater.checkOnStartup(), f.updater.checkOnStartup()]);
  assert.equal(f.manifestCalls(), 1);
  const later = Date.now() + 24 * 60 * 60_000;
  t.mock.method(Date, 'now', () => later);
  for (let click = 0; click < 5; click++) {
    assert.equal((await f.updater.checkOnStartup()).required, false);
    assert.equal(f.updater.isCurrent(), true);
  }
  assert.equal(f.manifestCalls(), 1);
  const relaunched = fixture({ version: release.version });
  await relaunched.updater.checkOnStartup();
  assert.equal(relaunched.manifestCalls(), 1);
});
test('startup failures stay blocked without automatic retries, while an explicit retry updates the cached status', async () => {
  let requests = 0;
  const f = fixture({ version: release.version, readManifest: async () => {
    if (++requests === 1) throw new Error('offline');
    return { ok: true, data: [release] };
  } });
  assert.equal((await f.updater.checkOnStartup()).phase, 'error');
  assert.equal((await f.updater.checkOnStartup()).required, true);
  assert.equal(requests, 1);
  await f.updater.check();
  assert.equal((await f.updater.checkOnStartup()).phase, 'current');
  assert.equal(requests, 2);
});
test('renderer login and verification gates read cached status; only explicit retry invokes the version service', async () => {
  const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
  const start = source.indexOf('async function ensureLatestClient(');
  const end = source.indexOf('\nfunction warnCandidate(', start);
  let checks = 0, reads = 0;
  const state = { clientUpdate: { required: false } };
  const context = vm.createContext({ state, errorMessage: error => error.message,
    renderClientUpdate: status => { state.clientUpdate = status; },
    window: { proctorApi: {
      getClientUpdateStatus: async () => { reads++; return { phase: 'current', required: false }; },
      checkClientUpdate: async () => { checks++; return { phase: 'current', required: false }; },
    } },
  });
  vm.runInContext(source.slice(start, end), context);
  for (let click = 0; click < 5; click++) assert.equal(await context.ensureLatestClient(), true);
  assert.equal(checks, 0); assert.equal(reads, 5);
  await context.ensureLatestClient(true);
  assert.equal(checks, 1);
});
test('concurrent checks and update clicks share one operation; download validates feed before opening the interactive installer', async () => {
  const f = fixture();
  await Promise.all([f.updater.check(), f.updater.check()]); assert.equal(f.manifestCalls(), 1);
  await Promise.all([f.updater.download(), f.updater.download()]);
  assert.equal(f.calls.filter(item => item === 'download').length, 1);
  assert.deepEqual(f.calls.at(-1), ['install', false, true]);
  assert.equal(f.native.autoDownload, false); assert.equal(f.native.autoInstallOnAppQuit, false);
  assert.equal(f.native.disableDifferentialDownload, true);
  assert(f.events.some(event => event.phase === 'downloading' && event.percent === 55));
  assert.equal(f.updater.status.phase, 'installing');
});
test('an exam or broadcast blocks installation; rejected checksums or swapped feeds never install', async () => {
  const busy = fixture({ beforeInstall: () => false }); await assert.rejects(busy.updater.download(), /结束当前考试/); assert(!busy.calls.includes('download'));
  const switched = fixture(); switched.native.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: release.version, files: [{ ...file, sha512: Buffer.alloc(64, 2).toString('base64') }] } });
  await assert.rejects(switched.updater.download(), /更新信息已变化/); assert(!switched.calls.includes('download'));
  const corrupt = fixture(); corrupt.native.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  await assert.rejects(corrupt.updater.download(), /checksum/); assert.equal(corrupt.updater.status.required, true); assert(!corrupt.calls.some(item => Array.isArray(item) && item[0] === 'install'));
});
test('asynchronous native signing failure after download cannot leave a false completed state', async () => {
  const f = fixture(); await f.updater.download(); f.native.emit('error', new Error('native signature invalid'));
  assert.equal(f.updater.status.phase, 'error'); assert.equal(f.updater.status.required, true);
});
test('only development execution bypasses installation; packaged builds never use this exemption', async () => {
  const f = fixture({ packaged: false }); assert.equal((await f.updater.check()).required, false); assert.equal(f.manifestCalls(), 0);
  const p = fixture({ packaged: true, channel: 'public', origin: 'http://localhost:4031' }); assert.equal((await p.updater.check()).required, true);
});

test('development selects the configured trusted backend for intranet submit without checking releases', async () => {
  for (const origin of ['http://localhost:4031', 'http://127.0.0.1:4031', 'http://[::1]:4031', 'https://proctor.example.org']) {
    const f = fixture({ packaged: false, origin, channel: 'intranet' });
    const status = await f.updater.checkOnStartup();
    assert.equal(status.phase, 'current'); assert.equal(status.required, false);
    assert.equal(status.serverOrigin, origin); assert.equal(status.releaseChannel, 'intranet');
    assert.equal(f.manifestCalls(), 0); assert.deepEqual(f.calls, []);
    assert(f.events.some(event => event.serverOrigin === origin && event.releaseChannel === 'intranet'));
    const login = { backendOrigin: origin, scope: { origin: 'http://127.0.0.1:3001', contestId: '2' }, proctoringKey: 'same-monitor-key' };
    const context = { platform: 'win32', backendOrigin: origin, scope: login.scope, proctoringKey: login.proctoringKey,
      selectedBackendOrigin: status.serverOrigin, releaseChannel: status.releaseChannel };
    assert.equal(submitContextAllows(context, login), true);
  }
  const publicClient = fixture({ packaged: false, origin: 'http://localhost:4031', channel: 'public' });
  const status = await publicClient.updater.check();
  const login = { backendOrigin: status.serverOrigin, scope: { origin: 'http://127.0.0.1:3001', contestId: '2' }, proctoringKey: 'same-monitor-key' };
  assert.equal(status.releaseChannel, 'public');
  assert.equal(submitContextAllows({ platform: 'win32', backendOrigin: login.backendOrigin, scope: login.scope,
    proctoringKey: login.proctoringKey, selectedBackendOrigin: status.serverOrigin, releaseChannel: status.releaseChannel }, login), false);
});

test('development rejects untrusted or non-origin backend addresses before enabling login', async () => {
  for (const origin of ['http://192.168.50.30:4031', 'https://user:password@proctor.example.org',
    'https://proctor.example.org/path', 'https://proctor.example.org/?token=abc', 'file:///tmp/proctor']) {
    const f = fixture({ packaged: false, origin, channel: 'intranet' });
    const status = await f.updater.check();
    assert.equal(status.phase, 'error', origin); assert.equal(status.required, true);
    assert.equal(f.updater.isCurrent(), false); assert.equal(status.serverOrigin, undefined);
    assert.equal(status.releaseChannel, undefined); assert.equal(f.manifestCalls(), 0);
  }
});
test('intranet clients check and download only their intranet channel from the bound backend origin', async () => {
  const internal = { ...release, channel: 'intranet', feedUrl: '/api/desktop/updates/intranet/windows/' };
  const requests = [];
  const f = fixture({ origin: 'https://proctoring.example.test', channel: 'intranet', readManifest: async url => { requests.push(url); return { ok: true, data: [release, internal] }; } });
  await f.updater.download();
  assert.equal(requests[0], 'https://proctoring.example.test/api/desktop/releases?channel=intranet');
  assert(f.calls.includes('https://proctoring.example.test/api/desktop/updates/intranet/windows/'));
  const wrong = fixture({ channel: 'intranet' }); assert.equal((await wrong.updater.check()).phase, 'error');
});
test('Mac downloads the validated DMG for manual replacement and never uses native automatic installation', async () => {
  const dmg = { ...file, url: file.url.replace('.exe', '.dmg') };
  const mac = { ...release, target: 'mac-arm64', update: dmg, feedUrl: '/api/desktop/updates/public/mac-arm64/' };
  const opened = [];
  const f = fixture({ platform: 'darwin', arch: 'arm64', readManifest: async () => ({ ok: true, data: [mac] }), installManually: async (asset, origin, progress) => { opened.push({ asset, origin }); progress(100); } });
  await f.updater.download(); assert.deepEqual(opened, [{ asset: dmg, origin: 'https://proctor.example.org' }]); assert.deepEqual(f.calls, []);
  assert.equal(f.updater.status.phase, 'installing'); assert.equal(f.updater.status.required, true);
  const invalid = fixture({ platform: 'darwin', arch: 'arm64', readManifest: async () => ({ ok: true, data: [{ ...mac, update: file }] }) });
  assert.equal((await invalid.updater.check()).phase, 'error');
});

const backends = [
  { origin: 'https://proctoring.example.test', channel: 'intranet' },
  { origin: 'https://proctoring.example.org', channel: 'public' },
];
const internalRelease = { ...release, channel: 'intranet', feedUrl: '/api/desktop/updates/intranet/windows/' };
test('unified client selects intranet without requesting the Internet, and falls back on connection or invalid response failures', async () => {
  for (const failure of [null, new Error('DNS unavailable'), { ok: false }, { ok: true, data: 'invalid' }]) {
    const requests = [];
    const f = fixture({ backends, readManifest: async (url, timeout) => {
      requests.push([url, timeout]);
      if (new URL(url).origin === backends[0].origin) {
        if (failure instanceof Error) throw failure;
        return failure || { ok: true, data: [internalRelease] };
      }
      return { ok: true, data: [release] };
    } });
    await f.updater.download();
    const selected = failure ? backends[1] : backends[0];
    assert.equal(f.updater.status.serverOrigin, selected.origin);
    assert.equal(f.updater.status.releaseChannel, selected.channel);
    assert.equal(requests.length, failure ? 2 : 1);
    assert.equal(requests[0][1], 5000);
    if (failure) assert.equal(requests[1][1], 10_000);
    assert(f.calls.includes(selected.origin + `/api/desktop/updates/${selected.channel}/windows/`));
  }
});
test('unified client blocks login when both backends fail, and does not bypass a reachable backend with an unpublished or invalid package', async () => {
  const offline = fixture({ backends, readManifest: async () => { throw new Error('offline'); } });
  assert.equal((await offline.updater.check()).phase, 'error');
  assert.match(offline.updater.status.message, /内网和公网/); assert.equal(offline.updater.isCurrent(), false);
  for (const data of [[], [{ ...internalRelease, update: { ...file, url: backends[1].origin + file.url } }]]) {
    const requests = [];
    const f = fixture({ backends, readManifest: async url => { requests.push(url); return { ok: true, data }; } });
    assert.equal((await f.updater.check()).phase, 'error');
    assert.equal(requests.length, 1); assert.equal(f.updater.isCurrent(), false);
  }
});
test('backend changes discard the previous native updater and ignore its late download or error events', async () => {
  let intranetAvailable = true;
  const natives = [], feeds = [];
  const f = fixture({ backends, readManifest: async url => {
    if (new URL(url).origin === backends[0].origin && !intranetAvailable) throw new Error('offline');
    return { ok: true, data: [new URL(url).origin === backends[0].origin ? internalRelease : release] };
  }, createUpdater: feed => {
    feeds.push(feed); const native = new EventEmitter(); natives.push(native);
    native.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: release.version, files: [file] } });
    native.downloadUpdate = async () => {}; native.quitAndInstall = () => {};
    return native;
  } });
  await f.updater.download(); intranetAvailable = false;
  await f.updater.download();
  assert.deepEqual(feeds, [backends[0].origin + internalRelease.feedUrl, backends[1].origin + release.feedUrl]);
  natives[0].emit('error', new Error('old connection')); natives[0].emit('download-progress', { percent: 1 });
  assert.equal(f.updater.status.phase, 'installing'); assert.equal(f.updater.status.percent, 100);
});
