import { prisma } from '../src/lib/db';

// Run after Prisma has added XCPC to databases whose enum only accepted ACM.
try {
  const normalized = await prisma.exam.updateMany({ where: { contestRule: 'ACM' }, data: { contestRule: 'XCPC' } });
  console.log(`Normalized ${normalized.count} legacy ACM exams to XCPC.`);
} finally { await prisma.$disconnect(); }
