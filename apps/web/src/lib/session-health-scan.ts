import { Prisma } from '@prisma/client';
import { prisma } from './db';

export const HEALTH_SCAN_PAGE_SIZE = 200;
const flexibleDeadline = Prisma.sql`CASE WHEN e.flexible = 1 AND e.contestRule NOT IN ('XCPC', 'ACM')
  THEN COALESCE(LEAST(e.endAt, TIMESTAMPADD(MINUTE, e.durationMinutes, COALESCE(c.startedAt, cs.startedAt))), e.endAt)
  ELSE e.endAt END`;

export async function nextHealthDeadline() {
  const [row] = await prisma.$queryRaw<{ deadline: Date | null }[]>(Prisma.sql`
    SELECT MIN(${flexibleDeadline}) AS deadline
    FROM ClientSession cs
    INNER JOIN Exam e ON e.id = cs.examId
    INNER JOIN Candidate c ON c.id = cs.candidateId AND c.examId = cs.examId
    WHERE cs.status IN ('WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE')
      AND cs.revokedAt IS NULL AND cs.syncImported = 0
  `);
  return row?.deadline ?? null;
}

/** Find only rows that can require a transition; recheck under the write lock. */
export async function healthSessionIds(examId: string | undefined, now: Date, afterId?: string) {
  const offlineCutoff = new Date(now.getTime() - 20_000);
  const secondCamera = Prisma.sql`COALESCE(r.requireSecondCamera, e.requireMiniProgram)`;
  const transition = Prisma.sql`
    (cs.desktopOfflineAt IS NULL AND (cs.lastDesktopSeenAt < ${offlineCutoff}
      OR (cs.lastDesktopSeenAt IS NULL AND COALESCE(cs.approvedAt, cs.createdAt) < ${offlineCutoff})))
    OR (${secondCamera} = 1 AND cs.miniProgramOfflineAt IS NULL AND (cs.lastMiniProgramSeenAt < ${offlineCutoff}
      OR (cs.lastMiniProgramSeenAt IS NULL AND COALESCE(cs.approvedAt, cs.createdAt) < ${offlineCutoff})))
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
    INNER JOIN Candidate c ON c.id = cs.candidateId AND c.examId = cs.examId
    LEFT JOIN ExamRoom r ON r.id = (
      SELECT room.id FROM ExamRoom room
      WHERE room.examId = cs.examId AND EXISTS (
        SELECT 1 FROM ExamRoomCandidate rc WHERE rc.roomId = room.id AND rc.candidateId = cs.candidateId
      ) LIMIT 1
    )
    WHERE cs.status IN ('WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE')
      AND cs.revokedAt IS NULL AND cs.syncImported = 0
      ${examId ? Prisma.sql`AND cs.examId = ${examId}` : Prisma.empty}
      ${afterId ? Prisma.sql`AND cs.id > ${afterId}` : Prisma.empty}
      AND (${transition})
    ORDER BY cs.id ASC
    LIMIT ${HEALTH_SCAN_PAGE_SIZE}
  `);
}
