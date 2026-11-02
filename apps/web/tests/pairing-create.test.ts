import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { createPairingSession } from '../src/lib/pairing-create';

test('initial and recovery QR codes retry a database collision without changing their secrets or bindings', async () => {
  for (const purpose of ['INITIAL', 'RECOVERY', 'TEST_DESKTOP_RECOVERY']) {
    let attempts = 0;
    const data = { purpose, desktopDeviceId: 'desktop', recoverySessionId: 'session', pollTokenHash: 'poll-hash', recoveryTokenHash: 'recovery-hash', expiresAt: new Date(Date.now() + 300_000) };
    const client = { pairingSession: { create: async (input: { data: typeof data & { pairCode: string } }) => {
      attempts++;
      assert.match(input.data.pairCode, /^[1-9][0-9]{5}$/);
      const { pairCode, ...binding } = input.data;
      assert.deepEqual(binding, data);
      if (attempts === 1) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      return { id: 'pairing', ...input.data };
    } } } as unknown as Pick<Prisma.TransactionClient, 'pairingSession'>;
    const pairing = await createPairingSession(client, data);
    assert.equal(attempts, 2);
    assert.equal(pairing.purpose, purpose);
  }
});

test('QR creation propagates connection failures without a retry storm', async () => {
  let attempts = 0;
  const error = Object.assign(new Error('Connection unavailable'), { code: 'P2024' });
  const client = { pairingSession: { create: async () => { attempts++; throw error; } } } as unknown as Pick<Prisma.TransactionClient, 'pairingSession'>;
  await assert.rejects(createPairingSession(client, { desktopDeviceId: 'desktop', expiresAt: new Date() }), error);
  assert.equal(attempts, 1);
});
