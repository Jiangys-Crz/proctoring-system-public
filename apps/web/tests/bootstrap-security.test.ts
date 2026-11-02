import assert from 'node:assert/strict';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import { bootstrapAdministratorPassword, ensureBootstrapAdministrator } from '../src/lib/bootstrap-admin';
import { digestPasswordForStorage } from '../src/lib/password-crypto';

test('production bootstrap rejects missing, short, whitespace and documented passwords', () => {
  for (const password of [undefined, '', 'short', ' '.repeat(20), 'LocalDemoOnly403!', 'change-this-password', 'CHANGE-THIS-PASSWORD', 'your-admin-password', 'your-secure-password', 'CHANGE_ME_GENERATE_RANDOM', 'replace-with-a-unique-password', 'x'.repeat(201)]) {
    assert.throws(() => bootstrapAdministratorPassword({ NODE_ENV: 'production', BOOTSTRAP_ADMIN_PASSWORD: password }), /BOOTSTRAP_ADMIN_PASSWORD/);
  }
  assert.equal(bootstrapAdministratorPassword({ NODE_ENV: 'development' }), 'LocalDemoOnly403!');
  assert.equal(bootstrapAdministratorPassword({ NODE_ENV: 'production', BOOTSTRAP_ADMIN_PASSWORD: 'fixture-random-secret-47' }), 'fixture-random-secret-47');
});

test('production first boot fails closed while existing and deleted administrators stay untouched', async () => {
  const previousMode = process.env.NODE_ENV, previousPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  Object.assign(process.env, { NODE_ENV: 'production' });
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  let existing: any = null, complete = false, creates = 0;
  const tx: any = {
    $queryRaw: async () => [],
    systemSetting: { upsert: async () => ({}), findUnique: async () => ({ value: { complete } }), update: async () => { complete = true; } },
    user: { findUnique: async () => existing, create: async ({ data }: any) => { creates++; return existing = { id: 'admin', ...data }; } },
  };
  const client: any = { $transaction: async (callback: any) => callback(tx) };
  try {
    await assert.rejects(ensureBootstrapAdministrator(client), /BOOTSTRAP_ADMIN_PASSWORD/);
    assert.equal(creates, 0); assert.equal(complete, false);
    process.env.BOOTSTRAP_ADMIN_PASSWORD = 'fixture-random-secret-47';
    assert.equal(await ensureBootstrapAdministrator(client), true);
    assert.equal(await bcrypt.compare(digestPasswordForStorage('fixture-random-secret-47'), existing.passwordHash), true);
    assert.equal(await bcrypt.compare(digestPasswordForStorage('LocalDemoOnly403!'), existing.passwordHash), false);
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const originalHash = existing.passwordHash;
    complete = false; existing.role = 'ADMIN'; existing.status = 'DISABLED';
    assert.equal(await ensureBootstrapAdministrator(client), false);
    assert.equal(existing.passwordHash, originalHash); assert.equal(existing.role, 'ADMIN'); assert.equal(existing.status, 'DISABLED');
    existing = null;
    assert.equal(await ensureBootstrapAdministrator(client), false);
    assert.equal(creates, 1);
  } finally {
    if (previousMode === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV'); else Object.assign(process.env, { NODE_ENV: previousMode });
    if (previousPassword === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD; else process.env.BOOTSTRAP_ADMIN_PASSWORD = previousPassword;
  }
});
