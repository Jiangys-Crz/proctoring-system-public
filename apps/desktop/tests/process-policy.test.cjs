const test = require('node:test');
const assert = require('node:assert/strict');
const { trustedProcessExecutable } = require('../dist/main/process-policy');
const digest = 'a'.repeat(64);
function policy(canonicalPath, signer = 'CN=Microsoft Corporation, O=Microsoft Corporation', hashes = {}, uid = 0, mode = 0o755) {
  return { hashes, inspect: async () => ({ canonicalPath, sha256: digest, uid, mode }), signer: async () => signer };
}
function entry(executable) { return { pid: 20, name: 'name supplied by OS', executable, command: '--code --system' }; }
test('renaming a program or adding whitelist words in paths and arguments never grants trust', async () => {
  for (const executable of ['C:\\Users\\student\\chathelper_code.exe', 'C:\\Users\\student\\idea\\chathelper.exe', '/home/student/system-chathelper']) {
    assert.equal(await trustedProcessExecutable(entry(executable), executable.startsWith('C:') ? 'win32' : 'linux', policy(executable)), false);
  }
});
test('self-created IDE directories cannot impersonate an installed signed Windows IDE', async () => {
  const executable = 'C:\\Users\\student\\Program Files\\VSCode\\code.exe';
  assert.equal(await trustedProcessExecutable(entry(executable), 'win32', policy(executable)), false);
});
test('Windows IDEs require a valid vendor signature at a trusted canonical path', async () => {
  const executable = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
  assert.equal(await trustedProcessExecutable(entry(executable), 'win32', policy(executable)), true);
  assert.equal(await trustedProcessExecutable(entry(executable), 'win32', policy(executable, 'CN=Unrelated Vendor, O=Unrelated Vendor')), false);
  const failed = policy(executable); failed.signer = async () => { throw new Error('signature probe failed'); };
  assert.equal(await trustedProcessExecutable(entry(executable), 'win32', failed), false);
  assert.equal(await trustedProcessExecutable(entry(executable), 'win32', policy('C:\\Users\\student\\Code.exe')), false);
});
test('macOS IDEs must retain their signed product identity even with a valid vendor team', async () => {
  const executable = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
  const code = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const accepted = 'Identifier=com.microsoft.VSCode\nTeamIdentifier=UBF8T346G9\nAuthority=Microsoft Corporation';
  assert.equal(await trustedProcessExecutable(entry(code), 'darwin', policy(code, accepted, {}, 501)), true);
  assert.equal(await trustedProcessExecutable(entry(code), 'darwin', policy(code, accepted.replace('com.microsoft.VSCode', 'com.microsoft.edgemac'), {}, 501)), false);
  assert.equal(await trustedProcessExecutable(entry(executable), 'darwin', policy(executable, accepted)), true);
});
test('Linux unsigned tools require exact executable and SHA-256 version pins', async () => {
  const executable = '/opt/exam-ide/bin/ide';
  assert.equal(await trustedProcessExecutable(entry(executable), 'linux', policy(executable)), false);
  assert.equal(await trustedProcessExecutable(entry(executable), 'linux', policy(executable, '', { [executable]: digest })), true);
  assert.equal(await trustedProcessExecutable(entry(executable), 'linux', policy(executable, '', { [executable]: 'b'.repeat(64) })), false);
});
test('unknown paths, failed probes and writable system files are reported rather than implicitly allowed', async () => {
  assert.equal(await trustedProcessExecutable({ pid: 60, name: 'unknown' }, 'win32', policy('unused')), false);
  const file = '/usr/lib/systemd/systemd';
  assert.equal(await trustedProcessExecutable(entry(file), 'linux', policy(file, '', {}, 0, 0o777)), false);
  const failed = policy(file); failed.inspect = async () => { throw new Error('Access denied'); };
  assert.equal(await trustedProcessExecutable(entry(file), 'linux', failed), false);
});

test('valid signatures with impersonated publisher names or unrelated Developer ID teams never gain trust', async () => {
  const win = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
  for (const subject of ['CN=Microsoft Corporation Helper, O=Unrelated Vendor', 'CN=Unrelated Vendor, O=Microsoft Corporation', 'CN=Microsoft Corporation, O=Microsoft Corporation Impersonator']) assert.equal(await trustedProcessExecutable(entry(win), 'win32', policy(win, subject)), false);
  const mac = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
  assert.equal(await trustedProcessExecutable(entry(mac), 'darwin', policy(mac, 'Identifier=com.microsoft.VSCode\nTeamIdentifier=EVIL123456\nAuthority=Microsoft Corporation')), false);
});
test('macOS platform processes require the verified Apple anchor and failures remain reported', async () => {
  const file = '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder';
  assert.equal(await trustedProcessExecutable(entry(file), 'darwin', policy(file, 'Identifier=com.apple.finder\nAuthority=Apple')), false);
  assert.equal(await trustedProcessExecutable(entry(file), 'darwin', policy(file, 'VerifiedAppleAnchor=1\nIdentifier=com.apple.finder')), true);
  const failed = policy(file); failed.signer = async () => { throw new Error('Apple anchor verification failed'); };
  assert.equal(await trustedProcessExecutable(entry(file), 'darwin', failed), false);
});
