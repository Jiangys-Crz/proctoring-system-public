const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { NovaJudgeSubmit, SubmitConfigStore, submitServiceError } = require('../dist/main/novajudge-submit');

const now = Date.now();
const scope = { origin: 'https://judge.test', contestId: '2' };
const key = 'p'.repeat(43);
const jwt = (overrides = {}) => [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({
  username: 'team0001', role: 'TEAM', contestId: 2, loginSource: 'PROCTORING',
  proctoringKeyHash: crypto.createHash('sha256').update(key).digest('hex'), exp: Math.floor(now / 1000) + 3600,
  ...overrides,
})).toString('base64url'), 'signature'].join('.');
const grant = (overrides = {}) => ({ deviceToken: 'njcli_' + 'a'.repeat(43), loginSource: 'PROCTORING',
  contest: { id: 2, title: 'Test contest' }, user: { username: 'team0001', displayName: 'Team 1' },
  expiresAt: new Date(now + 1800000).toISOString(), ...overrides });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nova submit desktop '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const context = { platform: process.platform === 'win32' ? 'win32' : 'darwin', releaseChannel: 'intranet', selectedBackendOrigin: 'https://monitor.test',
    backendOrigin: 'https://monitor.test', scope, proctoringKey: key };
  const login = { scope, backendOrigin: 'https://monitor.test', cookieToken: jwt(), proctoringKey: key, contestAccessToken: 'private-contest-token' };
  const calls = [], installs = [], statuses = [];
  const manager = new NovaJudgeSubmit({ home, bundleDirectory: '/unused', now: () => now,
    context: () => context, changed: value => statuses.push(value),
    request: async (origin, method, headers) => { calls.push({ origin, method, headers }); return method === 'POST' ? grant() : null; },
    install: async (origin, signal) => { installs.push({ origin, signal }); }, ...overrides });
  return { manager, context, login, home, calls, installs, statuses, filename: path.join(home, '.novajudge-submit.json') };
}

test('only macOS or Windows with an actual matching intranet selection may install or issue', async t => {
  for (const patch of [
    { releaseChannel: 'public' }, { releaseChannel: 'unified' }, { releaseChannel: undefined },
    { platform: 'linux' }, { selectedBackendOrigin: 'https://other.test' },
    { backendOrigin: 'https://other.test' }, { scope: { ...scope, origin: 'https://other.test' } },
    { scope: { ...scope, contestId: '3' } }, { proctoringKey: 'q'.repeat(43) },
  ]) {
    const h = fixture(t); Object.assign(h.context, patch); await h.manager.connect(h.login);
    assert.equal(h.calls.length, 0, JSON.stringify(patch)); assert.equal(h.installs.length, 0);
    assert.equal(fs.existsSync(h.filename), false); assert.equal(h.manager.status.phase, 'idle');
  }
});

test('valid login installs offline and atomically saves only the scoped device token at 0600', async t => {
  const h = fixture(t); await h.manager.connect(h.login);
  assert.equal(h.manager.status.phase, 'ready'); assert.equal(h.installs.length, 1);
  assert.equal(h.calls[0].origin, scope.origin); assert.equal(h.calls[0].method, 'POST');
  assert.deepEqual(h.calls[0].headers, { Authorization: `Bearer ${h.login.cookieToken}`, 'x-novajudge-proctor-key': key, 'x-contest-access-token': 'private-contest-token' });
  const raw = fs.readFileSync(h.filename, 'utf8'), config = JSON.parse(raw);
  assert.equal(config.baseUrl, scope.origin); assert.equal(config.loginSource, 'PROCTORING');
  assert.equal(config.managedBy, 'novajudge-proctor-desktop'); assert.ok(config.managedInstance);
  assert.equal(config.contest.id, 2); assert.equal(config.user.username, 'team0001');
  if (process.platform === 'win32') {
    const script = `$Acl = [IO.File]::GetAccessControl($env:NOVAJUDGE_CONFIG_FILE); [Console]::Write(($Acl.AreAccessRulesProtected -and $Acl.Access.Count -eq 1 -and $Acl.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value))`;
    const checked = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, NOVAJUDGE_CONFIG_FILE: h.filename }, windowsHide: true, encoding: 'utf8',
    });
    assert.equal(checked.status, 0, checked.stderr); assert.equal(checked.stdout, 'True');
  } else assert.equal(fs.statSync(h.filename).mode & 0o777, 0o600);
  assert.equal(raw.includes(h.login.cookieToken), false); assert.equal(raw.includes(key), false); assert.equal(raw.includes('private-contest-token'), false);
  await h.manager.reset(); assert.equal(fs.existsSync(h.filename), false);
  assert.deepEqual(h.calls[1], { origin: scope.origin, method: 'DELETE', headers: { Authorization: `Bearer ${grant().deviceToken}` } });
});

test('wrong login identity is rejected before issuing; mismatched grants are revoked before installation', async t => {
  for (const claims of [{ contestId: 3 }, { role: 'GLOBAL' }, { loginSource: 'BROWSER' }, { exp: 1 }, { proctoringKeyHash: 'wrong' }]) {
    const h = fixture(t); h.login.cookieToken = jwt(claims); await h.manager.connect(h.login);
    assert.equal(h.manager.status.phase, 'error'); assert.equal(h.calls.length, 0); assert.equal(h.installs.length, 0);
  }
  for (const patch of [{ contest: { id: 3, title: 'Wrong' } }, { user: { username: 'team0002', displayName: null } },
    { loginSource: 'BROWSER' }, { expiresAt: new Date(now + 7200000).toISOString() }, { expiresAt: 'invalid' }]) {
    const calls = [];
    const h = fixture(t, { request: async (origin, method) => { calls.push({ origin, method }); return method === 'POST' ? grant(patch) : null; } });
    await h.manager.connect(h.login);
    assert.equal(h.manager.status.phase, 'error'); assert.equal(h.installs.length, 0); assert.equal(fs.existsSync(h.filename), false);
    assert.deepEqual(calls.map(c => c.method), ['POST', 'DELETE']); assert.equal(calls[1].origin, scope.origin);
  }
});

test('issuance, installation and config failures leave web login independent and revoke minted tokens', async t => {
  const requestFailure = fixture(t, { request: async () => { throw Error('offline'); } });
  await requestFailure.manager.connect(requestFailure.login);
  assert.equal(requestFailure.manager.status.phase, 'error'); assert.equal(requestFailure.installs.length, 0);
  const installFailure = fixture(t, { install: async () => { throw Error('read-only installation'); } });
  await installFailure.manager.connect(installFailure.login);
  assert.equal(installFailure.manager.status.phase, 'error'); assert.deepEqual(installFailure.calls.map(c => c.method), ['POST', 'DELETE']);
  assert.equal(fs.existsSync(installFailure.filename), false);
  const configFailure = fixture(t); fs.mkdirSync(configFailure.filename);
  await configFailure.manager.connect(configFailure.login);
  assert.equal(configFailure.manager.status.phase, 'error'); assert.deepEqual(configFailure.calls.map(c => c.method), ['POST', 'DELETE']);
});

test('admin contest selection errors show an actionable message without exposing server content', async t => {
  for (const code of ['CLI_DISABLED', 'CONTEST_CHANGED']) {
    const h = fixture(t, { request: async () => { throw submitServiceError(409, { code, error: 'untrusted secret content' }); } });
    await h.manager.connect(h.login);
    assert.match(h.manager.status.message, /请管理员/); assert.equal(h.manager.status.message.includes('untrusted'), false);
    assert.equal(h.installs.length, 0);
  }
});

test('logout during issuance revokes the late grant without reinstalling or restoring credentials', async t => {
  const issued = deferred(), started = deferred(), calls = [];
  const h = fixture(t, { request: async (origin, method, headers) => { calls.push({ origin, method, headers });
    if (method === 'POST') { started.resolve(); return issued.promise; } return null; } });
  const pending = h.manager.connect(h.login); await started.promise;
  await h.manager.reset(); issued.resolve(grant()); await pending;
  assert.equal(h.manager.status.phase, 'idle'); assert.equal(h.installs.length, 0); assert.equal(fs.existsSync(h.filename), false);
  assert.deepEqual(calls.map(c => c.method), ['POST', 'DELETE']);
});

test('a late old session cannot overwrite or remove a newer session configuration', async t => {
  const old = deferred(), started = deferred(); let count = 0; const revoked = [];
  const h = fixture(t, { request: async (_origin, method, headers) => {
    if (method === 'DELETE') { revoked.push(headers.Authorization); return null; }
    if (++count === 1) { started.resolve(); return old.promise; }
    return grant({ deviceToken: 'njcli_' + 'b'.repeat(43) });
  } });
  const previous = h.manager.connect(h.login); await started.promise;
  await h.manager.connect(h.login); old.resolve(grant()); await previous;
  assert.equal(JSON.parse(fs.readFileSync(h.filename, 'utf8')).deviceToken, 'njcli_' + 'b'.repeat(43));
  assert.equal(h.manager.status.phase, 'ready'); assert.deepEqual(revoked, [`Bearer ${grant().deviceToken}`]);
});

test('backend changes abort pending installation and revoke instead of writing after switching public', async t => {
  const started = deferred(); let aborted = false;
  const h = fixture(t, { install: (_origin, signal) => new Promise((_resolve, reject) => {
    started.resolve(); signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); });
  }) });
  const pending = h.manager.connect(h.login); await started.promise;
  h.context.releaseChannel = 'public'; h.manager.refreshEligibility(); await pending;
  assert.equal(aborted, true); assert.equal(h.manager.status.phase, 'idle'); assert.equal(fs.existsSync(h.filename), false);
  assert.deepEqual(h.calls.map(c => c.method), ['POST', 'DELETE']);
});

test('cleanup only removes its exact owned token, preserving user or newer process logins', async t => {
  for (const replacement of [{ deviceToken: 'manual-browser-token', baseUrl: scope.origin },
    { ...grant({ deviceToken: 'njcli_' + 'b'.repeat(43) }), baseUrl: scope.origin, managedBy: 'novajudge-proctor-desktop', managedInstance: 'new-process' }]) {
    const h = fixture(t); await h.manager.connect(h.login);
    fs.writeFileSync(h.filename, JSON.stringify(replacement)); await h.manager.reset();
    assert.deepEqual(JSON.parse(fs.readFileSync(h.filename, 'utf8')), replacement);
    assert.equal(h.calls.at(-1).headers.Authorization, `Bearer ${grant().deviceToken}`);
  }
});

test('startup in public clears and revokes stale owned intranet tokens, while ordinary config is untouched', async t => {
  const h = fixture(t); h.context.releaseChannel = 'public';
  const store = new SubmitConfigStore(h.home);
  store.write({ ...grant(), baseUrl: scope.origin, managedBy: 'novajudge-proctor-desktop', managedInstance: 'crashed-process' });
  await h.manager.initialize();
  assert.equal(fs.existsSync(h.filename), false); assert.equal(h.installs.length, 0);
  assert.deepEqual(h.calls.map(c => c.method), ['DELETE']);
  const ordinary = fixture(t); ordinary.context.releaseChannel = 'public';
  fs.writeFileSync(ordinary.filename, JSON.stringify({ ...grant(), baseUrl: scope.origin }));
  await ordinary.manager.initialize(); assert.equal(fs.existsSync(ordinary.filename), true); assert.equal(ordinary.calls.length, 0);
});

test('shutdown waits for both prior cleanup and late in-flight grant revocation', async t => {
  const revoked = deferred(), revokeStarted = deferred();
  const h = fixture(t, { request: async (_origin, method) => {
    if (method === 'POST') return grant(); revokeStarted.resolve(); return revoked.promise;
  } });
  await h.manager.connect(h.login); void h.manager.reset(); await revokeStarted.promise;
  let finished = false; const shutdown = h.manager.shutdown().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(fs.existsSync(h.filename), false);
  revoked.resolve(null); await shutdown; assert.equal(finished, true);
});

test('bundled installer works offline with macOS system tools and a home directory containing spaces', { skip: process.platform !== 'darwin' }, t => {
  const h = fixture(t);
  const directory = path.resolve(__dirname, '../resources/novajudge-submit');
  const env = { ...process.env, HOME: h.home, ZDOTDIR: h.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const result = spawnSync('/bin/bash', [path.join(directory, 'install-macos.sh'), '--url', 'http://127.0.0.1:1', '--source', path.join(directory, 'submit-macos')], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Installing bundled submit/);
  const help = spawnSync(path.join(h.home, '.local/bin/submit'), ['--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /submit/);
  const printHelp = spawnSync(path.join(h.home, '.local/bin/printfile'), ['--help'], { env, encoding: 'utf8' });
  assert.equal(printHelp.status, 0, printHelp.stderr); assert.match(printHelp.stdout, /printfile/);
  assert.equal(fs.existsSync(h.filename), false, 'installer never invents login credentials');
});

test('Windows manager installs the bundled client offline in a Chinese path, keeps PATH isolated and cleans its grant', { skip: process.platform !== 'win32' }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), '监考 submit 中文 '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const h = fixture(t, { home, install: undefined,
    bundleDirectory: path.resolve(__dirname, '../resources/novajudge-submit'),
    windowsInstallation: { localAppData: home, updatePath: false } });
  await h.manager.connect(h.login);
  assert.equal(h.manager.status.phase, 'ready', h.manager.status.message);
  const directory = path.join(home, 'NovaJudge/submit');
  assert(fs.existsSync(path.join(directory, 'submit.cmd')));
  assert(fs.existsSync(path.join(directory, 'printfile.cmd')));
  assert(fs.existsSync(path.join(directory, 'novajudge-submit.ps1')));
  const help = spawnSync('powershell.exe', ['-NoProfile', '-Command', '& $env:NOVAJUDGE_SUBMIT_COMMAND --help'], {
    env: { ...process.env, USERPROFILE: home, NOVAJUDGE_SUBMIT_COMMAND: path.join(directory, 'submit.cmd') },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /native Windows client/);
  const configFile = path.join(home, '.novajudge-submit.json');
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).loginSource, 'PROCTORING');
  h.context.releaseChannel = 'public';
  h.manager.refreshEligibility(); await h.manager.shutdown();
  assert.equal(fs.existsSync(configFile), false);
  assert.deepEqual(h.calls.map(call => call.method), ['POST', 'DELETE']);
  fs.writeFileSync(path.join(home, 'source.cpp'), 'int main() { return 0; }\n');
  const printedAfterLogout = spawnSync('powershell.exe', ['-NoProfile', '-Command', '& $env:NOVAJUDGE_PRINT_COMMAND source.cpp y; exit $LASTEXITCODE'], {
    env: { ...process.env, USERPROFILE: home, NOVAJUDGE_PRINT_COMMAND: path.join(directory, 'printfile.cmd') },
    cwd: home, encoding: 'utf8', windowsHide: true,
  });
  assert.notEqual(printedAfterLogout.status, 0);
  assert.match(printedAfterLogout.stderr, /monitoring.client/i);
  assert.doesNotMatch(printedAfterLogout.stdout, /int main/);
});

test('Windows preparation rejects a home belonging to another user and does not carry secrets in errors', { skip: process.platform !== 'win32' }, () => {
  const { assertWindowsSubmitUser } = require('../dist/main/novajudge-submit-windows');
  assert.throws(() => assertWindowsSubmitUser(path.join(os.tmpdir(), 'different-user')), error => error.code === 'WINDOWS_USER_MISMATCH');
});

test('Electron grant transport uses system trust, scoped URLs, no session cookies and rejects redirects', async () => {
  const requests = [], partitions = [];
  class FakeRequest extends EventEmitter {
    constructor(options) { super(); this.options = options; this.headers = {}; this.aborted = false; }
    setHeader(name, value) { this.headers[name] = value; }
    end(body) { this.body = body; }
    abort() { this.aborted = true; }
  }
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/main/novajudge-submit-network'), 'utf8'), {
    exports, URL, Buffer, setTimeout, clearTimeout,
    require: name => {
      if (name === './novajudge-submit') return { submitServiceError };
      assert.equal(name, 'electron');
      return { net: { request: options => { const req = new FakeRequest(options); requests.push(req); return req; } },
        session: { fromPartition: name => { partitions.push(name); return { isolated: true }; } } };
    },
  });
  const pending = exports.requestNovaJudgeSubmit(scope.origin, 'POST', { Authorization: 'Bearer private-jwt', 'x-novajudge-proctor-key': key });
  assert.equal(requests[0].options.url, `${scope.origin}/api/cli/device/proctoring`);
  assert.equal(requests[0].options.redirect, 'error'); assert.equal(requests[0].options.useSessionCookies, false);
  assert.deepEqual(partitions, ['novajudge-submit']); assert.equal(requests[0].body, '{}');
  assert.equal(requests[0].headers.Authorization, 'Bearer private-jwt');
  requests[0].emit('redirect', 302, 'GET', 'https://evil.test', {});
  await assert.rejects(pending, /跳转/); assert.equal(requests.length, 1); assert.equal(requests[0].aborted, true);
  await assert.rejects(exports.requestNovaJudgeSubmit('https://judge.test/other', 'POST', {}), /地址无效/);
  assert.equal(requests.length, 1);
});
