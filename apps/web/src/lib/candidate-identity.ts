import type { Prisma } from '@prisma/client';

export function candidateIdentityLookup(examId: string, school: string, exceptId?: string): Prisma.CandidateWhereInput {
  return {
    examId,
    school,
    ...(exceptId ? { id: { not: exceptId } } : {}),
  };
}
