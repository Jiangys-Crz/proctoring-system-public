import type { User } from '@prisma/client';
import { prisma } from './db';

export async function canManageExam(user: User, examId: string) {
  if (user.role === 'SUPER_ADMIN') return true;
  return Boolean(await prisma.exam.findFirst({
    where: { id: examId, OR: [{ createdById: user.id }, { administrators: { some: { userId: user.id } } }] },
    select: { id: true }
  }));
}

export async function getExamAccess(user: User, examId: string) {
  const manageable = await canManageExam(user, examId);
  if (manageable) return { accessible: true, manageable };
  const count = await prisma.examRoomProctor.count({
    where: {
      userId: user.id,
      room: { examId }
    }
  });
  return { accessible: count > 0, manageable };
}

export async function canAccessExam(user: User, examId: string) {
  return (await getExamAccess(user, examId)).accessible;
}

export async function canAccessHydroProblem(user: User, hydroProblemId: string) {
  if (user.role === 'SUPER_ADMIN') return true;
  return Boolean(await prisma.examProblem.findFirst({
    where: {
      hydroProblemId,
      exam: {
        OR: [
          { createdById: user.id },
          { administrators: { some: { userId: user.id } } },
          { rooms: { some: { proctors: { some: { userId: user.id } } } } }
        ]
      }
    },
    select: { id: true }
  }));
}

export async function canAccessCandidate(user: User, candidateId: string) {
  if (user.role === 'SUPER_ADMIN') return true;
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { examId: true } });
  if (!candidate) return false;
  if (await canManageExam(user, candidate.examId)) return true;
  const count = await prisma.examRoomCandidate.count({
    where: {
      candidateId,
      room: {
        proctors: {
          some: { userId: user.id }
        }
      }
    }
  });
  return count > 0;
}
