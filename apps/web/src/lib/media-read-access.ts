import type { User } from '@prisma/client';
import { AuthError } from './auth';
import { prisma } from './db';
import { liveChannels, type LiveChannel } from './media-read-token';

type MediaReadAccess = {
  candidateId: string;
  examId: string;
  examRequireFrontCamera: boolean | number;
  examRequireMiniProgram: boolean | number;
  requireFrontCamera: boolean | number;
  requireSecondCamera: boolean | number;
  allowed: boolean | number | bigint | null;
};

const pendingMediaReads = new Map<string, Promise<MediaReadAccess | undefined>>();

export async function authorizeMediaRead(user: User, sessionId: string, channel: string, checkRequired = true) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !liveChannels.includes(channel as LiveChannel)) throw new AuthError('直播参数不正确', 400);
  // HLS requests playlists, initialization files and parts concurrently. Share
  // only the in-flight snapshot across all three channels. Each request still
  // checks its own channel policy; completed permission decisions are not cached.
  const key = JSON.stringify([user.id, user.role, sessionId]);
  let pending = pendingMediaReads.get(key);
  if (!pending) {
    pending = readMediaAccess(user, sessionId);
    pendingMediaReads.set(key, pending);
  }
  let session: MediaReadAccess | undefined;
  try { session = await pending; }
  finally { if (pendingMediaReads.get(key) === pending) pendingMediaReads.delete(key); }
  if (!session) throw new AuthError('客户端会话不存在', 404);
  if (!session.allowed) throw new AuthError('无权查看该考生画面', 403);
  if (checkRequired && channel !== 'DESKTOP_SCREEN') {
    const required = channel === 'DESKTOP_CAMERA' ? session.requireFrontCamera : session.requireSecondCamera;
    if (!required) throw new AuthError('所在考室不要求该机位画面', 409);
  }
  return {
    candidateId: session.candidateId,
    examId: session.examId,
    exam: { requireFrontCamera: Boolean(session.examRequireFrontCamera), requireMiniProgram: Boolean(session.examRequireMiniProgram) }
  };
}

async function readMediaAccess(user: User, sessionId: string) {
  // A single indexed statement replaces the session/exam, administrator,
  // proctor and room round trips for every HLS part or MediaMTX callback.
  // All user-controlled values remain bound parameters, including the role.
  // Keep the room's WHERE EXISTS / LIMIT 1 shape used by Prisma findFirst;
  // multiple room assignments do not introduce a new ordering/policy rule.
  const sessions = await prisma.$queryRaw<MediaReadAccess[]>`
    SELECT cs.candidateId, cs.examId,
      e.requireFrontCamera AS examRequireFrontCamera,
      e.requireMiniProgram AS examRequireMiniProgram,
      COALESCE(r.requireFrontCamera, e.requireFrontCamera) AS requireFrontCamera,
      COALESCE(r.requireSecondCamera, e.requireMiniProgram) AS requireSecondCamera,
      (${user.role === 'SUPER_ADMIN'} OR e.createdById = ${user.id}
        OR EXISTS (SELECT 1 FROM ExamAdministrator ea WHERE ea.examId = cs.examId AND ea.userId = ${user.id})
        OR EXISTS (
          SELECT 1 FROM ExamRoomCandidate rc
          INNER JOIN ExamRoom pr ON pr.id = rc.roomId AND pr.examId = cs.examId
          INNER JOIN ExamRoomProctor rp ON rp.roomId = pr.id AND rp.userId = ${user.id}
          WHERE rc.candidateId = cs.candidateId
        )) AS allowed
    FROM ClientSession cs
    INNER JOIN Exam e ON e.id = cs.examId
    LEFT JOIN ExamRoom r ON r.id = (
      SELECT room.id FROM ExamRoom room
      WHERE room.examId = cs.examId AND EXISTS (
        SELECT 1 FROM ExamRoomCandidate rc
        WHERE rc.roomId = room.id AND rc.candidateId = cs.candidateId
      )
      LIMIT 1
    )
    WHERE cs.id = ${sessionId}
    LIMIT 1
  `;
  return sessions[0];
}
