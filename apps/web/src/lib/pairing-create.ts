import { randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/** Recovery QR codes share the same six-digit namespace as initial logins. */
export async function createPairingSession(
  client: Pick<Prisma.TransactionClient, 'pairingSession'>,
  data: Omit<Prisma.PairingSessionUncheckedCreateInput, 'pairCode'>,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.pairingSession.create({ data: { ...data, pairCode: String(randomInt(100000, 1000000)) } });
    } catch (error) {
      if (attempt >= 9 || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') throw error;
    }
  }
}
