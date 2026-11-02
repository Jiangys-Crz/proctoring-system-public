import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { verifyClientTokenValueForSession } from './client-auth';

export const QA_EVENT_LOOKBACK_MS = 5 * 60_000;
export const QA_EVENT_OVERLAP_MS = 2_000;
export const qaEventSessionSelect = {
  id: true, examId: true, candidateId: true, revokedAt: true,
  desktopTokenHash: true, miniProgramTokenHash: true,
} as const satisfies Prisma.ClientSessionSelect;
export type QaEventSession = Prisma.ClientSessionGetPayload<{ select: typeof qaEventSessionSelect }>;
export type QaAnnouncement = { id: string; candidateId: string | null; content: string; createdAt: Date };
export type QaReply = { id: string; questionId: string; content: string; createdAt: Date; question: { candidateId: string } };
export type QaQuestionChange = { id: string; updatedAt: Date };
type Subscription = {
  sessionId: string; candidateId: string; token: string; since: number; cursor: number;
  seen: Map<string, number>; closed: boolean; send: (chunk: string) => void; close: () => void;
};
type ExamScan = { examId: string; subscribers: Set<Subscription>; scanning: boolean; stop: () => void; closed: boolean };
type Dependencies = {
  now?: () => number;
  schedule?: (scan: () => Promise<void>) => () => void;
  sessions: (ids: string[]) => Promise<QaEventSession[]>;
  announcements: (examId: string, lower: Date, upper: Date) => Promise<QaAnnouncement[]>;
  replies: (examId: string, lower: Date, upper: Date) => Promise<QaReply[]>;
  questions: (examId: string, lower: Date, upper: Date) => Promise<QaQuestionChange[]>;
};

export function qaSseEvent(event: string, data: unknown, id?: string) {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One polling loop per exam/process; session authorization is never cached. */
export function createQaEventHub(dependencies: Dependencies) {
  const groups = new Map<string, ExamScan>();
  // A canceled group can still have database reads in flight. Reconnecting
  // must not bypass that work's single-flight guard by creating a new group.
  const examsReading = new Set<string>();
  const now = dependencies.now || Date.now;
  const schedule = dependencies.schedule || (scan => {
    const timer = setInterval(() => void scan(), 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  });

  function close(group: ExamScan, subscription: Subscription) {
    if (subscription.closed) return;
    subscription.closed = true;
    subscription.seen.clear();
    group.subscribers.delete(subscription);
    try { subscription.close(); } catch { /* The HTTP stream may already be canceled. */ }
    if (!group.subscribers.size) {
      group.closed = true;
      group.stop();
      if (groups.get(group.examId) === group) groups.delete(group.examId);
    }
  }

  function send(group: ExamScan, subscription: Subscription, chunk: string) {
    if (subscription.closed || group.closed) return false;
    try { subscription.send(chunk); return true; }
    catch { close(group, subscription); return false; }
  }

  async function scan(group: ExamScan) {
    if (group.closed || group.scanning || examsReading.has(group.examId) || !group.subscribers.size) return;
    group.scanning = true;
    examsReading.add(group.examId);
    // New subscriptions arriving during this read join the following tick.
    // Their cursor extends the shared window without per-client queries.
    const subscribers = [...group.subscribers];
    const upper = new Date(now());
    const earliest = +upper - QA_EVENT_LOOKBACK_MS;
    const lower = new Date(Math.max(earliest, subscribers.reduce((minimum, item) => Math.min(minimum, item.cursor - QA_EVENT_OVERLAP_MS), +upper)));
    try {
      const results = await Promise.allSettled([
        dependencies.sessions([...new Set(subscribers.map(item => item.sessionId))]),
        dependencies.announcements(group.examId, lower, upper),
        dependencies.replies(group.examId, lower, upper),
        dependencies.questions(group.examId, lower, upper),
      ]);
      if (group.closed) return;
      const value = <T>(result: PromiseSettledResult<T>): T => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      };
      const sessions = value(results[0]);
      const currentSessions = new Map(sessions.map(session => [session.id, session]));
      for (const subscription of subscribers) {
        if (subscription.closed) continue;
        const session = currentSessions.get(subscription.sessionId);
        if (!session || session.examId !== group.examId || session.candidateId !== subscription.candidateId
          || !(verifyClientTokenValueForSession(subscription.token, session, 'DESKTOP')
            || verifyClientTokenValueForSession(subscription.token, session, 'MINIPROGRAM'))) {
          close(group, subscription);
        }
      }
      const announcements = value(results[1]), replies = value(results[2]), questions = value(results[3]);
      for (const subscription of subscribers) {
        if (subscription.closed) continue;
        const cutoff = Math.max(subscription.since, subscription.cursor - QA_EVENT_OVERLAP_MS, earliest);
        const isNew = (key: string, timestamp: Date) => {
          const time = +timestamp;
          if (time <= subscription.since || time < cutoff || time > +upper || subscription.seen.has(key)) return false;
          // Old catch-up rows fall outside the next overlap automatically.
          if (time >= +upper - QA_EVENT_OVERLAP_MS) subscription.seen.set(key, time);
          return true;
        };
        for (const announcement of announcements) {
          if ((announcement.candidateId === null || announcement.candidateId === subscription.candidateId)
            && isNew(`announcement:${announcement.id}`, announcement.createdAt)) {
            if (!send(group, subscription, qaSseEvent('announcement', announcement, announcement.id))) break;
          }
        }
        if (subscription.closed) continue;
        for (const reply of replies) {
          if (reply.question.candidateId === subscription.candidateId && isNew(`reply:${reply.id}`, reply.createdAt)) {
            const { question: _owner, ...payload } = reply;
            if (!send(group, subscription, qaSseEvent('reply', payload, reply.id))) break;
          }
        }
        if (subscription.closed) continue;
        // A withdrawal no longer has isPublished=true. Broadcast an opaque
        // invalidation so readers drop previously public text on refresh;
        // private IDs, authors and content are never pushed to peers.
        let changed = false;
        for (const question of questions) {
          if (isNew(`question:${question.id}:${+question.updatedAt}`, question.updatedAt)) changed = true;
        }
        if (changed && !send(group, subscription, qaSseEvent('refresh', { reason: 'question' }))) continue;
        if (!send(group, subscription, `: keepalive ${upper.toISOString()}\n\n`)) continue;
        subscription.cursor = +upper;
        for (const [key, timestamp] of subscription.seen) {
          if (timestamp < +upper - QA_EVENT_OVERLAP_MS) subscription.seen.delete(key);
        }
        // Bound metadata even during extreme bursts in the overlap window.
        if (subscription.seen.size > 4000) close(group, subscription);
      }
    } catch {
      // No partial batch is delivered and no cursor advances on database error.
      for (const subscription of subscribers) send(group, subscription, qaSseEvent('error', { message: '答疑推送暂时不可用，正在重试' }));
    } finally { group.scanning = false; examsReading.delete(group.examId); }
  }

  return {
    subscribe(input: { session: Pick<QaEventSession, 'id' | 'examId' | 'candidateId'>; token: string; since?: Date; send: Subscription['send']; close: Subscription['close'] }) {
      const currentTime = now();
      const requested = input.since && Number.isFinite(+input.since) ? +input.since : currentTime;
      const since = Math.min(currentTime, Math.max(currentTime - QA_EVENT_LOOKBACK_MS, requested));
      const subscription: Subscription = {
        sessionId: input.session.id, candidateId: input.session.candidateId, token: input.token, since, cursor: since,
        seen: new Map(), closed: false, send: input.send, close: input.close,
      };
      let group = groups.get(input.session.examId);
      if (!group) {
        group = { examId: input.session.examId, subscribers: new Set(), scanning: false, closed: false, stop: () => {} };
        groups.set(group.examId, group);
        const selected = group;
        group.stop = schedule(() => scan(selected));
      }
      group.subscribers.add(subscription);
      const selected = group;
      return () => close(selected, subscription);
    }
  };
}

export const qaEventHub = createQaEventHub({
  sessions: ids => prisma.clientSession.findMany({ where: { id: { in: ids } }, select: qaEventSessionSelect }),
  announcements: (examId, lower, upper) => prisma.examAnnouncement.findMany({
    where: { examId, createdAt: { gte: lower, lte: upper } },
    select: { id: true, candidateId: true, content: true, createdAt: true }, orderBy: { createdAt: 'asc' },
  }),
  replies: async (examId, lower, upper) => {
    // Prisma's nested relation projection otherwise adds a second SQL query.
    const rows = await prisma.$queryRaw<Array<{ id: string; questionId: string; content: string; createdAt: Date; candidateId: string }>>`
      SELECT m.id, m.questionId, m.content, m.createdAt, q.candidateId
      FROM ExamQuestionMessage AS m INNER JOIN ExamQuestion AS q ON q.id = m.questionId
      WHERE q.examId = ${examId} AND m.sender = 'ADMIN' AND m.createdAt >= ${lower} AND m.createdAt <= ${upper}
      ORDER BY m.createdAt ASC
    `;
    return rows.map(({ candidateId, ...row }) => ({ ...row, question: { candidateId } }));
  },
  questions: (examId, lower, upper) => prisma.examQuestion.findMany({
    where: { examId, updatedAt: { gte: lower, lte: upper } }, select: { id: true, updatedAt: true }, orderBy: { updatedAt: 'asc' },
  }),
});
