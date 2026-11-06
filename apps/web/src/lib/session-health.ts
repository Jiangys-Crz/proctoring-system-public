import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { MonitorAlertState } from './monitor-alert-state';
import { withSessionWrite } from './session-write';
import { ACTIVE_CLIENT_SESSION_STATUSES } from './session-revocation';
import { effectiveEnd } from './contest-rules';
import { healthSessionIds, HEALTH_SCAN_PAGE_SIZE } from './session-health-scan';

const OFFLINE_GRACE_MS = 20_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;
// Scan only the state needed to decide whether to take a write lock. In
// particular, do not load candidate credentials or exam statements per tick.
const healthSessionSelect = {
  id: true, examId: true, createdAt: true, approvedAt: true, startedAt: true,
  lastDesktopSeenAt: true, lastMiniProgramSeenAt: true,
  desktopOfflineAt: true, miniProgramOfflineAt: true,
  candidate: { select: { startedAt: true, rooms: { select: { room: { select: { examId: true, requireSecondCamera: true } } } } } },
  exam: { select: { startAt: true, latestStartAt: true, endAt: true, durationMinutes: true, contestRule: true, flexible: true, requireMiniProgram: true } }
} satisfies Prisma.ClientSessionSelect;

const healthSessionInclude = {
  candidate: { select: { startedAt: true, status: true, rooms: healthSessionSelect.candidate.select.rooms } },
  exam: healthSessionSelect.exam,
} satisfies Prisma.ClientSessionInclude;
const healthWorker = globalThis as typeof globalThis & {
  sessionHealthTimer?: ReturnType<typeof setInterval>;
  sessionHealthBusy?: boolean;
  sessionHealthCheck?: () => Promise<number>;
  sessionHealthChecks?: Map<string, Promise<number>>;
};
const healthChecks = healthWorker.sessionHealthChecks ??= new Map<string, Promise<number>>();

async function* healthSnapshots(examId: string | undefined, now: Date) {
  let afterId: string | undefined;
  for (;;) {
    const ids = await healthSessionIds(examId, now, afterId);
    if (!ids.length) return;
    const sessions = await prisma.clientSession.findMany({
      where: { id: { in: ids.map(row => row.id) }, status: { in: [...ACTIVE_CLIENT_SESSION_STATUSES] } },
      select: healthSessionSelect,
    });
    for (const session of sessions) yield session;
    if (ids.length < HEALTH_SCAN_PAGE_SIZE) return;
    afterId = ids[ids.length - 1].id;
  }
}

export function staleHeartbeatSides(
  session: {
    lastDesktopSeenAt: Date | null;
    lastMiniProgramSeenAt: Date | null;
    approvedAt: Date | null;
    createdAt?: Date;
  },
  requireSecondCamera: boolean,
  cutoff: Date
) {
  const desktopReference = session.lastDesktopSeenAt || session.approvedAt || session.createdAt;
  const mobileReference = session.lastMiniProgramSeenAt || session.approvedAt || session.createdAt;
  return {
    desktop: Boolean(desktopReference && desktopReference < cutoff),
    secondCamera: requireSecondCamera && Boolean(mobileReference && mobileReference < cutoff)
  };
}

async function checkStaleSessionsOffline(examId?: string) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - OFFLINE_GRACE_MS);
  let alertsCreated = 0;
  for await (const observed of healthSnapshots(examId, now)) {
    const room = observed.candidate.rooms.find(({ room }) => room.examId === observed.examId)?.room;
    const requireSecondCamera = room?.requireSecondCamera ?? observed.exam.requireMiniProgram;
    const stale = staleHeartbeatSides(observed, requireSecondCamera, cutoff);
    const needsUpdate = (stale.desktop && !observed.desktopOfflineAt)
      || (stale.secondCamera && !observed.miniProgramOfflineAt)
      || (!requireSecondCamera && observed.miniProgramOfflineAt)
      || effectiveEnd(observed.exam, observed.candidate.startedAt || observed.startedAt) <= now;
    if (!needsUpdate) continue;
    alertsCreated += await withSessionWrite(observed.id, async (tx) => {
      const session = await tx.clientSession.findUnique({
        where: { id: observed.id },
        include: healthSessionInclude,
      });
      if (!session || session.status === 'FINISHED') return 0;
      if (effectiveEnd(session.exam, session.candidate.startedAt || session.startedAt) <= now) {
        await tx.clientSession.update({ where: { id: session.id }, data: { status: 'FINISHED', endedAt: session.endedAt || now, lockdown: false, lockdownReason: null } });
        await tx.candidate.update({ where: { id: session.candidateId }, data: { status: 'FINISHED' } });
        return 0;
      }
      let createdCount = 0;
      const monitorState = new MonitorAlertState(session.monitoringAlertState);
      const room = session.candidate.rooms.find(({ room }) => room.examId === session.examId)?.room;
      const requireSecondCamera = room?.requireSecondCamera ?? session.exam.requireMiniProgram;
      const stale = staleHeartbeatSides(session, requireSecondCamera, cutoff);


      if (stale.desktop && !session.desktopOfflineAt) {
        await tx.clientSession.update({ where: { id: session.id }, data: { desktopOfflineAt: now, status: 'OFFLINE' } });
        await tx.candidate.update({ where: { id: session.candidateId }, data: { status: 'OFFLINE', abnormal: true } });
        const result = await monitorState.report(tx, {
          examId: session.examId, candidateId: session.candidateId, sessionId: session.id,
          type: 'CLIENT_OFFLINE', severity: 4, message: '客户端掉线'
        }, { now });
        if (result.created) createdCount += 1;
      }
      if (stale.secondCamera && !session.miniProgramOfflineAt) {
        await tx.clientSession.update({ where: { id: session.id }, data: { miniProgramOfflineAt: now } });
        const candidateStatus = stale.desktop ? 'OFFLINE' : session.candidate.status === 'ONLINE_NORMAL' ? 'ONLINE_ABNORMAL' : session.candidate.status;
        await tx.candidate.update({ where: { id: session.candidateId }, data: { status: candidateStatus, abnormal: true } });
        const result = await monitorState.report(tx, {
          examId: session.examId, candidateId: session.candidateId, sessionId: session.id,
          type: 'SECOND_CAMERA_OFFLINE', severity: 4, message: '第二机位掉线'
        }, { now });
        if (result.created) createdCount += 1;
      }
      if (!requireSecondCamera && session.miniProgramOfflineAt) {
        await tx.clientSession.update({ where: { id: session.id }, data: { miniProgramOfflineAt: null } });
      }
      if (monitorState.changed) await tx.clientSession.update({ where: { id: session.id }, data: { monitoringAlertState: monitorState.toJson() } });
      return createdCount;
    });
  }

  return alertsCreated;
}

export async function markStaleSessionsOffline(examId?: string) {
  // Admin polling and the background worker must not start concurrent scans of
  // the same exam. A global scan also covers all exam-specific requests.
  const key = examId || '*';
  const running = healthChecks.get('*') || healthChecks.get(key);
  if (running) return running;
  // If an all-exam worker starts after scoped scans, let those finish before
  // reading fresh state. New scoped callers join this global scan below.
  const check = !examId && healthChecks.size
    ? Promise.allSettled([...healthChecks.values()]).then(() => checkStaleSessionsOffline())
    : checkStaleSessionsOffline(examId);
  healthChecks.set(key, check);
  try { return await check; }
  finally { if (healthChecks.get(key) === check) healthChecks.delete(key); }
}

export function startSessionHealthWorker(check = () => markStaleSessionsOffline()) {
  healthWorker.sessionHealthCheck = check;
  if (healthWorker.sessionHealthTimer) return;
  const run = async () => {
    if (healthWorker.sessionHealthBusy) return;
    healthWorker.sessionHealthBusy = true;
    try {
      await healthWorker.sessionHealthCheck?.();
    } catch (error) {
      console.error('Session health check failed', error);
    } finally {
      healthWorker.sessionHealthBusy = false;
    }
  };
  healthWorker.sessionHealthTimer = setInterval(run, HEALTH_CHECK_INTERVAL_MS);
  healthWorker.sessionHealthTimer.unref?.();
  void run();
}

/**
 * 考试截止时间已过时，将本场考试所有仍在进行/等待/离线中的会话与考生
 * 自动置为 FINISHED（已结束），避免考试结束后仍显示"考试中"。
 * 返回被更新的会话数与考生数。
 */
export async function finalizeEndedExam(exam: { id: string; endAt: Date }) {
  const now = new Date();
  if (exam.endAt > now) return { sessions: 0, candidates: 0 };
  const [sessions, candidates] = await prisma.$transaction([
    prisma.clientSession.updateMany({
      where: { examId: exam.id, status: { in: ['WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'] } },
      data: { status: 'FINISHED', endedAt: now, lockdown: false, lockdownReason: null }
    }),
    prisma.candidate.updateMany({
      where: { examId: exam.id, status: { in: ['REQUESTING', 'APPROVED', 'ONLINE_NORMAL', 'ONLINE_ABNORMAL', 'OFFLINE'] } },
      data: { status: 'FINISHED' }
    })
  ]);
  return { sessions: sessions.count, candidates: candidates.count };
}
