import type { Prisma } from '@prisma/client';
import { prisma } from './db';

// Uploads hold an exam lock while heartbeats hold a session lock. Foreign-key
// checks can briefly conflict; retry the rolled-back database work only. File
// validation and immutable storage stay outside this transaction.
export async function withMediaSegmentWrite<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 });
    } catch (error) {
      if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2034') throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
