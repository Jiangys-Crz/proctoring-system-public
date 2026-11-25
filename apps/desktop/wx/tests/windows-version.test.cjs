const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const requireDesktop = createRequire(path.join(__dirname, '../../package.json'));
const requireBuilder = createRequire(requireDesktop.resolve('electron-builder'));
const { NtExecutable, NtExecutableResource, Resource } = createRequire(requireBuilder.resolve('app-builder-lib'))('resedit');
const checker = import('../windows-version.mjs');

function executable(machine, fileVersion, productVersion = fileVersion, secondLanguage = null) {
  const exe = NtExecutable.createEmpty(machine === 0x014c, false);
  exe.newHeader.fileHeader.machine = machine;
  const resources = NtExecutableResource.from(exe);
  if (fileVersion) {
    const version = Resource.VersionInfo.createEmpty();
    version.lang = 1033;
    version.setFileVersion(fileVersion);
    version.setProductVersion(productVersion);
    version.outputToResourceEntries(resources.entries);
    if (secondLanguage) {
      const translated = Resource.VersionInfo.createEmpty();
      translated.lang = 2052;
      translated.setFileVersion(secondLanguage);
      translated.setProductVersion(secondLanguage);
      translated.outputToResourceEntries(resources.entries);
    }
    resources.outputResource(exe);
  }
  return Buffer.from(exe.generate());
}

test('packaging accepts x86, x64 and ARM64 version resources without modifying their files', async t => {
  const { checkWindowsVersion } = await checker;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-pe-version-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const machine of [0x014c, 0x8664, 0xaa64]) {
    for (const version of ['2.0.5.0', '109.0.1518.140']) {
      const file = path.join(directory, machine + '-' + version + '.exe');
      const data = executable(machine, version);
      fs.writeFileSync(file, data);
      checkWindowsVersion(file, version);
      assert.deepEqual(fs.readFileSync(file), data);
    }
  }
});

test('packaging rejects stale binaries, mismatched file versions and conflicting language resources', async t => {
  const { checkWindowsVersion } = await checker;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-stale-version-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [file, product, other] of [
    ['2.0.4.0', '2.0.4.0', null],
    ['2.0.4.0', '2.0.5.0', null],
    ['2.0.5.0', '2.0.4.0', null],
    ['2.0.5.0', '2.0.5.0', '2.0.4.0'],
  ]) {
    const filename = path.join(directory, 'old.exe');
    fs.writeFileSync(filename, executable(0xaa64, file, product, other));
    assert.throws(() => checkWindowsVersion(filename, '2.0.5.0'),
      error => error.cause.message.includes('实际 2.0.4.0'));
  }
});

test('packaging rejects missing, malformed and truncated version resources', async t => {
  const { checkWindowsVersion } = await checker;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-bad-version-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const valid = executable(0x8664, '2.0.5.0');
  const damaged = Buffer.from(valid);
  damaged.writeUInt32LE(0, damaged.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe])));
  for (const data of [Buffer.alloc(0), Buffer.from('MZ'), executable(0x8664, null),
    valid.subarray(0, 64), valid.subarray(0, valid.length - 1), damaged]) {
    const filename = path.join(directory, 'broken.exe');
    fs.writeFileSync(filename, data);
    assert.throws(() => checkWindowsVersion(filename, '2.0.5.0'));
  }
});
