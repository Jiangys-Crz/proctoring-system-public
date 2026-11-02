import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { SESSION_RELOGIN_OFFLINE_GRACE_MS } from './client-session-policy';

export const HEALTH_SCAN_PAGE_SIZE = 200;

/** Find only rows that can require a transition; recheck under the write lock. */
export async function healthSessionIds(examId: string | undefined, now: Date, afterId?: string, onlyRevocations = false) {
  const offlineCutoff = new Date(now.getTime() - 20_000);
  const revokeCutoff = new Date(now.getTime() - SESSION_RELOGIN_OFFLINE_GRACE_MS);
  const secondCamera = Prisma.sql`COALESCE(r.requireSecondCamera, e.requireMiniProgram)`;
  const fullyOffline = Prisma.sql`
    (cs.lastDesktopSeenAt <= ${revokeCutoff} OR (cs.lastDesktopSeenAt IS NULL AND cs.createdAt <= ${revokeCutoff}))
    AND (${secondCamera} = 0 OR cs.lastMiniProgramSeenAt <= ${revokeCutoff}
      OR (cs.lastMiniProgramSeenAt IS NULL AND cs.createdAt <= ${revokeCutoff}))
  `;
  const transition = onlyRevocations ? fullyOffline : Prisma.sql`
    (${fullyOffline})
    OR (cs.desktopOfflineAt IS NULL AND (cs.lastDesktopSeenAt < ${offlineCutoff}
      OR (cs.lastDesktopSeenAt IS NULL AND cs.approvedAt < ${offlineCutoff})))
    OR (${secondCamera} = 1 AND cs.miniProgramOfflineAt IS NULL AND (cs.lastMiniProgramSeenAt < ${offlineCutoff}
      OR (cs.lastMiniProgramSeenAt IS NULL AND cs.approvedAt < ${offlineCutoff})))
    OR (${secondCamera} = 0 AND cs.miniProgramOfflineAt IS NOT NULL)
    OR e.endAt <= ${now}
    OR (e.flexible = 1 AND e.contestRule NOT IN ('XCPC', 'ACM')
      AND TIMESTAMPADD(MINUTE, e.durationMinutes, COALESCE(c.startedAt, cs.startedAt)) <= ${now})
  `;
  // Use the current exam's room override, including an explicit false. A
  // missing optional phone must not hydrate every healthy candidate each tick.
  // The correlated room lookup mirrors the heartbeat's findFirst policy.
  return prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT cs.id
    FROM ClientSession cs
    INNER JOIN Exam e ON e.id = cs.examId
    INNER JOIN Candidate c ON c.id = cs.candidateId
    LEFT JOIN ExamRoom r ON r.id = (
      SELECT room.id FROM ExamRoom room
      WHERE room.examId = cs.examId AND EXISTS (
        SELECT 1 FROM ExamRoomCandidate rc WHERE rc.roomId = room.id AND rc.candidateId = cs.candidateId
      ) LIMIT 1
    )
    WHERE cs.status IN ('WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE')
      ${examId ? Prisma.sql`AND cs.examId = ${examId}` : Prisma.empty}
      ${afterId ? Prisma.sql`AND cs.id > ${afterId}` : Prisma.empty}
      AND (${transition})
    ORDER BY cs.id ASC
    LIMIT ${HEALTH_SCAN_PAGE_SIZE}
  `);
}
