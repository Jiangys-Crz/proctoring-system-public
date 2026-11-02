import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./install-with-registry-fallback.sh', import.meta.url));
const primary = 'https://primary.example.invalid';
const fallback = 'https://fallback.example.invalid';
const installArgs = [
  'install', '--frozen-lockfile', '--prefer-offline', '--store-dir=/pnpm/store',
  '--package-import-method=copy', '--child-concurrency=1', '--network-concurrency=4',
  '--filter', '@cwnupaa/proctor-web...',
];
const fakeInstaller = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const log = process.env.INSTALL_TEST_LOG;
const previousCalls = fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length;
fs.appendFileSync(log, JSON.stringify({
  command: path.basename(process.argv[1]),
  args: process.argv.slice(2),
}) + '\\n');
process.exit(JSON.parse(process.env.INSTALL_TEST_STATUSES)[previousCalls] ?? 99);
`;

function runInstall({ command = 'pnpm', args = installArgs, statuses = [0], env = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'proctor-registry-test-'));
  const log = join(directory, 'install.jsonl');
  try {
    for (const installer of ['npm', 'pnpm']) {
      writeFileSync(join(directory, installer), fakeInstaller, { mode: 0o755 });
    }
    writeFileSync(log, '');
    const childEnv = {
      ...process.env,
      PATH: directory + ':' + process.env.PATH,
      NPM_REGISTRY: primary,
      NPM_FALLBACK_REGISTRY: fallback,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_STATUSES: JSON.stringify(statuses),
      ...env,
    };
    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined) delete childEnv[key];
    }
    const result = spawnSync('sh', [script, command, ...args], {
      encoding: 'utf8',
      env: childEnv,
      timeout: 10_000,
    });
    assert.ifError(result.error);
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertCalls(result, command, originalArgs, registries) {
  assert.deepEqual(result.calls, registries.map(registry => ({
    command: basename(command),
    args: [
      ...originalArgs,
      `--registry=${registry}`,
      '--fetch-timeout=180000', '--fetch-retries=1',
      '--fetch-retry-mintimeout=10000', '--fetch-retry-maxtimeout=30000',
    ],
  })));
}

for (const [command, args] of [
  ['pnpm', installArgs],
  ['npm', ['install', '--global', 'pnpm@11.16.0', '--cache=/pnpm/npm-cache']],
]) {
  test(`${command}: a successful primary install does not contact the fallback`, () => {
    const result = runInstall({ command, args });
    assert.equal(result.status, 0, result.stderr);
    assertCalls(result, command, args, [primary]);
    assert.equal(result.stderr, '');
  });

  test(`${command}: a failed primary install retries with the fallback and preserves arguments`, () => {
    const result = runInstall({ command, args, statuses: [28, 0] });
    assert.equal(result.status, 0, result.stderr);
    assertCalls(result, command, args, [primary, fallback]);
    assert.match(result.stderr, /retrying with the fallback/);
  });

  test(`${command}: failure of both registries returns the final failure`, () => {
    const result = runInstall({ command, args, statuses: [28, 42] });
    assert.equal(result.status, 42, result.stderr);
    assertCalls(result, command, args, [primary, fallback]);
  });
}

test('an explicitly disabled fallback preserves the first failure without another install', () => {
  const result = runInstall({ statuses: [28], env: { NPM_FALLBACK_REGISTRY: '' } });
  assert.equal(result.status, 28, result.stderr);
  assertCalls(result, 'pnpm', installArgs, [primary]);
  assert.equal(result.stderr, '');
});

test('an identical fallback does not repeat the failed install', () => {
  const result = runInstall({ statuses: [28], env: { NPM_FALLBACK_REGISTRY: primary } });
  assert.equal(result.status, 28, result.stderr);
  assertCalls(result, 'pnpm', installArgs, [primary]);
  assert.equal(result.stderr, '');
});

test('unset registry options use npmjs first and npmmirror as the fallback', () => {
  const result = runInstall({
    statuses: [28, 0],
    env: { NPM_REGISTRY: undefined, NPM_FALLBACK_REGISTRY: undefined },
  });
  assert.equal(result.status, 0, result.stderr);
  assertCalls(result, 'pnpm', installArgs, ['https://registry.npmjs.org', 'https://registry.npmmirror.com']);
});

test('retrying does not split, expand, or discard arguments containing spaces or shell syntax', () => {
  const args = [...installArgs, '--store-dir=/cache/download store', '--filter', 'literal $(exit 7) * value'];
  const result = runInstall({ args, statuses: [28, 0] });
  assert.equal(result.status, 0, result.stderr);
  assertCalls(result, 'pnpm', args, [primary, fallback]);
});
