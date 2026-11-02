import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./deploy-caddy.sh', import.meta.url));
const composePrefix = ['compose', '-f', 'docker-compose.caddy.yml'];
const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_TEST_LOG, JSON.stringify({ args }) + '\\n');
if (args[0] === 'inspect') {
  const value = {
    '{{.HostConfig.Memory}}': process.env.DOCKER_TEST_MEMORY || '2147483648',
    '{{.HostConfig.MemorySwap}}': process.env.DOCKER_TEST_SWAP || '2147483648',
    '{{.HostConfig.CpuQuota}}': process.env.DOCKER_TEST_QUOTA || '200000',
    '{{.HostConfig.CpuPeriod}}': process.env.DOCKER_TEST_PERIOD || '100000',
  }[args[3]];
  if (!value) process.exit(90);
  console.log(value);
}
if (args[0] === 'buildx' && args[1] === 'bake' && args.at(-1) === process.env.DOCKER_TEST_FAIL_SERVICE) {
  process.exit(42);
}
if (args[0] === 'buildx' && args[1] === 'build' && process.env.DOCKER_TEST_FAIL_PROBE) process.exit(43);
if (args[0] === 'buildx' && args[1] === 'inspect' && args.includes('--bootstrap') && process.env.DOCKER_TEST_FAIL_BOOTSTRAP) process.exit(44);
`;

function runDeploy(args = [], extraEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'proctor-deploy-test-'));
  const log = join(directory, 'docker.jsonl');
  try {
    writeFileSync(join(directory, 'docker'), fakeDocker, { mode: 0o755 });
    writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(log, '');
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: directory + ':' + process.env.PATH,
        DOCKER_TEST_LOG: log,
        COMPOSE_PROJECT_NAME: 'proctor-deploy-qa',
        ...extraEnv,
      },
      timeout: 15_000,
    });
    assert.ifError(result.error);
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertDeployment(result, services) {
  assert.equal(result.status, 0, result.stderr);
  const composeCalls = result.calls.filter(call => call.args[0] === 'compose');
  assert.deepEqual(composeCalls.map(call => call.args), [
    [...composePrefix, 'config', '--quiet'],
    [...composePrefix, 'up', '-d', '--no-deps', '--no-build', ...services],
    [...composePrefix, 'ps'],
  ]);
  const bakeCalls = result.calls.filter(call => call.args[0] === 'buildx' && call.args[1] === 'bake');
  assert.deepEqual(bakeCalls.map(call => call.args), services.map(service => [
    'buildx', 'bake', '--builder', 'proctor-limited', '--load', '-f', 'docker-compose.caddy.yml',
    '--set', `${service}.tags=proctor-deploy-qa-${service}`, service,
  ]));
  assert.ok(result.calls.indexOf(bakeCalls.at(-1)) < result.calls.findIndex(call => call.args.includes('up')));
  assert.deepEqual(result.calls.at(-1).args, ['buildx', 'stop', 'proctor-limited']);
}

test('web deploy builds and restarts only the backend', () => {
  assertDeployment(runDeploy(['web']), ['web']);
});

test('client-web deploy builds and restarts only the requested service', () => {
  assertDeployment(runDeploy(['client-web']), ['client-web']);
});

test('no arguments retain sequential backend and client builds before deployment', () => {
  assertDeployment(runDeploy(), ['web', 'client-web']);
});

test('explicit service order is retained and deployment waits for every build', () => {
  assertDeployment(runDeploy(['client-web', 'web']), ['client-web', 'web']);
});

for (const service of ['web', 'client-web']) {
  test(`a failed ${service} build leaves running containers untouched and stops the builder`, () => {
    const result = runDeploy([], { DOCKER_TEST_FAIL_SERVICE: service });
    assert.equal(result.status, 42, result.stderr);
    const composeCommands = result.calls.filter(call => call.args[0] === 'compose').map(call => call.args[3]);
    assert.ok(!composeCommands.includes('up'));
    assert.ok(!composeCommands.includes('ps'));
    assert.deepEqual(result.calls.filter(call => call.args[0] === 'buildx' && call.args[1] === 'bake').map(call => call.args.at(-1)),
      service === 'web' ? ['web'] : ['web', 'client-web']);
    assert.deepEqual(result.calls.at(-1).args, ['buildx', 'stop', 'proctor-limited']);
  });
}

test('unsupported service arguments are rejected before Docker is contacted', () => {
  for (const args of [['mysql'], ['web', 'media'], ['--help'], ['']]) {
    const result = runDeploy(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unsupported service:/);
    assert.deepEqual(result.calls, []);
  }
});

for (const [limit, value] of [['MEMORY', '4294967296'], ['SWAP', '-1'], ['QUOTA', '0'], ['PERIOD', '0']]) {
  test(`incorrect builder ${limit.toLowerCase()} limits prevent build and deployment`, () => {
    const result = runDeploy(['web'], { [`DOCKER_TEST_${limit}`]: value });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Build resource limits do not match/);
    assert.deepEqual(result.calls.filter(call => call.args[0] === 'compose').map(call => call.args[3]), ['config']);
    assert.equal(result.calls.some(call => call.args[0] === 'buildx' && ['build', 'bake'].includes(call.args[1])), false);
    assert.deepEqual(result.calls.at(-1).args, ['buildx', 'stop', 'proctor-limited']);
  });
}

for (const failure of ['PROBE', 'BOOTSTRAP']) {
  test(`failed builder ${failure.toLowerCase()} never falls back to an unbounded daemon build`, () => {
    const result = runDeploy(['web'], { [`DOCKER_TEST_FAIL_${failure}`]: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Deployment stopped/);
    assert.equal(result.calls.some(call => call.args.includes('bake')), false);
    assert.deepEqual(result.calls.filter(call => call.args[0] === 'compose').map(call => call.args[3]), ['config']);
    assert.deepEqual(result.calls.at(-1).args, ['buildx', 'stop', 'proctor-limited']);
  });
}
