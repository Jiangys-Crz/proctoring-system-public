import { prisma } from './db';
import type { ClientSession } from '@prisma/client';
export async function canPublishChannel(session: Pick<ClientSession, 'examId' | 'candidateId' | 'status' | 'revokedAt'>, channel: string) {
  if (session.revokedAt || session.status === 'FINISHED') return false;
  // Check the end time in the same query as the room policy. MediaMTX calls
  // this on every stream connection, often three times per candidate at once.
  const room = await prisma.examRoom.findFirst({
    where: { examId: session.examId, exam: { endAt: { gt: new Date() } }, candidates: { some: { candidateId: session.candidateId } } },
    select: { requireFrontCamera: true, requireSecondCamera: true }
  });
  if (!room) return false;
  return channel === 'DESKTOP_SCREEN' || (channel === 'DESKTOP_CAMERA' && room.requireFrontCamera) || (channel === 'MOBILE_CAMERA' && room.requireSecondCamera);
}
