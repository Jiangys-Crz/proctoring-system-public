import type { Prisma } from '@prisma/client';
import { prisma } from './db';

/** Use the same Exam -> sync lock order for the worker and live configuration. */
export async function externalBoardTransaction<T>(examId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
        return operation(tx);
      });
    } catch (error) {
      if (attempt >= 2 || (error as { code?: string } | null)?.code !== 'P2034') throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
