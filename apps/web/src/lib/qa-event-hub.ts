import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { localQaContent, qaAnnouncementVisibility } from './qa-thread';
import { verifyClientTokenValueForSession } from './client-auth';
import { createRequestAdmission } from './request-admission';

export const QA_EVENT_LOOKBACK_MS = 5 * 60_000;
export const QA_EVENT_OVERLAP_MS = 2_000;
const QA_EVENT_BATCH_LIMIT = 200;
const QA_EVENT_RECEIPT_LIMIT = 4000;
const MAX_SUBSCRIPTIONS = 4096;
const MAX_SESSION_SUBSCRIPTIONS = 4;
const MAX_EXAMS = 128;
export class QaEventCapacityError extends Error {
  readonly code = 'PROCTOR_QA_EVENT_CAPACITY';
  constructor() { super('答疑推送连接繁忙，请稍后重试'); }
}
export const qaEventSessionSelect = {
  id: true, examId: true, candidateId: true, revokedAt: true,
  desktopTokenHash: true, miniProgramTokenHash: true,
} as const satisfies Prisma.ClientSessionSelect;
export type QaEventSession = Prisma.ClientSessionGetPayload<{ select: typeof qaEventSessionSelect }>;
export type QaAnnouncement = { id: string; candidateId: string | null; content: string; createdAt: Date; deliveredAt?: Date | null };
export type QaReply = { id: string; questionId: string; content: string; createdAt: Date; deliveredAt?: Date | null; question: { candidateId: string } };
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
  receipts?: (examId: string, announcementIds: string[], candidateIds: string[]) => Promise<Array<{ announcementId: string; candidateId: string }>>;
};

export function qaSseEvent(event: string, data: unknown, id?: string) {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One polling loop per exam/process; session authorization is never cached. */
export function createQaEventHub(dependencies: Dependencies) {
  const groups = new Map<string, ExamScan>();
  const sessionSubscriptions = new Map<string, number>();
  let subscriptions = 0;
  // FIFO waiting keeps many exam timers from borrowing DB connections at
  // once, without permanently favoring the first two timers on every tick.
  const acquireScan = createRequestAdmission(2, MAX_EXAMS, 1000);
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
    subscriptions--;
    const remaining = (sessionSubscriptions.get(subscription.sessionId) || 1) - 1;
    if (remaining) sessionSubscriptions.set(subscription.sessionId, remaining);
    else sessionSubscriptions.delete(subscription.sessionId);
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
    let release: (() => void) | undefined;
    try {
      try { release = await acquireScan(); } catch { return; }
      if (group.closed) return;
      await scanAdmitted(group);
    } finally {
      release?.(); group.scanning = false; examsReading.delete(group.examId);
    }
  }

  async function scanAdmitted(group: ExamScan) {
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
      const overflow = [announcements, replies, questions].some(items => items.length > QA_EVENT_BATCH_LIMIT);
      const wouldBeNew = (subscription: Subscription, key: string, timestamp: Date) => {
        const time = +timestamp, cutoff = Math.max(subscription.since, subscription.cursor - QA_EVENT_OVERLAP_MS, earliest);
        return time > subscription.since && time >= cutoff && time <= +upper && !subscription.seen.has(key);
      };
      const receiptCandidates = new Set<string>(), receiptAnnouncements = new Set<string>();
      if (!overflow && dependencies.receipts) for (const subscription of subscribers) {
        if (subscription.closed) continue;
        for (const announcement of announcements) {
          if ((announcement.candidateId === null || announcement.candidateId === subscription.candidateId)
            && wouldBeNew(subscription, `announcement:${announcement.id}`, announcement.deliveredAt || announcement.createdAt)) {
            receiptCandidates.add(subscription.candidateId); receiptAnnouncements.add(announcement.id);
          }
        }
      }
      const receipts = receiptCandidates.size && dependencies.receipts
        ? await dependencies.receipts(group.examId, [...receiptAnnouncements], [...receiptCandidates]) : [];
      const receiptOverflow = receipts.length > QA_EVENT_RECEIPT_LIMIT;
      const confirmed = new Set(receipts.map(row => `${row.announcementId}:${row.candidateId}`));
      // One global notice can have thousands of eligible readers. Serialize
      // once per batch, after each reader's fresh scope/receipt checks below.
      const eventChunks = new Map<string, string>();
      const eventChunk = (key: string, build: () => string) => {
        let chunk = eventChunks.get(key);
        if (chunk === undefined) { chunk = build(); eventChunks.set(key, chunk); }
        return chunk;
      };
      for (const subscription of subscribers) {
        if (subscription.closed) continue;
        const isNew = (key: string, timestamp: Date) => {
          const time = +timestamp;
          if (!wouldBeNew(subscription, key, timestamp)) return false;
          // Old catch-up rows fall outside the next overlap automatically.
          if (time >= +upper - QA_EVENT_OVERLAP_MS) subscription.seen.set(key, time);
          return true;
        };
        if (overflow) {
          // The normal QA endpoint drains durable unread batches. A large
          // reconnect window needs one opaque invalidation, not an unbounded
          // payload/query fan-out; no receipt or persisted sync cursor changes.
          if (!send(group, subscription, qaSseEvent('refresh', { reason: 'question' }))) continue;
        } else {
          let changed = false;
          for (const announcement of announcements) {
            if ((announcement.candidateId === null || announcement.candidateId === subscription.candidateId)
              && !confirmed.has(`${announcement.id}:${subscription.candidateId}`) && isNew(`announcement:${announcement.id}`, announcement.deliveredAt || announcement.createdAt)) {
              // An incomplete receipt set is not proof of an unread notice.
              // Refresh only eligible readers, rather than the whole exam.
              if (receiptOverflow) { changed = true; continue; }
              if (!send(group, subscription, eventChunk(`announcement:${announcement.id}`,
                () => qaSseEvent('announcement', { ...announcement, content: localQaContent(announcement.content) }, announcement.id)))) break;
            }
          }
          if (subscription.closed) continue;
          for (const reply of replies) {
            if (reply.question.candidateId === subscription.candidateId && isNew(`reply:${reply.id}`, reply.deliveredAt || reply.createdAt)) {
              const { question: _owner, ...payload } = reply;
              if (!send(group, subscription, eventChunk(`reply:${reply.id}`,
                () => qaSseEvent('reply', { ...payload, content: localQaContent(payload.content) }, reply.id)))) break;
            }
          }
          if (subscription.closed) continue;
          // A withdrawal no longer has isPublished=true. Broadcast an opaque
          // invalidation so readers drop previously public text on refresh;
          // private IDs, authors and content are never pushed to peers.
          for (const question of questions) {
            if (isNew(`question:${question.id}:${+question.updatedAt}`, question.updatedAt)) changed = true;
          }
          if (changed && !send(group, subscription, qaSseEvent('refresh', { reason: 'question' }))) continue;
        }
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
    }
  }

  return {
    subscribe(input: { session: Pick<QaEventSession, 'id' | 'examId' | 'candidateId'>; token: string; since?: Date; send: Subscription['send']; close: Subscription['close'] }) {
      const sessionCount = sessionSubscriptions.get(input.session.id) || 0;
      if (subscriptions >= MAX_SUBSCRIPTIONS || sessionCount >= MAX_SESSION_SUBSCRIPTIONS
        || (!groups.has(input.session.examId) && groups.size >= MAX_EXAMS)) throw new QaEventCapacityError();
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
        try { group.stop = schedule(() => scan(selected)); }
        catch (error) { groups.delete(group.examId); throw error; }
      }
      group.subscribers.add(subscription);
      subscriptions++;
      sessionSubscriptions.set(input.session.id, sessionCount + 1);
      const selected = group;
      return () => close(selected, subscription);
    }
  };
}

export const qaEventHub = createQaEventHub({
  sessions: ids => prisma.clientSession.findMany({ where: { id: { in: ids } }, select: qaEventSessionSelect }),
  announcements: (examId, lower, upper) => prisma.examAnnouncement.findMany({
    where: { AND: [qaAnnouncementVisibility(), { OR: [{ deliveredAt: { gte: lower, lte: upper } }, { deliveredAt: null, createdAt: { gte: lower, lte: upper } }] }], examId },
    select: { id: true, candidateId: true, content: true, createdAt: true, deliveredAt: true }, orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }],
    take: QA_EVENT_BATCH_LIMIT + 1,
  }),
  replies: async (examId, lower, upper) => {
    // Prisma's nested relation projection otherwise adds a second SQL query.
    const rows = await prisma.$queryRaw<Array<{ id: string; questionId: string; content: string; createdAt: Date; deliveredAt: Date | null; candidateId: string }>>`
      SELECT m.id, m.questionId, m.content, m.createdAt, m.deliveredAt, q.candidateId
      FROM ExamQuestionMessage AS m INNER JOIN ExamQuestion AS q ON q.id = m.questionId
      WHERE q.examId = ${examId} AND m.sender = 'ADMIN' AND m.acknowledgedAt IS NULL AND ((m.deliveredAt >= ${lower} AND m.deliveredAt <= ${upper}) OR (m.deliveredAt IS NULL AND m.createdAt >= ${lower} AND m.createdAt <= ${upper}))
      ORDER BY m.deliveredAt ASC, m.id ASC
      LIMIT ${QA_EVENT_BATCH_LIMIT + 1}
    `;
    return rows.map(({ candidateId, ...row }) => ({ ...row, question: { candidateId } }));
  },
  receipts: (examId, announcementIds, candidateIds) => prisma.examAnnouncementReceipt.findMany({ where: { announcementId: { in: announcementIds }, candidateId: { in: candidateIds }, announcement: { examId } }, select: { announcementId: true, candidateId: true }, take: QA_EVENT_RECEIPT_LIMIT + 1 }),
  questions: (examId, lower, upper) => prisma.examQuestion.findMany({
    where: { examId, updatedAt: { gte: lower, lte: upper } }, select: { id: true, updatedAt: true }, orderBy: { updatedAt: 'asc' },
    take: QA_EVENT_BATCH_LIMIT + 1,
  }),
});
