const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function scanner(platform, initialReport) {
  const module = { exports: {} };
  let report = initialReport, failure = null, stderr = '', now = 0, scans = 0, hold = false;
  const callbacks = [], scripts = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/main/security'), 'utf8'), {
    module, exports: module.exports, process: { platform, env: {}, resourcesPath: '/client/resources' }, Date: { now: () => now },
    setTimeout: (callback, ms) => { now += ms; callback(); },
    require: id => {
      if (id === 'electron') return { app: { isPackaged: true } };
      if (id === './network-domains') return {};
      if (id === './process-policy') return {};
      if (id === './windows-elevation') return {};
      if (id === './startup') return {};
      if (id === './windows-usb-identity') return require('../dist/main/windows-usb-identity');
      if (id === './windows-system-command') return require('../dist/main/windows-system-command');
      if (id === 'node:child_process') return { execFile: (_command, args, _options, callback) => {
        if (args[0] === '-listDataTypes') return callback(null, 'SPUSBHostDataType\nSPUSBDataType\nSPThunderboltDataType', '');
        scans++;
        scripts.push(args);
        const complete = () => {
          const current = typeof report === 'function' ? report(scans) : report;
          callback(failure, typeof current === 'string' ? current : JSON.stringify(current), stderr);
        };
        if (hold) callbacks.push(complete); else complete();
      } };
      return require(id);
    }
  });
  return {
    scan: () => module.exports.peripheralsFingerprint(), confirm: () => module.exports.confirmPeripheralBaseline(), scripts,
    get scans() { return scans; },
    set: value => { report = value; failure = null; stderr = ''; },
    fail: () => { failure = new Error('scan failed'); },
    warn: value => { stderr = value; },
    advance: (ms = platform === 'win32' ? 3000 : 1000) => { now += ms; },
    hold: () => { hold = true; },
    release: () => { hold = false; for (const callback of callbacks.splice(0)) callback(); }
  };
}

const root = ['USB\\ROOT_HUB30\\CONTROLLER', 'True'];
const keyboard = ['USB\\VID_1234&PID_5678\\KEYBOARD', 'True'];
const mouse = ['USB\\VID_ABCD&PID_EF01\\MOUSE', 'True'];
const usbStorage = ['USB\\VID_9876&PID_1234\\STORAGE', 'True'];
function windows(rows, header = ['DeviceID', 'Present']) {
  const enriched = rows.map(row => [...row, /^USB\\/i.test(row[0]) ? 'USB' : 'OTHER', row[0].split('\\').slice(0, 2).join('\\')]);
  return [[...header, 'BusType', 'HardwareID'], ...enriched].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
}

test('Windows physical USB fingerprints ignore ordering, duplicate rows, case, labels and virtual interfaces', async () => {
  const baseline = await scanner('win32', windows([root, keyboard, mouse])).scan();
  const variations = [
    windows([mouse, keyboard, root, keyboard]),
    windows([root, keyboard.map(value => value.toLowerCase()), mouse]),
    windows([root, keyboard, mouse].map(row => [...row, 'name changed, "driver running"']), ['DeviceID', 'Present', 'Name']),
    windows([root, keyboard, mouse, ['SWD\\MMDEVAPI\\NEW_AUDIO_ENDPOINT', 'True'], ['USB\\VID_1234&PID_5678&MI_00\\AUDIO_FUNCTION', 'True']]),
    windows([root, keyboard, mouse, ['USB\\VID_9876&PID_1234\\OLD_DEVICE', 'False']]),
  ];
  assert.match(baseline, /^usb-v6:[0-9a-f]{64}$/);
  for (const report of variations) assert.equal(await scanner('win32', report).scan(), baseline);
  const probe = scanner('win32', windows([root, keyboard]));
  await probe.scan();
  assert.deepEqual(Array.from(probe.scripts[0]), ['peripherals']);
});

test('actual USB additions and removals become visible after two separated successful scans', async () => {
  const probe = scanner('win32', windows([root, keyboard]));
  const baseline = await probe.scan();
  probe.set(windows([root, keyboard, usbStorage]));
  assert.equal(await probe.scan(), baseline);
  assert.equal(await probe.scan(), baseline, 'back-to-back scans do not confirm an enumeration transition');
  probe.advance();
  const inserted = await probe.scan();
  assert.notEqual(inserted, baseline);
  probe.set(windows([root]));
  assert.equal(await probe.scan(), inserted);
  probe.advance();
  const removed = await probe.scan();
  assert.notEqual(removed, inserted);
  assert.notEqual(removed, baseline, 'removing the original keyboard is also detected');
});

test('Windows 7 vendor enumerators are identified by USB bus or hardware metadata without including root hubs and function children', async () => {
  const report = rows => [['DeviceID', 'Present', 'BusType', 'HardwareID'], ...rows]
    .map(row => row.map(value => `"${value}"`).join(',')).join('\r\n');
  const host = ['PCI\\VEN_1234\\CONTROLLER', 'True', 'OTHER', 'PCI\\VEN_1234'];
  const vendor = ['VENDORUSB3\\VID_1234&PID_5678\\SERIAL', 'True', 'USB', 'VENDORUSB3\\VID_1234&PID_5678'];
  const hardware = ['CUSTOM\\DEVICE\\SERIAL', 'True', 'UNKNOWN', 'USB\\VID_1234&PID_5678'];
  const empty = await scanner('win32', report([host])).scan();
  const withVendor = await scanner('win32', report([host, vendor])).scan();
  const withHardware = await scanner('win32', report([host, hardware])).scan();
  assert.notEqual(withVendor, empty);
  assert.notEqual(withHardware, empty);
  for (const ignored of [
    ['VENDORUSB3\\ROOT_HUB30\\HOST', 'True', 'USB', 'VENDORUSB3\\ROOT_HUB30'],
    ['USB\\AMDROOT_HUB31&VID1022\\HOST', 'True', 'USB', 'USB\\AMDROOT_HUB31&VID1022'],
    ['CUSTOM\\FUNCTION\\CHILD', 'True', 'USB', 'USB\\VID_1234&PID_5678&MI_00'],
    ['HID\\VID_1234&PID_5678\\CHILD', 'True', 'USB', 'HID\\VID_1234&PID_5678'],
    ['USBSTOR\\DISK\\CHILD', 'True', 'USB', 'USBSTOR\\DISK'],
    ['SCSI\\DISK&VEN_GENERIC\\CHILD', 'True', 'USB', 'USB\\VID_1234&PID_5678'],
    ['STORAGE\\VOLUME\\CHILD', 'True', 'USB', 'USB\\VID_1234&PID_5678'],
    ['ROOT\\MEDIA\\CHILD', 'True', 'USB', 'USB\\VID_1234&PID_5678'],
  ]) assert.equal(await scanner('win32', report([host, vendor, ignored])).scan(), withVendor);
  await assert.rejects(scanner('win32', report([host, ['USB\\INVALID', 'True', 'USB', '']])).scan(), /身份信息不完整/);
  await assert.rejects(scanner('win32', report([host, ['USB\\VID_1234\\DEVICE', 'True', 'corrupt', '']])).scan(), /总线信息无效/);
  await assert.rejects(scanner('win32', 'DeviceID,Present\r\nUSB\\VID_1234\\DEVICE,True').scan(), /有效的 USB/,
    'an outdated helper cannot silently disable vendor-driver coverage');
});

test('a one-scan device enumeration dropout does not cause an insertion/removal alert', async () => {
  const probe = scanner('win32', windows([root, keyboard, mouse]));
  const baseline = await probe.scan();
  probe.set(windows([root, keyboard]));
  assert.equal(await probe.scan(), baseline);
  probe.advance();
  probe.set(windows([root, keyboard, mouse]));
  assert.equal(await probe.scan(), baseline);
  probe.advance();
  assert.equal(await probe.scan(), baseline);
});

test('Win7 driver re-enumeration remains unconfirmed across repeated observations within three seconds', async () => {
  const probe = scanner('win32', windows([root, keyboard, mouse]));
  const baseline = await probe.scan();
  probe.set(windows([root, keyboard]));
  assert.equal(await probe.scan(), baseline);
  probe.advance(1100); assert.equal(await probe.scan(), baseline);
  probe.advance(1100); assert.equal(await probe.scan(), baseline);
  probe.set(windows([root, keyboard, mouse]));
  probe.advance(1100); assert.equal(await probe.scan(), baseline);
});

test('physical identities survive Win7 enumerator/revision changes without collapsing distinct instances', async () => {
  const baseline = await scanner('win32', windows([root, keyboard])).scan();
  for (const id of [keyboard[0].replace('USB', 'IUSB3'), keyboard[0].replace('PID_5678', 'PID_5678&REV_0100')]) {
    const report = [['DeviceID', 'Present', 'BusType', 'HardwareID'], [id, 'True', 'USB', 'USB\\VID_1234&PID_5678']]
      .map(row => row.map(value => `"${value}"`).join(',')).join('\r\n');
    assert.equal(await scanner('win32', report).scan(), baseline);
  }
});

test('two identical model devices retain their instance identities instead of collapsing real changes', async () => {
  const first = await scanner('win32', windows([root, keyboard])).scan();
  const second = await scanner('win32', windows([root, [keyboard[0].replace('KEYBOARD', 'SECOND_SERIAL'), 'True']])).scan();
  const both = await scanner('win32', windows([root, keyboard, [keyboard[0].replace('KEYBOARD', 'SECOND_SERIAL'), 'True']])).scan();
  assert.notEqual(first, second);
  assert.notEqual(first, both);
});

test('empty, header-only, malformed and failed inventories never establish an empty-device baseline', async () => {
  for (const report of ['', 'DeviceID,Present', 'DeviceID,Present\nUSB\\BAD', 'DeviceID,Present\nUSB\\BAD,unknown', 'DeviceID,Present\nUSB\\VID_1234&PID_5678\\HISTORICAL,', 'wrong,data\nhello,world']) {
    const probe = scanner('win32', report);
    await assert.rejects(probe.scan(), /USB/);
    probe.set(windows([root, keyboard]));
    assert.match(await probe.scan(), /^usb-v6:[0-9a-f]{64}$/);
  }
  const probe = scanner('win32', windows([root, keyboard]));
  const baseline = await probe.scan();
  probe.set(windows([root, keyboard, mouse]));
  assert.equal(await probe.scan(), baseline);
  probe.advance();
  probe.fail();
  await assert.rejects(probe.scan(), /scan failed/);
  probe.set(windows([root, keyboard, mouse]));
  assert.equal(await probe.scan(), baseline, 'a failed scan clears the pending confirmation');
  probe.advance();
  assert.notEqual(await probe.scan(), baseline);
});

test('overlapping capability and heartbeat requests share one observation, not two change confirmations', async () => {
  const probe = scanner('win32', windows([root, keyboard]));
  const baseline = await probe.scan();
  probe.advance();
  probe.set(windows([root, keyboard, mouse]));
  probe.hold();
  const first = probe.scan(), second = probe.scan(), third = probe.scan();
  assert.equal(probe.scans, 2, 'one baseline scan plus one shared pending scan');
  probe.release();
  assert.deepEqual(await Promise.all([first, second, third]), [baseline, baseline, baseline]);
  probe.advance();
  assert.notEqual(await probe.scan(), baseline);
});

test('a new login waits for the current device set instead of adopting a previous precheck fingerprint', async () => {
  const probe = scanner('win32', windows([root, keyboard]));
  const old = await probe.scan();
  probe.set(windows([root, keyboard, mouse]));
  const fresh = await probe.confirm();
  assert.notEqual(fresh, old);
  assert.equal(probe.scans, 5, 'one old observation plus four current observations spanning the Win7 settling window');
  assert.equal(await probe.scan(), fresh);
});

test('initial login confirmation also requires two independent observations and refuses persistent device jitter', async () => {
  const probe = scanner('win32', windows([root, keyboard]));
  assert.match(await probe.confirm(), /^usb-v6:/);
  assert.equal(probe.scans, 2);
  probe.set(index => windows(index % 2 ? [root, keyboard, mouse] : [root, keyboard, usbStorage]));
  await assert.rejects(probe.confirm(), /设备检测未稳定/);
  assert.equal(probe.scans, 6, 'confirmation is bounded to four scans');
  probe.fail();
  await assert.rejects(probe.confirm(), /scan failed/);
});

const macDevice = {
  _name: 'Keyboard', USBDeviceKeyVendorID: '0x1234', USBDeviceKeyProductID: '0x5678',
  USBKeyLocationID: '0x00100000', USBDeviceKeySerialNumber: 'SERIAL_A',
  USBDeviceKeyLinkSpeed: '12 Mb/s', USBDeviceKeyPowerAllocation: '100 mA'
};
function macReport(devices = [macDevice], changes = {}) {
  return {
    SPUSBHostDataType: [{ _name: 'USB Bus', Driver: 'AppleUSB', USBKeyLocationID: '0x00000000', _items: devices }],
    SPThunderboltDataType: [{ _name: 'thunderbolt_bus_0', switch_uid_key: 'host-controller',
      receptacle_1_tag: { current_speed_key: '40 Gb/s', link_status_key: '0x100' } }],
    ...changes
  };
}

test('macOS fingerprints use physical identities across old/new JSON formats, not power/link state or names', async () => {
  const baseline = await scanner('darwin', macReport()).scan();
  assert.match(baseline, /^mac-usb-v3:[0-9a-f]{64}$/);
  const changedDisplay = { ...macDevice, _name: 'Different display name', USBDeviceKeyLinkSpeed: '480 Mb/s', USBDeviceKeyPowerAllocation: '250 mA' };
  const oldFormat = { vendor_id: '0x1234 (Vendor)', product_id: '0x5678', location_id: '0x00100000 / 42', serial_num: 'SERIAL_A', bus_power: '500', device_speed: 'fast' };
  for (const report of [macReport([changedDisplay]), macReport([oldFormat]), macReport([macDevice, macDevice]), macReport([macDevice], { SPThunderboltDataType: [{ _name: 'thunderbolt_bus_0', switch_uid_key: 'host-controller', receptacle_1_tag: { current_speed_key: '20 Gb/s', link_status_key: '0x200' } }] })]) {
    assert.equal(await scanner('darwin', report).scan(), baseline);
  }
  const secondDevice = { ...macDevice, USBKeyLocationID: '0x00200000', USBDeviceKeySerialNumber: 'SERIAL_B' };
  const two = await scanner('darwin', macReport([macDevice, secondDevice])).scan();
  assert.notEqual(two, baseline);
  assert.equal(await scanner('darwin', macReport([secondDevice, macDevice])).scan(), two);
});

test('macOS records actual Thunderbolt peripherals while ignoring host-port runtime properties', async () => {
  const baseline = await scanner('darwin', macReport()).scan();
  const device = { _name: 'Dock', switch_uid_key: 'dock-uid', vendor_id_key: '0x1234', device_id_key: '0x5678', current_speed_key: '40 Gb/s' };
  const withDock = macReport([], { SPThunderboltDataType: [{ _name: 'bus', switch_uid_key: 'host', _items: [device] }] });
  const plugged = await scanner('darwin', withDock).scan();
  assert.notEqual(plugged, baseline);
  device.current_speed_key = '20 Gb/s';
  assert.equal(await scanner('darwin', withDock).scan(), plugged);
  device.switch_uid_key = 'other-dock-uid';
  assert.notEqual(await scanner('darwin', withDock).scan(), plugged);
});

test('macOS incomplete JSON, missing reports, unknown device identities and timeout warnings fail closed', async () => {
  for (const report of ['{', {}, { SPUSBHostDataType: [], SPThunderboltDataType: [] }, macReport([{ _name: 'enumerating' }]), macReport([{ ...macDevice, USBDeviceKeyProductID: undefined }]),
    macReport([{ ...macDevice, USBKeyLocationID: undefined, USBDeviceKeySerialNumber: 'Not Provided' }])]) {
    await assert.rejects(scanner('darwin', report).scan(), /USB/);
  }
  const probe = scanner('darwin', macReport());
  const baseline = await probe.scan();
  probe.warn('Warning: timeout while reporting USB devices');
  await assert.rejects(probe.scan(), /USB/);
  probe.set(macReport());
  assert.equal(await probe.scan(), baseline);
});
