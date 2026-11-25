import type { Prisma, User } from '@prisma/client';
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
        examId: candidate.examId,
        proctors: {
          some: { userId: user.id }
        }
      }
    }
  });
  return count > 0;
}

export function candidateRoomScope(examId: string, userId: string): Prisma.CandidateWhereInput {
  return { examId, rooms: { some: { room: { examId, proctors: { some: { userId } } } } } };
}

export async function proctoredCandidateIds(userId: string) {
  const rows = await prisma.$queryRaw<{ candidateId: string }[]>`
    SELECT DISTINCT rc.candidateId FROM ExamRoomCandidate rc
    INNER JOIN Candidate c ON c.id = rc.candidateId
    INNER JOIN ExamRoom r ON r.id = rc.roomId AND r.examId = c.examId
    INNER JOIN ExamRoomProctor p ON p.roomId = r.id AND p.userId = ${userId}
  `;
  return rows.map(row => row.candidateId);
}
