import { prisma } from './db';
import type { ClientSession, Prisma } from '@prisma/client';
import { effectiveEnd } from './contest-rules';

type Session = Pick<ClientSession, 'examId' | 'candidateId' | 'startedAt' | 'status' | 'revokedAt'>;
export async function canPublishChannel(session: Session, channel: string,
  db: Pick<Prisma.TransactionClient, 'examRoom'> = prisma) {
  if (session.revokedAt || session.status === 'FINISHED') return false;
  // Use the same deadline as heartbeat, including a flexible candidate's
  // individual start and duration, without ignoring the current room policy.
  const candidates = { candidateId: session.candidateId, candidate: { examId: session.examId } };
  const room = await db.examRoom.findFirst({
    where: { examId: session.examId, exam: { endAt: { gt: new Date() } }, candidates: { some: candidates } },
    select: {
      requireFrontCamera: true, requireSecondCamera: true,
      exam: { select: { startAt: true, endAt: true, latestStartAt: true, contestRule: true, flexible: true, durationMinutes: true } },
      candidates: { where: candidates, take: 1, select: { candidate: { select: { startedAt: true } } } },
    },
  });
  if (!room || !(channel === 'DESKTOP_SCREEN' || (channel === 'DESKTOP_CAMERA' && room.requireFrontCamera) ||
    (channel === 'MOBILE_CAMERA' && room.requireSecondCamera))) return false;
  const end = effectiveEnd(room.exam, room.candidates[0]?.candidate.startedAt || session.startedAt);
  return +end > Date.now();
}
