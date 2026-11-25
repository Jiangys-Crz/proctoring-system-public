const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('native updater compares numeric release versions and rejects malformed metadata', (t) => {
  const compiler = process.env.PROCTOR_TEST_CXX || 'c++';
  const probe = spawnSync(compiler, ['--version']);
  if (probe.error?.code === 'ENOENT') return t.skip('C++ compiler unavailable');
  const directory = mkdtempSync(path.join(tmpdir(), 'proctor-release-test-'));
  try {
    const output = path.join(directory, process.platform === 'win32' ? 'release-test.exe' : 'release-test');
    const built = spawnSync(compiler, ['-std=c++20', '-x', 'c++', '-', '-I', path.join(__dirname, '../src'), '-o', output], {
      encoding: 'utf8',
      input: `
        #include "bridge_update_policy.hpp"
        #include <cassert>
        using proctor::bridge_detail::ParseReleaseVersion;
        int main() {
          assert(ParseReleaseVersion("2.0.10").value() > ParseReleaseVersion("2.0.9").value());
          assert(ParseReleaseVersion("2.1.0").value() < ParseReleaseVersion("3.0.0").value());
          assert(ParseReleaseVersion("2.1.0").value() == ParseReleaseVersion("2.1.0").value());
          assert(ParseReleaseVersion("0.0.999999").has_value());
          for (const auto value : {"", "2.1", "2.1.0.", "2.1.0-beta", "2.01.0", "+2.1.0", "2.1.1000000"}) {
            assert(!ParseReleaseVersion(value));
          }
        }`,
    });
    assert.equal(built.status, 0, built.stderr);
    const result = spawnSync(output, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
