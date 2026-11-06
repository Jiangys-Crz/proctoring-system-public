import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClientSession, Prisma } from '@prisma/client';
import { revokeSupersededSession } from '../src/lib/session-revocation';
import { createPairSecret, hashPairSecret, verifyPairSecret } from '../src/lib/pairing-security';
import { ensureBootstrapAdministrator } from '../src/lib/bootstrap-admin';
import { digestPasswordForStorage } from '../src/lib/password-crypto';
import bcrypt from 'bcryptjs';

test('replacement login revokes both tokens and pairing secrets without changing personal time', async () => {
  const now = new Date();
  const old = new Date(now.getTime() - 120_001);
  const session = { id: 's', candidateId: 'c', loginRequestId: 'l', status: 'IN_EXAM', createdAt: old, startedAt: old, lastDesktopSeenAt: old, lastMiniProgramSeenAt: old } as ClientSession;
  let written: any; let candidateWrites = 0; let pairWrite: any;
  const tx = { clientSession: { update: async (q: any) => { written = q.data; }, count: async () => 1 },
    candidate: { update: async () => { candidateWrites++; } }, pairingSession: { updateMany: async (q: any) => { pairWrite = q.data; } }, loginRequest: { updateMany: async () => ({ count: 0 }) } } as unknown as Prisma.TransactionClient;
  assert.equal(await revokeSupersededSession(tx, session, now), true);
  assert.equal(written.desktopTokenHash, null); assert.equal(written.miniProgramTokenHash, null);
  assert.equal(written.revokedAt, now); assert.equal(written.status, 'FINISHED');
  assert.equal('startedAt' in written, false); assert.equal(candidateWrites, 0);
  assert.equal(pairWrite.pollTokenHash, null); assert.equal(pairWrite.recoveryTokenHash, null);
  assert.equal(await revokeSupersededSession(tx, { ...session, status: 'FINISHED' }, now), false);
});

test('pair secrets are 256 bits, stored as hashes, checked in their own purpose', () => {
  const poll = createPairSecret('POLL'); const recovery = createPairSecret('RECOVERY');
  assert.equal(Buffer.from(poll.secret, 'base64url').byteLength, 32);
  assert.notEqual(poll.secret, poll.hash); assert.notEqual(poll.secret, recovery.secret);
  assert.equal(verifyPairSecret('POLL', poll.secret, poll.hash), true);
  assert.equal(verifyPairSecret('RECOVERY', poll.secret, poll.hash), false);
  assert.equal(verifyPairSecret('RECOVERY', recovery.secret, recovery.hash), true);
  assert.equal(verifyPairSecret('POLL', '123456', hashPairSecret('POLL', '123456')), false);
});

test('first boot creates expected admin; later boots preserve password and role without updates', async () => {
  let existing: any = null; let creates = 0;
  let marker: any = { value: { complete: false } };
  const tx: any = { $queryRaw: async () => [], systemSetting: { upsert: async () => marker, findUnique: async () => marker, update: async ({ data }: any) => { marker = data; } }, user: { findUnique: async () => existing, create: async ({ data }: any) => { creates++; existing = { id: 'admin', ...data }; return existing; } } };
  const client: any = { $transaction: async (callback: any) => callback(tx) };
  assert.equal(await ensureBootstrapAdministrator(client), true);
  assert.equal(existing.username, 'admin'); assert.equal(existing.role, 'SUPER_ADMIN');
  assert.equal(await bcrypt.compare(digestPasswordForStorage('LocalDemoOnly403!'), existing.passwordHash), true);
  existing = { id: 'admin', passwordHash: 'administrator-changed-password', role: 'ADMIN', status: 'DISABLED' };
  assert.equal(await ensureBootstrapAdministrator(client), false);
  assert.equal(creates, 1); assert.equal(existing.passwordHash, 'administrator-changed-password'); assert.equal(existing.role, 'ADMIN'); assert.equal(existing.status, 'DISABLED');
  existing = null;
  assert.equal(await ensureBootstrapAdministrator(client), false);
  assert.equal(existing, null, 'deleted admin is never recreated after initial deployment');
});

test('concurrent first boot preserves the account created by another worker', async () => {
  let reads = 0;
  let complete = false;
  const tx: any = { $queryRaw: async () => [], systemSetting: { upsert: async () => ({}), findUnique: async () => ({ value: { complete } }), update: async () => { complete = true; } }, user: { findUnique: async () => ++reads === 1 ? null : { id: 'existing' }, create: async () => { throw Object.assign(new Error('unique constraint'), { code: 'P2002' }); } } };
  const client: any = { $transaction: async (callback: any) => callback(tx) };
  assert.equal(await ensureBootstrapAdministrator(client), false);
});

test('an existing admin is marked initialized without resetting or promoting it on first upgraded boot', async () => {
  let marker: any = { value: { complete: false } }; let adminReads = 0;
  const tx: any = { $queryRaw: async () => [], systemSetting: { upsert: async () => marker, findUnique: async () => marker,
    update: async ({ data }: any) => { marker = data; } }, user: { findUnique: async () => { adminReads++; return { id: 'existing-admin', role: 'ADMIN', status: 'DISABLED' }; },
    create: async () => { assert.fail('existing account must never be replaced'); } } };
  const client: any = { $transaction: async (callback: any) => callback(tx) };
  assert.equal(await ensureBootstrapAdministrator(client), false);
  assert.equal(marker.value.complete, true);
  tx.user.findUnique = async () => { assert.fail('finished bootstrap must not search or recreate deleted admin'); };
  assert.equal(await ensureBootstrapAdministrator(client), false); assert.equal(adminReads, 1);
});
