const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ensureWindowsAdministrator, relaunchWindowsAdministrator } = require('../dist/main/windows-admin-startup');
const { launchWindowsElevated, quoteWindowsArgument } = require('../dist/main/windows-elevation');

function runtime() {
  const calls = [];
  return { calls, isPackaged: true, getAppPath: () => 'C:\\监考软件', getVersion: () => '0.1.32',
    getPath: () => { throw new Error('test logging disabled'); },
    releaseSingleInstanceLock: () => calls.push('release'),
    requestSingleInstanceLock: () => { calls.push('acquire'); return true; } };
}

test('an actual elevated token starts without prompting, regardless of the account name', async () => {
  assert.equal(await ensureWindowsAdministrator(runtime(), { showMessageBox: () => assert.fail('already elevated') }, {
    status: async () => 'elevated', relaunch: () => assert.fail('already elevated'),
  }), true);
});

test('standard startup explicitly asks for administrator authorization, and cancellation can be retried', async () => {
  const prompts = [];
  let launches = 0;
  const dialogs = { showMessageBox: async options => { prompts.push(options); return { response: 0 }; } };
  assert.equal(await ensureWindowsAdministrator(runtime(), dialogs, {
    status: async () => 'standard', relaunch: async () => ++launches === 1 ? 'cancelled' : 'started',
  }), false, 'the unelevated original must not create a browser after relaunch');
  assert.equal(launches, 2); assert.equal(prompts.length, 2);
  assert.match(prompts[0].buttons[0], /申请管理员权限/);
  assert.match(prompts[1].message, /已取消/);
});

test('closing an authorization prompt or a failed token check never bypasses administrator checks', async () => {
  for (const elevation of ['standard', 'unavailable']) {
    const prompts = [];
    assert.equal(await ensureWindowsAdministrator(runtime(), { showMessageBox: async options => { prompts.push(options); return { response: 1 }; } }, {
      status: async () => elevation, relaunch: () => assert.fail('authorization was not approved'),
    }), false);
    assert.equal(prompts.length, 1);
  }
});

test('missing elevation helpers report a visible error and offer retry or exit', async () => {
  const prompts = [];
  assert.equal(await ensureWindowsAdministrator(runtime(), { showMessageBox: async options => { prompts.push(options); return { response: prompts.length === 1 ? 0 : 1 }; } }, {
    status: async () => 'standard', relaunch: async () => 'failed',
  }), false);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].message, /组件未能启动/);
});

test('elevated replacement can own the instance lock; cancelled or failed launches restore it', async () => {
  for (const result of ['started', 'cancelled', 'failed']) {
    const app = runtime();
    assert.equal(await relaunchWindowsAdministrator(app, async () => { app.calls.push('native'); return result; }), result);
    assert.deepEqual(app.calls, result === 'started' ? ['release', 'native'] : ['release', 'native', 'acquire']);
  }
  const app = runtime();
  app.requestSingleInstanceLock = () => false;
  assert.equal(await relaunchWindowsAdministrator(app, async () => 'cancelled'), 'replaced');
});

test('native elevation preserves executable paths and classifies cancellation separately from failure', async () => {
  const client = 'C:\\Users\\Administrator\\监考 软件\\客户端.exe';
  for (const [error, result] of [[null, 'started'], [{ code: 10 }, 'cancelled'], [{ code: 10, killed: true }, 'failed'], [{ code: 'ENOENT' }, 'failed']]) {
    assert.equal(await launchWindowsElevated('native.exe', client, undefined, (file, args, options, callback) => {
      assert.equal(file, 'native.exe'); assert.deepEqual(args, [client, '--proctor-elevated-relaunch']);
      assert.equal(options.windowsHide, true); callback(error);
    }), result);
  }
  assert.equal(quoteWindowsArgument('C:\\dir with spaces\\'), '"C:\\dir with spaces\\\\"');
});
