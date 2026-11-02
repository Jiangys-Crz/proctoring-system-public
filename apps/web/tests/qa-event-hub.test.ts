import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQaEventHub, QA_EVENT_LOOKBACK_MS, type QaAnnouncement, type QaEventSession, type QaQuestionChange, type QaReply } from '../src/lib/qa-event-hub';
import { hashClientSessionToken } from '../src/lib/client-auth';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let clock = 1_800_000_000_000;
  const sessions = new Map<string, QaEventSession>();
  const announcements: Array<QaAnnouncement & { examId: string }> = [];
  const replies: Array<QaReply & { examId: string }> = [];
  const questions: Array<QaQuestionChange & { examId: string }> = [];
  const tasks = new Set<() => Promise<void>>();
  const counts = { sessions: 0, announcements: 0, replies: 0, questions: 0 };
  const windows: Array<{ examId: string; lower: number; upper: number }> = [];
  const idsRead: string[][] = [];
  let held: Promise<void> | undefined, fail = false;
  const hub = createQaEventHub({
    now: () => clock,
    schedule: task => { tasks.add(task); return () => tasks.delete(task); },
    sessions: async ids => { counts.sessions++; idsRead.push(ids); await held; return ids.flatMap(id => sessions.has(id) ? [{ ...sessions.get(id)! }] : []); },
    announcements: async (examId, lower, upper) => {
      counts.announcements++; windows.push({ examId, lower: +lower, upper: +upper });
      if (fail) throw new Error('private database diagnostic');
      return announcements.filter(item => item.examId === examId && item.createdAt >= lower && item.createdAt <= upper)
        .map(({ examId: _exam, ...item }) => item);
    },
    replies: async (examId, lower, upper) => { counts.replies++; return replies.filter(item => item.examId === examId && item.createdAt >= lower && item.createdAt <= upper).map(({ examId: _exam, ...item }) => item); },
    questions: async (examId, lower, upper) => { counts.questions++; return questions.filter(item => item.examId === examId && item.updatedAt >= lower && item.updatedAt <= upper).map(({ examId: _exam, ...item }) => item); },
  });
  const subscribe = (index: number, since = clock - 1000, examId = 'exam', side: 'desktop' | 'phone' = 'desktop') => {
    const id = `${examId}-session-${index}`;
    const session = sessions.get(id) || { id, examId, candidateId: `${examId}-candidate-${index}`, revokedAt: null,
      desktopTokenHash: hashClientSessionToken(`desktop-${id}`), miniProgramTokenHash: hashClientSessionToken(`phone-${id}`) };
    sessions.set(id, session);
    const chunks: string[] = [];
    let closed = 0, rejectWrites = false;
    const stop = hub.subscribe({ session, token: `${side}-${id}`, since: new Date(since),
      send: chunk => { assert.equal(closed, 0, 'must never write after closure'); if (rejectWrites) throw new Error('closed reader'); chunks.push(chunk); }, close: () => { closed++; } });
    return { session, chunks, stop, get closed() { return closed; }, reject() { rejectWrites = true; } };
  };
  return { hub, sessions, announcements, replies, questions, tasks, counts, windows, idsRead, subscribe,
    get now() { return clock; }, tick(ms = 1000) { clock += ms; }, hold(promise?: Promise<void>) { held = promise; }, fail(value: boolean) { fail = value; },
    scan: () => Promise.all([...tasks].map(task => task())),
  };
}

test('33 concurrent subscriptions share four reads per tick and never receive another candidate private content', async () => {
  const f = fixture();
  const subscribers = Array.from({ length: 33 }, (_, index) => f.subscribe(index));
  f.announcements.push({ examId: 'exam', id: 'global', candidateId: null, content: 'for everyone', createdAt: new Date(f.now - 500) },
    { examId: 'exam', id: 'private', candidateId: subscribers[0].session.candidateId, content: 'private announcement', createdAt: new Date(f.now - 400) });
  f.replies.push({ examId: 'exam', id: 'reply', questionId: 'secret-question', content: 'private reply', createdAt: new Date(f.now - 300), question: { candidateId: subscribers[1].session.candidateId } });
  f.questions.push({ examId: 'exam', id: 'secret-question', updatedAt: new Date(f.now - 200) });
  assert.equal(f.tasks.size, 1);
  await f.scan();
  assert.deepEqual(f.counts, { sessions: 1, announcements: 1, replies: 1, questions: 1 });
  assert.equal(f.idsRead[0].length, 33);
  for (const [index, subscriber] of subscribers.entries()) {
    const output = subscriber.chunks.join('');
    assert.match(output, /for everyone/);
    assert.equal(output.includes('private announcement'), index === 0);
    assert.equal(output.includes('private reply'), index === 1);
    assert.match(output, /event: refresh\ndata: {"reason":"question"}/);
    if (index !== 1) assert.doesNotMatch(output, /secret-question/);
    assert.doesNotMatch(output, /TokenHash|candidate-1"/);
  }
  f.tick(); await f.scan();
  assert.deepEqual(f.counts, { sessions: 2, announcements: 2, replies: 2, questions: 2 });
  assert.ok(subscribers.every(item => item.chunks.filter(chunk => chunk.includes('for everyone')).length === 1));
  subscribers.forEach(item => item.stop());
  assert.equal(f.tasks.size, 0);
  subscribers.forEach(item => { item.stop(); assert.equal(item.closed, 1); });
});

test('joining during an in-flight scan waits for the next shared batch and catches up from its own since', async () => {
  const f = fixture(), first = f.subscribe(0);
  f.announcements.push({ examId: 'exam', id: 'older', candidateId: null, content: 'catch-up only', createdAt: new Date(f.now - 60_000) });
  const gate = deferred(); f.hold(gate.promise);
  const running = f.scan();
  const second = f.subscribe(1, f.now - 120_000);
  await f.scan();
  assert.equal(f.counts.sessions, 1, 'a second tick cannot overlap an in-flight batch');
  gate.resolve(); await running; f.hold();
  assert.equal(second.chunks.length, 0, 'a connection not in the authenticated snapshot must wait');
  f.tick(); await f.scan();
  assert.match(second.chunks.join(''), /catch-up only/);
  assert.doesNotMatch(first.chunks.join(''), /catch-up only/);
  assert.equal(f.counts.sessions, 2);
  first.stop(); second.stop();
});

test('overlap catches a late commit and deduplicates it while publication and withdrawal each invalidate readers', async () => {
  const f = fixture(), subscriber = f.subscribe(0, f.now - 10_000);
  await f.scan();
  const createdAt = new Date(f.now - 1000);
  f.announcements.push({ examId: 'exam', id: 'late-commit', candidateId: null, content: 'late committed', createdAt });
  f.questions.push({ examId: 'exam', id: 'published-then-withdrawn', updatedAt: createdAt });
  f.tick(); await f.scan();
  f.tick(); await f.scan();
  assert.equal(subscriber.chunks.filter(chunk => chunk.includes('late committed')).length, 1);
  assert.equal(subscriber.chunks.filter(chunk => chunk.includes('event: refresh')).length, 1);
  f.questions[0].updatedAt = new Date(f.now);
  f.tick(); await f.scan();
  assert.equal(subscriber.chunks.filter(chunk => chunk.includes('event: refresh')).length, 2);
  assert.doesNotMatch(subscriber.chunks.join(''), /published-then-withdrawn/);
  subscriber.stop();
});

test('fresh batch authorization closes rotated, revoked, deleted and moved sessions while retaining the valid phone side', async () => {
  const f = fixture();
  const subscribers = Array.from({ length: 4 }, (_, index) => f.subscribe(index));
  const phone = f.subscribe(0, f.now - 1000, 'exam', 'phone');
  subscribers[0].session.desktopTokenHash = hashClientSessionToken('rotated');
  subscribers[1].session.revokedAt = new Date();
  f.sessions.delete(subscribers[2].session.id);
  subscribers[3].session.examId = 'different-exam';
  f.announcements.push({ examId: 'exam', id: 'sensitive', candidateId: null, content: 'new content', createdAt: new Date(f.now - 100) });
  await f.scan();
  assert.ok(subscribers.every(item => item.closed === 1 && !item.chunks.length));
  assert.equal(f.idsRead[0].length, 4, 'both sides of one session share the fresh authorization row');
  assert.match(phone.chunks.join(''), /new content/);
  phone.stop(); assert.equal(f.tasks.size, 0);
});

test('failed reads wait for all in-flight work, preserve cursor, and never send data with stale authorization', async () => {
  const f = fixture(), subscriber = f.subscribe(0, f.now - 60_000);
  f.announcements.push({ examId: 'exam', id: 'retry-event', candidateId: null, content: 'retry me', createdAt: new Date(f.now - 30_000) });
  const gate = deferred(); f.hold(gate.promise); f.fail(true);
  const running = f.scan();
  await Promise.resolve(); await Promise.resolve();
  await f.scan(); assert.equal(f.counts.announcements, 1);
  gate.resolve(); await running;
  assert.match(subscriber.chunks.join(''), /event: error/);
  assert.doesNotMatch(subscriber.chunks.join(''), /private database diagnostic|retry me/);
  f.hold(); f.fail(false); f.tick(20_000); await f.scan();
  assert.match(subscriber.chunks.join(''), /retry me/, 'a failed scan must not advance beyond the retried event');
  subscriber.stop();
});

test('canceling the final subscriber during a failed scan prevents late writes and allows a clean new group', async () => {
  const f = fixture(), subscriber = f.subscribe(0);
  const gate = deferred(); f.hold(gate.promise); f.fail(true);
  const running = f.scan(); subscriber.stop();
  assert.equal(f.tasks.size, 0);
  gate.resolve(); await running;
  assert.equal(subscriber.chunks.length, 0);
  assert.equal(subscriber.closed, 1);
  f.hold(); f.fail(false);
  const next = f.subscribe(1); assert.equal(f.tasks.size, 1);
  await f.scan(); assert.match(next.chunks.join(''), /keepalive/);
  next.reject(); await f.scan(); assert.equal(next.closed, 1); assert.equal(f.tasks.size, 0);
});

test('reconnecting after the last subscriber cancels cannot overlap an unfinished previous group scan', async () => {
  const f = fixture(), held = deferred(), first = f.subscribe(0);
  f.hold(held.promise);
  const pending = f.scan();
  first.stop();
  assert.equal(f.tasks.size, 0);
  const second = f.subscribe(1);
  await f.scan();
  assert.deepEqual(f.counts, { sessions: 1, announcements: 1, replies: 1, questions: 1 });
  assert.equal(second.chunks.length, 0);
  held.resolve(); await pending; f.hold();
  assert.equal(first.chunks.length, 0);
  await f.scan();
  assert.deepEqual(f.counts, { sessions: 2, announcements: 2, replies: 2, questions: 2 });
  assert.match(second.chunks.join(''), /keepalive/);
  second.stop(); assert.equal(f.tasks.size, 0);
});

test('different exams stay isolated and untrusted since values cannot request unbounded history or future cursors', async () => {
  const f = fixture(), past = f.subscribe(0, 0), future = f.subscribe(1, f.now + 86_400_000, 'exam-two');
  f.announcements.push({ examId: 'exam', id: 'exam-one', candidateId: null, content: 'only exam one', createdAt: new Date(f.now - 1000) });
  await f.scan(); assert.equal(f.tasks.size, 2);
  assert.ok(f.windows.every(window => window.lower >= f.now - QA_EVENT_LOOKBACK_MS && window.upper <= f.now));
  assert.match(past.chunks.join(''), /only exam one/);
  assert.doesNotMatch(future.chunks.join(''), /only exam one/);
  assert.deepEqual(f.counts, { sessions: 2, announcements: 2, replies: 2, questions: 2 });
  past.stop(); future.stop();
});
