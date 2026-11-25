const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
test('Windows packaging always includes x86, x64 and ARM64 in one installer', async () => {
  const { windowsPackageInput } = await import('../windows-package-input.mjs');
  const defaults = windowsPackageInput([], '/payload', '/release');
  assert.deepEqual(defaults.names, ['x64', 'x86', 'arm64']);
  assert.deepEqual(defaults.directories, ['/payload/x64', '/payload/x86', '/payload/arm64']);
  assert.equal(defaults.target, '/release');
  const custom = windowsPackageInput(['x64', 'x86', 'arm64', 'release'], '/payload', '/default');
  assert.deepEqual(custom.directories, ['x64', 'x86', 'arm64'].map(value => path.resolve(value)));
  assert.equal(custom.target, path.resolve('release'));
  for (const args of [['--arch', 'x64'], ['--arch', 'arm64', 'payload', 'output'], ['x64'], ['x64', 'x86'], ['a', 'b', 'c', 'd', 'e']]) {
    assert.throws(() => windowsPackageInput(args, '/payload', '/release'), /合并安装包/);
  }
});
