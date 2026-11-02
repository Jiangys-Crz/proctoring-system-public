import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
  });

// Route bundles and background workers must share the same pool in production
// too; otherwise each loaded bundle can open its own set of MySQL connections.
globalForPrisma.prisma = prisma;
