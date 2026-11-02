const assert = require('node:assert/strict');
const { test } = require('node:test');
const { windowsSystemCommand } = require('../dist/main/windows-system-command');

test('a 32-bit client chooses native PowerShell on 64-bit Windows, including custom system directories', () => {
  const relative = 'WindowsPowerShell\\v1.0\\powershell.exe';
  const native = 'D:\\Windows\\Sysnative\\' + relative;
  assert.equal(windowsSystemCommand(relative, { env: { SystemRoot: 'D:\\Windows' }, arch: 'ia32', exists: file => file === native }), native);
  assert.equal(windowsSystemCommand(relative, { env: { SystemRoot: 'D:\\Windows' }, arch: 'ia32', exists: () => false }), 'D:\\Windows\\System32\\' + relative);
  assert.equal(windowsSystemCommand(relative, { env: { SystemRoot: 'D:\\Windows' }, arch: 'x64', exists: () => assert.fail('64-bit clients must not use Sysnative') }), 'D:\\Windows\\System32\\' + relative);
});

test('a changed command search path cannot replace a system detection command', () => {
  assert.equal(windowsSystemCommand('ipconfig.exe', { env: { windir: 'E:\\系统', PATH: 'C:\\student-tools' }, arch: 'x64' }), 'E:\\系统\\System32\\ipconfig.exe');
});
