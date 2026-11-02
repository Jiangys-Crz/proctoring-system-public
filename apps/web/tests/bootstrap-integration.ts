// Exercise the actual transaction, unique marker and row locks with disposable names only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/db';
import { BOOTSTRAP_ADMIN_MARKER, ensureBootstrapAdministrator } from '../src/lib/bootstrap-admin';
import { digestPasswordForStorage } from '../src/lib/password-crypto';

const marker = `bootstrap-qa-${randomUUID()}`;
const usernames: string[] = [];
const keys: string[] = [];

function isolatedClient(suffix: string) {
  const username = `${marker}-${suffix}`;
  const key = `${marker}.${suffix}`;
  usernames.push(username); keys.push(key);
  return {
    username, key,
    client: {
      $transaction: (callback: (tx: any) => Promise<boolean>, options: any) => prisma.$transaction(async tx => callback({
        systemSetting: {
          upsert: (query: any) => tx.systemSetting.upsert({ ...query, where: { key }, create: { ...query.create, key } }),
          findUnique: () => tx.systemSetting.findUnique({ where: { key } }),
          update: (query: any) => tx.systemSetting.update({ ...query, where: { key } }),
        },
        user: {
          findUnique: (query: any) => tx.user.findUnique({ ...query, where: { username } }),
          create: (query: any) => tx.user.create({ ...query, data: { ...query.data, username } }),
        },
        $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => tx.$queryRaw(strings,
          ...values.map(value => value === BOOTSTRAP_ADMIN_MARKER ? key : value)),
      }), options),
    } as any,
  };
}

try {
  const initial = isolatedClient('first');
  const results = await Promise.all([
    ensureBootstrapAdministrator(initial.client), ensureBootstrapAdministrator(initial.client), ensureBootstrapAdministrator(initial.client),
  ]);
  assert.equal(results.filter(Boolean).length, 1, 'concurrent workers create exactly one initial administrator');
  const created = await prisma.user.findUniqueOrThrow({ where: { username: initial.username } });
  assert.equal(created.role, 'SUPER_ADMIN');
  assert.equal(await bcrypt.compare(digestPasswordForStorage('LocalDemoOnly403!'), created.passwordHash!), true);
  assert.deepEqual((await prisma.systemSetting.findUniqueOrThrow({ where: { key: initial.key } })).value, { complete: true });
  await prisma.user.delete({ where: { id: created.id } });
  assert.equal(await ensureBootstrapAdministrator(initial.client), false);
  assert.equal(await prisma.user.count({ where: { username: initial.username } }), 0, 'deleting admin does not reset initialization');

  const upgraded = isolatedClient('existing');
  const existing = await prisma.user.create({ data: {
    username: upgraded.username, role: 'ADMIN', status: 'DISABLED', passwordHash: 'synthetic-changed-password', nickname: 'existing',
  } });
  assert.equal(await ensureBootstrapAdministrator(upgraded.client), false);
  assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: existing.id } }), existing, 'all existing account fields remain untouched');
  assert.deepEqual((await prisma.systemSetting.findUniqueOrThrow({ where: { key: upgraded.key } })).value, { complete: true });
  await prisma.user.delete({ where: { id: existing.id } });
  assert.equal(await ensureBootstrapAdministrator(upgraded.client), false);
  assert.equal(await prisma.user.count({ where: { username: upgraded.username } }), 0);
  console.log('PASS: real concurrent first-deployment transaction creates once; existing account preserved; persistent marker prevents recreation after deletion.');
} finally {
  await prisma.user.deleteMany({ where: { username: { in: usernames } } });
  await prisma.systemSetting.deleteMany({ where: { key: { in: keys } } });
  assert.equal(await prisma.user.count({ where: { username: { in: usernames } } }), 0);
  assert.equal(await prisma.systemSetting.count({ where: { key: { in: keys } } }), 0);
  await prisma.$disconnect();
}
