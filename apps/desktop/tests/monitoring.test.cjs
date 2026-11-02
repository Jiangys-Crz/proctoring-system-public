const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { normalizeDomain, parseDnsCapture, parseTsharkDomains, parseWindowsDnsCache, DomainWindow } = require('../dist/main/network-domain-data');
const policyContext = vm.createContext({});
vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/window-policy.js'), 'utf8'), policyContext);
const policy = policyContext.proctorWindowPolicy;

test('only cheating and peripheral changes enter the security lock mode', () => {
  for (const status of ['WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'OFFLINE', 'LOCKED']) {
    assert.equal(policy({ status }).mode, 'floating');
    assert.equal(policy({ status, lockdown: true, lockdownReason: '发现非白名单进程' }).mode, 'floating');
    assert.equal(policy({ status, lockdown: true, lockdownReason: '发现异常网络连接' }).mode, 'floating');
  }
  for (const reason of ['张同学因抄袭被监考老师标记为作弊', '检测到外设接入或移除', '检测到拔掉外设', '外设检测不可用，请修复检测组件并由监考老师解锁']) {
    assert.equal(policy({ status: 'LOCKED', lockdown: true, lockdownReason: reason }).mode, 'locked');
    assert.equal(policy({ status: 'IN_EXAM', lockdown: false, lockdownReason: reason }).mode, 'floating');
    assert.equal(policy({ status: 'FINISHED', lockdown: true, lockdownReason: reason }).mode, 'setup');
  }
  assert.equal(policy(null).mode, 'setup');
});

test('domain normalization rejects IPs, PIDs, reverse DNS and invalid values', () => {
  assert.equal(normalizeDomain('WWW.Example.COM.'), 'www.example.com');
  for (const value of ['127.0.0.1', '2606:4700::1111', 'PID:1234', '1234', 'host.local', '1.0.0.127.in-addr.arpa', '<script>.com', 'bad..com']) {
    assert.equal(normalizeDomain(value), '');
  }
});

test('DNS parser collects query names and not response addresses', () => {
  const rows = parseDnsCapture('13:00 IP 10.0.0.2.5500 > 1.1.1.1.53: 33+ A? WWW.Example.COM. (33)');
  assert.deepEqual(rows, [{ domain: 'www.example.com', source: 'DNS 查询' }]);
  assert.equal(parseDnsCapture('12+ HTTPS? example.org. (33)')[0].domain, 'example.org');
  assert.deepEqual(parseDnsCapture('33 1/0/0 A 1.2.3.4 (45)'), []);
  assert.deepEqual(parseDnsCapture('34+ PTR? 1.0.0.127.in-addr.arpa.'), []);
});

test('HTTP, TLS, and DNS retain distinct evidence labels', () => {
  assert.deepEqual(parseTsharkDomains('dns.example.com\ttls.example.org\tweb.example.net:8080'), [
    { domain: 'dns.example.com', source: 'DNS 查询' },
    { domain: 'tls.example.org', source: 'TLS SNI' },
    { domain: 'web.example.net', source: 'HTTP' }
  ]);
});

test('Windows 7 ipconfig DNS cache parser accepts localized record labels', () => {
  assert.deepEqual(parseWindowsDnsCache([
    '    记录名称 . . . . . . . . . . . : EXAMPLE.COM.',
    '    记录类型 . . . . . . . . . . . : 1',
    '    Record Name . . . . . . . . . : sub.example.org',
    '    A (主机)记录 . . . . . . . . . : 192.0.2.1',
  ].join('\r\n')), ['example.com', 'sub.example.org']);
});

test('domain window excludes only explicit whitelist hosts, deduplicates, expires and resets', () => {
  const window = new DomainWindow();
  window.add(parseTsharkDomains('exam.example.com\tother.example.com\tweb.example.net'), 1000);
  window.add(parseTsharkDomains('\tother.example.com\t'), 1001);
  assert.deepEqual(window.snapshot(['https://exam.example.com:4031'], 1002), ['other.example.com（TLS SNI）', 'web.example.net（HTTP）']);
  assert.equal(window.snapshot(['example.com'], 1002).length, 3);
  assert.equal(window.snapshot([], 31002).length, 0);
  window.add(parseDnsCapture('A? new.example.com.'), 32000);
  window.clear();
  assert.deepEqual(window.snapshot([], 32001), []);
});

function windowsMonitor(outputs) {
  const callbacks = [];
  const module = { exports: {} };
  const context = {
    exports: module.exports, module,
    process: { platform: 'win32', env: {} },
    setTimeout: (fn) => { callbacks.push(fn); return callbacks.length; }, clearTimeout: () => {},
    require: (id) => {
      if (id === 'node:fs') return { existsSync: () => false };
      if (id === 'node:child_process') return { execFile: (_cmd, _args, _opts, callback) => {
        const next = outputs.shift();
        queueMicrotask(() => next instanceof Error ? callback(next) : callback(null, JSON.stringify(next || [])));
      }};
      if (id === './windows-system-command') return require('../dist/main/windows-system-command');
      if (id === './network-domain-data') return require('../dist/main/network-domain-data');
      if (id === './capture-permission') return {};
      return require(id);
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/main/network-domains'), 'utf8'), context);
  return { monitor: module.exports, callbacks };
}

test('Windows cache establishes baseline without reporting historical activity', async () => {
  const { monitor, callbacks } = windowsMonitor([['old.example.com'], ['old.example.com', 'new.example.com']]);
  assert.equal((await monitor.startNetworkDomainMonitor()).state, 'limited');
  assert.equal(monitor.networkRemotes([]).length, 0);
  await callbacks.shift()();
  assert.deepEqual(monitor.networkRemotes([]), ['new.example.com（DNS 缓存新增）']);
  monitor.stopNetworkDomainMonitor();
  assert.equal(monitor.getNetworkDomainStatus().state, 'idle');
  assert.equal(monitor.networkRemotes([]).length, 0);
});

test('cache read failure is unavailable, never a successful empty scan', async () => {
  const { monitor } = windowsMonitor([new Error('unsupported cmdlet'), new Error('access denied')]);
  assert.equal((await monitor.startNetworkDomainMonitor()).state, 'unavailable');
});

test('stopping during cache startup prevents a late polling timer', async () => {
  const { monitor, callbacks } = windowsMonitor([['old.example.com']]);
  const pending = monitor.startNetworkDomainMonitor();
  monitor.stopNetworkDomainMonitor();
  await pending;
  assert.equal(monitor.getNetworkDomainStatus().state, 'idle');
  assert.equal(callbacks.length, 0);
});

test('stopping while a DNS poll is pending cannot re-add cleared observations', async () => {
  const { monitor, callbacks } = windowsMonitor([['old.example.com'], ['old.example.com', 'new.example.com']]);
  await monitor.startNetworkDomainMonitor();
  const pending = callbacks.shift()();
  monitor.stopNetworkDomainMonitor();
  await pending;
  assert.deepEqual(monitor.networkRemotes([]), []);
  assert.equal(callbacks.length, 0);
});

test('a stopped startup can be replaced immediately without duplicate poll timers', async () => {
  const { monitor, callbacks } = windowsMonitor([['old.example.com'], ['new.example.com']]);
  const stale = monitor.startNetworkDomainMonitor();
  monitor.stopNetworkDomainMonitor();
  const current = monitor.startNetworkDomainMonitor();
  await Promise.all([stale, current, monitor.startNetworkDomainMonitor()]);
  assert.equal(monitor.getNetworkDomainStatus().state, 'limited');
  assert.equal(callbacks.length, 1);
  monitor.stopNetworkDomainMonitor();
});

function mockSecurity(commandResult, processPaths = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/main/security'), 'utf8'), {
    module, exports: module.exports,
    __dirname: require('node:path').join(__dirname, '../dist/main'),
    process: { platform: 'win32', env: {}, resourcesPath: '/client/resources', arch: 'ia32', ...processPaths },
    require: (id) => {
      if (id === 'electron') return { app: { isPackaged: true } };
      if (id === './network-domains') return { getNetworkDomainStatus: () => ({ state: 'idle' }) };
      if (id === './process-policy') return require('../dist/main/process-policy');
      if (['./windows-system-command', './startup', './windows-usb-identity'].includes(id)) return require('../dist/main/' + id.slice(2));
      if (id === './windows-elevation') return { readClientWindowsElevation: async filename => {
        assert.equal(filename, '/client/resources/security/token-probe.exe');
        return commandResult.elevation || 'unavailable';
      }};
      if (id === 'node:child_process') return { execFile: (_cmd, _args, _opts, callback) => {
        commandResult.calls?.push([_cmd, _args]);
        callback(commandResult.error || null, commandResult.outputs?.[_args[0]] ?? commandResult.stdout ?? '', '');
      }};
      return require(id);
    }
  });
  return module.exports;
}

test('Windows elevation check accepts only a confirmed administrator token', async () => {
  assert.equal(await mockSecurity({ elevation: 'elevated' }).isElevated(), true);
  assert.equal(await mockSecurity({ elevation: 'standard' }).isElevated(), false);
  const broken = mockSecurity({ elevation: 'unavailable' });
  assert.equal(await broken.isElevated(), false);
  assert.equal(await broken.elevationStatus(), 'unavailable');
});

test('failed process scan is surfaced as unavailable', async () => {
  const security = mockSecurity({ error: new Error('Access denied') });
  await assert.rejects(security.disallowedProcesses(), /Access denied/);
  assert.equal((await security.securityCapabilities()).processScan, false);
});

test('empty and header-only process lists cannot masquerade as a successful scan', async () => {
  for (const stdout of ['', '"Id","ProcessName","Path"']) {
    const security = mockSecurity({ stdout, elevation: 'elevated' });
    await assert.rejects(security.disallowedProcesses(), /有效的进程列表/);
    const result = await security.securityCapabilities();
    assert.equal(result.elevated, true);
    assert.equal(result.processScan, false);
    assert.match(result.processScanMessage, /读取失败/);
  }
});

test('a protected process remains visible and untrusted while process access is checked independently of allowlist signatures', async () => {
  const calls = [];
  const stdout = '"Id","ProcessName","Path"\n"71","受保护程序.exe",""\n"72","未知程序.exe","C:\\考生目录\\未知程序.exe"';
  const security = mockSecurity({ stdout, elevation: 'elevated', calls });
  const result = await security.securityCapabilities();
  assert.equal(result.elevated, true);
  assert.equal(result.processScan, true);
  assert.equal(calls.some(([, args]) => args.at(-1).includes('Get-AuthenticodeSignature')), false);
  assert.deepEqual(Array.from(await security.disallowedProcesses()), ['受保护程序.exe', '未知程序.exe']);
});

test('kernel process identities are preserved while a user program with the same name remains untrusted', async () => {
  const stdout = '"Id","ProcessName","Path"\n"0","System Idle Process",""\n"4","System",""\n"81","System.exe","C:\\考生目录\\System.exe"';
  const security = mockSecurity({ stdout });
  assert.deepEqual(Array.from(await security.listProcesses()), ['System Idle Process', 'System', 'system.exe']);
  assert.deepEqual(Array.from(await security.disallowedProcesses()), ['system.exe']);
});

test('only exact client, encoder and native detection helper paths are trusted', async () => {
  const execPath = '/Applications/程序设计算法协会监考客户端.exe';
  const resourcesPath = '/Applications/resources';
  const csv = [
    '"Id","ProcessName","Path"',
    `"21","程序设计算法协会监考客户端","${execPath}"`,
    `"22","ffmpeg","${resourcesPath}/ffmpeg/ffmpeg.exe"`,
    '"23","unrelated","/Other/unrelated.exe"',
    '"24","ffmpeg","/Other/ffmpeg.exe"',
    `"25","token-probe","${resourcesPath}/security/token-probe.exe"`,
    '"26","token-probe","/Other/token-probe.exe"',
    `"27","inventory-probe","${resourcesPath}/security/inventory-probe.exe"`,
    '"28","inventory-probe","/Other/inventory-probe.exe"'
  ].join('\n');
  const security = mockSecurity({ stdout: csv }, { execPath, resourcesPath, pid: 1 });
  assert.deepEqual(Array.from(await security.disallowedProcesses()), ['unrelated.exe', 'ffmpeg.exe', 'token-probe.exe', 'inventory-probe.exe']);
});

test('Windows window detection reads native UTF-8 JSON without compiling PowerShell code', async () => {
  const calls = [];
  const security = mockSecurity({ stdout: JSON.stringify({ title: '考试客户端 \\"标题\\"' }), calls });
  assert.equal(await security.activeWindowTitle(), '考试客户端 \\"标题\\"');
  assert.equal(calls[0][0], '/client/resources/security/inventory-probe.exe');
  assert.deepEqual(Array.from(calls[0][1]), ['window']);
  for (const stdout of ['', '{"title":null}', 'truncated']) await assert.rejects(mockSecurity({ stdout }).activeWindowTitle(), /报告无效/);
});

test('native probes work without WMI, PowerShell or a titled foreground window', async () => {
  const calls = [];
  const security = mockSecurity({ elevation: 'elevated', calls, outputs: {
    processes: '"Id","ProcessName","Path"\n"4","System",""',
    peripherals: '"DeviceID","Present","BusType","HardwareID"\n"PCI\\HOST","True","OTHER",""',
    hardware: '"Manufacturer","Model"\n"Dell Inc.","OptiPlex 7010"',
    window: '{"title":""}'
  }});
  const result = await security.securityCapabilities();
  for (const key of ['processScan', 'hardwareScan', 'vmScan', 'activeWindow']) assert.equal(result[key], true, key);
  assert.equal(calls.every(([command]) => command.endsWith('security/inventory-probe.exe')), true);
  assert.deepEqual(Array.from(await security.vmSignals()), []);
});

test('failed process and window probes do not discard a successful USB observation', async () => {
  const security = mockSecurity({ outputs: {
    processes: '', window: 'broken', hardware: '',
    peripherals: '"DeviceID","Present","BusType","HardwareID"\n"USB\\VID_1234&PID_5678\\SERIAL","True","USB","USB\\VID_1234&PID_5678"'
  }});
  const snapshot = await security.securitySnapshot([]);
  assert.equal(snapshot.peripheralScanOk, true);
  assert.match(snapshot.peripheralsFingerprint, /^usb-v6:/);
  assert.equal(snapshot.disallowedProcesses, undefined);
  assert.equal(snapshot.activeWindow, undefined);
  assert.equal(snapshot.networkRemotes, undefined);
  assert.equal(snapshot.vmSignals, undefined);
  const independent = await security.peripheralSnapshot();
  assert.equal(independent.peripheralScanOk, true);
  assert.equal(independent.peripheralsFingerprint, snapshot.peripheralsFingerprint);
});

test('a failed USB probe reports unavailable without fabricating a fingerprint or discarding valid process data', async () => {
  const security = mockSecurity({ outputs: {
    processes: '"Id","ProcessName","Path"\n"4","System",""', peripherals: '',
    hardware: '"Manufacturer","Model"\n"Dell","OptiPlex"', window: '{"title":"Exam"}'
  }});
  const snapshot = await security.securitySnapshot([]);
  assert.equal(snapshot.peripheralScanOk, false);
  assert.equal(snapshot.peripheralsFingerprint, undefined);
  assert.deepEqual(Array.from(snapshot.disallowedProcesses), []);
  assert.equal(snapshot.activeWindow, 'Exam');
  const independent = await security.peripheralSnapshot();
  assert.equal(independent.peripheralScanOk, false);
  assert.equal(independent.peripheralsFingerprint, undefined);
});

test('native system identity recognizes Windows 7 virtual machine models without treating virtualization-capable PCs as VMs', async () => {
  for (const [manufacturer, model, signals] of [
    ['Microsoft Corporation', 'Virtual Machine', ['hyper-v']], ['innotek GmbH', 'VirtualBox', ['virtualbox', 'innotek']],
    ['VMware, Inc.', 'VMware Virtual Platform', ['vmware']], ['Microsoft Corporation', 'Surface Laptop', []],
    ['Dell Inc.', 'OptiPlex 7010', []]
  ]) {
    const security = mockSecurity({ stdout: `"Manufacturer","Model"\n"${manufacturer}","${model}"` });
    assert.deepEqual(Array.from(await security.vmSignals()), signals);
  }
  await assert.rejects(mockSecurity({ stdout: '"Manufacturer","Model"\n"",""' }).vmSignals(), /信息不完整/);
});

function mockMacHardwareScan(availableTypes) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/main/security'), 'utf8'), {
    module, exports: module.exports,
    process: { platform: 'darwin', env: {} },
    require: (id) => {
      if (id === 'electron') return { app: { isPackaged: true } };
      if (id === './network-domains') return { getNetworkDomainStatus: () => ({ state: 'idle' }) };
      if (id === './process-policy') return require('../dist/main/process-policy');
      if (['./windows-system-command', './startup', './windows-usb-identity'].includes(id)) return require('../dist/main/' + id.slice(2));
      if (id === './windows-elevation') return { readClientWindowsElevation: () => { throw new Error('Windows probe used on macOS'); } };
      if (id === 'node:child_process') return { execFile: (_cmd, args, _opts, callback) => {
        calls.push(args);
        callback(null, args[0] === '-listDataTypes' ? availableTypes : JSON.stringify({
          [args[0]]: [{ _name: 'USB Bus', _items: [{ vendor_id: '0x1234', product_id: '0x5678', location_id: '0x00100000' }] }],
          SPThunderboltDataType: []
        }), '');
      } };
      return require(id);
    }
  });
  return { security: module.exports, calls };
}

test('macOS hardware scan selects the available USB profiler type instead of silently scanning only Thunderbolt', async () => {
  for (const [types, expected] of [
    ['SPUSBHostDataType\nSPUSBDataType\nSPThunderboltDataType', 'SPUSBHostDataType'],
    ['SPUSBDataType\nSPThunderboltDataType', 'SPUSBDataType']
  ]) {
    const { security, calls } = mockMacHardwareScan(types);
    assert.match(await security.peripheralsFingerprint(), /^mac-usb-v3:[0-9a-f]{64}$/);
    assert.deepEqual(Array.from(calls[1]), [expected, 'SPThunderboltDataType', '-json']);
    await security.peripheralsFingerprint();
    assert.equal(calls.filter((args) => args[0] === '-listDataTypes').length, 1);
  }
  const { security } = mockMacHardwareScan('SPThunderboltDataType');
  await assert.rejects(security.peripheralsFingerprint(), /未提供 USB/);
});

test('macOS does not trust an arbitrary program placed under the client Frameworks directory', async () => {
  const root = '/Applications/Client.app';
  const rows = `100 ${root}/Contents/Frameworks/Unexpected.app/Contents/MacOS/Unexpected\n101 ${root}/Contents/Frameworks/Client Helper (Renderer).app/Contents/MacOS/Client Helper (Renderer)\n`;
  const security = mockSecurity({ stdout: rows }, { platform: 'darwin', execPath: `${root}/Contents/MacOS/Client`, resourcesPath: `${root}/Contents/Resources`, pid: 42 });
  assert.deepEqual(Array.from(await security.disallowedProcesses()), ['Client']);
});
