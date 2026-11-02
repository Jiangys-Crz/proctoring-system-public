const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { macCapturePermissionScript, macCaptureDeviceCount } = require('../dist/main/capture-permission');

function actions({ platform = 'darwin', media = {}, accessibility = false, granted = false, failures = {}, elevated = true, elevationStatus } = {}) {
  const calls = [];
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/permission-actions.js'), 'utf8'), context);
  const record = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    if (failures[name]) throw failures[name];
    return result;
  };
  const run = context.createPermissionActions({
    api: {
      getSystemPermissionStatus: record('status', { platform, media, accessibility }),
      getSecurityCapabilities: record('capabilities', { elevated, elevationStatus, processScan: true, hardwareScan: false, vmScan: true }),
      askMacMediaAccess: record('askMedia', granted),
      openMacPrivacyPane: record('macSettings', true), openWindowsPrivacyPane: record('windowsSettings', true),
      testScreenCapture: record('screenRequest', { ok: false }),
      promptMacAccessibility: record('accessibilityRequest', false),
      requestNetworkDomainPermission: record('networkAuthorization', { message: '请完成系统授权' }),
      relaunchAsAdmin: record('adminRequest', granted)
    },
    requestLocalNetwork: record('localNetwork', true), probeMedia: record('mediaProbe', true),
    probeScreen: record('screenProbe', true), hosts: () => []
  });
  return { run, calls };
}

test('camera and microphone request the selected permission only, then open settings on denial', async () => {
  for (const target of ['camera', 'microphone']) {
    const { run, calls } = actions();
    await run(target);
    assert.deepEqual(calls, [['status'], ['askMedia', target], ['macSettings', target]]);
  }
});

test('granted media permission does not reopen a permission dialog', async () => {
  const { run, calls } = actions({ media: { camera: 'granted' } });
  assert.match(await run('camera'), /已授权/);
  assert.deepEqual(calls, [['status'], ['mediaProbe', 'camera']]);
});

test('successful native prompt does not open settings unnecessarily', async () => {
  const { run, calls } = actions({ granted: true });
  await run('microphone');
  assert.deepEqual(calls, [['status'], ['askMedia', 'microphone'], ['mediaProbe', 'microphone']]);
});

test('granted macOS permission is not reported usable when the device probe fails', async () => {
  const error = Object.assign(new Error('Camera disconnected'), { name: 'NotFoundError' });
  const { run, calls } = actions({ media: { camera: 'granted' }, failures: { mediaProbe: error } });
  await assert.rejects(run('camera'), /Camera disconnected/);
  assert.deepEqual(calls, [['status'], ['mediaProbe', 'camera']]);
});

test('granted macOS screen permission still verifies actual capture', async () => {
  const { run, calls } = actions({ media: { screen: 'granted' } });
  await run('screen');
  assert.deepEqual(calls, [['status'], ['screenProbe']]);
});

test('screen card requests screen authorization without requiring camera or system readiness', async () => {
  const { run, calls } = actions();
  await run('screen');
  assert.deepEqual(calls, [['status'], ['screenRequest'], ['status'], ['macSettings', 'screen']]);
});

test('accessibility and active-window cards trigger the corresponding native authorization', async () => {
  for (const key of ['accessibility', 'activeWindow']) {
    const { run, calls } = actions();
    await run(key);
    assert.deepEqual(calls, [['status'], ['accessibilityRequest'], ['status'], ['macSettings', 'accessibility']]);
  }
});

test('network card invokes authorization instead of merely retrying capture', async () => {
  const { run, calls } = actions();
  await run('domain');
  assert.deepEqual(calls, [['networkAuthorization']]);
});

test('Windows media denial opens the matching privacy page', async () => {
  const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const { run, calls } = actions({ platform: 'win32', failures: { mediaProbe: error } });
  await run('camera');
  assert.deepEqual(calls, [['status'], ['mediaProbe', 'camera'], ['windowsSettings', 'camera']]);
});

test('missing hardware is not reported as missing privacy permission', async () => {
  const error = Object.assign(new Error('No camera'), { name: 'NotFoundError' });
  const { run, calls } = actions({ platform: 'win32', failures: { mediaProbe: error } });
  await assert.rejects(run('camera'), /No camera/);
  assert.equal(calls.some(([name]) => name === 'windowsSettings'), false);
});

test('Windows cancellation is reported and process card requests admin when needed', async () => {
  const { run, calls } = actions({ platform: 'win32', elevated: false });
  assert.match(await run('process'), /取消管理员授权/);
  assert.equal(calls.at(-1)[0], 'adminRequest');
});

test('failed Windows token detection does not loop through administrator relaunch', async () => {
  const { run, calls } = actions({ platform: 'win32', elevated: false, elevationStatus: 'unavailable' });
  assert.match(await run('admin'), /检测失败/);
  assert.match(await run('process'), /检测失败/);
  assert.equal(calls.some(([name]) => name === 'adminRequest'), false);
});

test('system capability cards do not request unrelated media or network permissions', async () => {
  for (const target of ['process', 'hardware', 'vm']) {
    const { run, calls } = actions();
    const message = await run(target);
    assert.equal(calls.length, 2);
    if (target === 'hardware') assert.match(message, /没有独立的系统授权开关/);
  }
});

test('privileged command has a bounded device scope and cannot accept arbitrary UID input', () => {
  const script = macCapturePermissionScript(501, 12);
  assert.match(script, /with administrator privileges/);
  assert.match(script, /\/usr\/sbin\/chown 501/);
  assert.match(script, /\/dev\/bpf/);
  assert.match(script, /count=0/);
  assert.doesNotMatch(script, /launchctl|LaunchDaemons|chmod 777/);
  assert.throws(() => macCapturePermissionScript('501; touch /tmp/unwanted', 1));
  assert.throws(() => macCapturePermissionScript(0, 1));
  assert.throws(() => macCapturePermissionScript(501, NaN));
});

test('Mac authorization includes new BPF devices when another application occupies the original device pool', () => {
  const occupiedPool = Array.from({ length: 19 }, (_, index) => `bpf${index}`);
  const count = macCaptureDeviceCount(12, occupiedPool);
  assert.equal(count, 35);
  assert.match(macCapturePermissionScript(501, 12, occupiedPool), /-lt 35/);
  assert.equal(macCaptureDeviceCount(12, [...occupiedPool, 'bpf999; bad', '../bpf300', 'random']), count);
  assert.equal(macCaptureDeviceCount(500, ['bpf999']), 256);
  assert.throws(() => macCaptureDeviceCount(NaN, []));
  assert.throws(() => macCaptureDeviceCount(-1, []));
  assert.throws(() => macCaptureDeviceCount(1.5, []));
});

function macMonitor(grantResult, failInterface = '') {
  const { EventEmitter } = require('node:events');
  const module = { exports: {} };
  const captureArgs = [];
  let authorized = false;
  let authorizationCount = 0;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/main/network-domains'), 'utf8'), {
    module, exports: module.exports, process: { platform: 'darwin', env: {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms === 300 ? 0 : ms), clearTimeout, console: { warn() {} },
    require: (id) => {
      if (id === 'node:fs') return { existsSync: (path) => path === '/usr/sbin/tcpdump' };
      if (id === 'node:os') return { networkInterfaces: () => ({
        en0: [{ address: '10.0.0.2', internal: false }],
        awdl0: [{ address: 'fe80::1', internal: false }],
        lo0: [{ address: '127.0.0.1', internal: true }]
      }) };
      if (id === './windows-system-command') return require('../dist/main/windows-system-command');
      if (id === './network-domain-data') return require('../dist/main/network-domain-data');
      if (id === './capture-permission') return { requestMacCapturePermission: async () => {
        authorizationCount += 1;
        authorized = grantResult;
        return { granted: grantResult, message: grantResult ? '已授权' : '已取消网络检测授权' };
      }};
      if (id === 'node:child_process') return { spawn: (_cmd, args) => {
        captureArgs.push(args);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.exitCode = null; child.killed = false;
        child.kill = () => { child.killed = true; child.exitCode = 1; queueMicrotask(() => child.emit('exit', 1)); };
        queueMicrotask(() => child.stderr.emit('data', Buffer.from(authorized && args[1] !== failInterface ? `listening on ${args[1]}` : "You don't have permission to capture on that device")));
        return child;
      }};
      return require(id);
    }
  });
  return { monitor: module.exports, captureArgs, count: () => authorizationCount };
}

test('Mac permission denial triggers one system authorization then retries existing interfaces', async () => {
  const { monitor, captureArgs, count } = macMonitor(true);
  assert.equal((await monitor.startNetworkDomainMonitor()).permissionRequired, true);
  assert.equal(count(), 0);
  const [first, second] = await Promise.all([monitor.requestNetworkDomainPermission(), monitor.requestNetworkDomainPermission()]);
  assert.equal(first.state, 'limited'); assert.equal(second.state, 'limited');
  assert.equal(count(), 1);
  assert.equal(captureArgs.some((args) => args.includes('any')), false);
  assert.equal(captureArgs.some((args) => args.includes('awdl0')), false);
  assert.equal(captureArgs.at(-1)[1], 'lo0');
  monitor.stopNetworkDomainMonitor();
});

test('Mac network detection remains available when only loopback capture fails', async () => {
  const { monitor } = macMonitor(true, 'lo0');
  const result = await monitor.requestNetworkDomainPermission();
  assert.equal(result.state, 'limited');
  assert.match(result.message, /部分可用/);
  monitor.stopNetworkDomainMonitor();
});

test('Mac network detection does not claim success when every external interface fails', async () => {
  const { monitor } = macMonitor(true, 'en0');
  const result = await monitor.requestNetworkDomainPermission();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.permissionRequired, true);
  monitor.stopNetworkDomainMonitor();
});

test('canceling Mac authorization leaves detection unavailable and retryable', async () => {
  const { monitor, count } = macMonitor(false);
  const result = await monitor.requestNetworkDomainPermission();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.permissionRequired, true);
  assert.match(result.message, /取消/);
  await monitor.requestNetworkDomainPermission();
  assert.equal(count(), 2);
  monitor.stopNetworkDomainMonitor();
});

test('every required permission participates in the next-step gate', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/permission-state.js'), 'utf8'), context);
  const permissions = { platform: 'darwin', accessibility: true };
  const capabilities = { processScan: true, networkDomainStatus: { state: 'limited' }, hardwareScan: true, vmScan: true, activeWindow: true };
  const checks = { network: true, screen: true, camera: true, microphone: true };
  const all = () => context.proctorPermissionRows(permissions, capabilities, checks).every(row => row.granted);
  assert.equal(all(), true);
  for (const key of Object.keys(checks)) { checks[key] = false; assert.equal(all(), false, key); checks[key] = true; }
  for (const key of ['processScan', 'hardwareScan', 'vmScan', 'activeWindow']) { capabilities[key] = false; assert.equal(all(), false, key); capabilities[key] = true; }
  capabilities.networkDomainStatus.state = 'unavailable'; assert.equal(all(), false);
  capabilities.networkDomainStatus.state = 'ready'; permissions.accessibility = false; assert.equal(all(), false);
  permissions.platform = 'win32'; capabilities.elevated = false; assert.equal(all(), false);
  capabilities.elevated = true; assert.equal(all(), true);
});

test('a failed scan never changes a confirmed administrator into an unauthorized account', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/permission-state.js'), 'utf8'), context);
  const permissions = { platform: 'win32' };
  const checks = { network: true, screen: true, camera: true, microphone: true };
  let rows = context.proctorPermissionRows(permissions, { elevated: true, elevationStatus: 'elevated', processScan: false, processScanMessage: '系统组件读取失败' }, checks);
  assert.equal(rows.find(row => row.key === 'admin').label, '已授权');
  assert.equal(rows.find(row => row.key === 'process').label, '检测失败');
  assert.equal(rows.find(row => row.key === 'process').detail, '系统组件读取失败');
  for (const key of ['hardware', 'vm', 'activeWindow']) {
    assert.equal(rows.find(row => row.key === key).label, '检测失败');
    assert.equal(rows.find(row => row.key === key).granted, false);
  }
  assert.equal(rows.every(row => row.granted), false);
  rows = context.proctorPermissionRows(permissions, { elevated: false, elevationStatus: 'standard', processScan: false }, checks);
  assert.equal(rows.find(row => row.key === 'admin').label, '未授权');
  assert.equal(rows.find(row => row.key === 'process').label, '需要管理员权限');
  for (const capabilities of [null, { elevated: false, elevationStatus: 'unavailable' }]) {
    rows = context.proctorPermissionRows(permissions, capabilities, checks);
    assert.equal(rows.find(row => row.key === 'admin').label, '检测失败');
    assert.equal(rows.find(row => row.key === 'admin').granted, false);
  }
});
