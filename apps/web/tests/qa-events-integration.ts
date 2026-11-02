// Run only against the disposable QA database. Uses the actual SSE route,
// native Request/ReadableStream, real one-second timers and MySQL query events.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_submission_sharing_qa');
const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
(globalThis as unknown as { prisma: PrismaClient }).prisma = prisma;
const { GET } = await import('../src/app/api/client/qa/events/route');
const { createClientSessionToken } = await import('../src/lib/client-auth');
let queries: string[] = [];
prisma.$on('query', event => { queries.push(event.query); });

const marker = `qa-sse-${randomUUID()}`;
const exams: string[] = [];
const now = new Date();
type Identity = { id: string; candidateId: string; token: string; phoneToken: string };
type Connection = { abort: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> };
const connections: Connection[] = [];
const decoder = new TextDecoder();

async function connect(identity: Identity, token = identity.token, since = new Date(+now - 30_000)) {
  const abort = new AbortController();
  const response = await GET(new Request(`http://localhost/api/client/qa/events?sessionId=${identity.id}&since=${since.toISOString()}`, {
    headers: { 'x-proctor-session-token': token }, signal: abort.signal,
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const connection = { abort, reader: response.body!.getReader() };
  connections.push(connection);
  const connected = await connection.reader.read();
  assert.equal(connected.done, false);
  assert.match(decoder.decode(connected.value), /event: connected/);
  return connection;
}

async function batch(connection: Connection) {
  let output = '';
  while (true) {
    const next = await connection.reader.read();
    assert.equal(next.done, false, 'authorized reader must remain open');
    output += decoder.decode(next.value);
    if (output.includes(': keepalive ')) return output;
  }
}

function assertFourReads() {
  const reads = queries.filter(query => /^\s*SELECT /i.test(query));
  assert.equal(reads.length, 4, reads.join('\n'));
  assert.equal(reads.filter(query => /FROM [`\w.]*ClientSession`?\s/i.test(query)).length, 1);
  assert.equal(reads.filter(query => /FROM [`\w.]*ExamAnnouncement`?\s/i.test(query)).length, 1);
  assert.equal(reads.filter(query => /FROM ExamQuestionMessage AS m INNER JOIN ExamQuestion AS q/i.test(query)).length, 1);
  assert.equal(reads.filter(query => /FROM [`\w.]*ExamQuestion`?\s/i.test(query)).length, 1);
  return reads.length;
}

async function createExam() {
  const exam = await prisma.exam.create({ data: {
    name: marker, examCode: String(randomInt(1_000_000_000, 10_000_000_000)),
    startAt: new Date(+now - 600_000), latestStartAt: new Date(+now - 600_000), endAt: new Date(+now + 3_600_000),
    durationMinutes: 70, platform: 'HYDRO', platformBaseUrl: 'http://127.0.0.1:1',
    platformContestId: 'local', contestType: 'INDIVIDUAL', published: true, rules: 'Synthetic SSE test only',
  } });
  exams.push(exam.id);
  return exam;
}

// A referenced timeout makes a stalled reader fail instead of letting the
// intentionally unref'ed hub timer silently end the test process.
const timeout = setTimeout(() => { throw new Error('QA SSE integration timed out'); }, 30_000);
try {
  const exam = await createExam();
  const otherExam = await createExam();
  const candidates = Array.from({ length: 100 }, (_, index) => ({
    id: `${marker}-candidate-${index}`, examId: exam.id, examNumber: String(index),
    name: `Synthetic ${index}`, password: 'qa-only', seatNo: String(index),
  }));
  await prisma.candidate.createMany({ data: candidates });
  const identities: Identity[] = [];
  await prisma.clientSession.createMany({ data: candidates.map((candidate, index) => {
    const desktop = createClientSessionToken(), phone = createClientSessionToken();
    const id = `${marker}-session-${index}`;
    identities.push({ id, candidateId: candidate.id, token: desktop.token, phoneToken: phone.token });
    return { id, examId: exam.id, candidateId: candidate.id, desktopDeviceId: id,
      desktopTokenHash: desktop.tokenHash, miniProgramTokenHash: phone.tokenHash, status: 'IN_EXAM' as const };
  }) });
  const question = await prisma.examQuestion.create({ data: {
    examId: exam.id, candidateId: candidates[1].id, content: 'Private question must never enter peer SSE',
    isPublished: true, createdAt: new Date(+now - 5000), updatedAt: new Date(+now - 5000),
    messages: { create: { sender: 'ADMIN', content: 'PRIVATE_REPLY_FOR_1', createdAt: new Date(+now - 4000) } },
  } });
  await prisma.examAnnouncement.createMany({ data: [
    { examId: exam.id, content: 'GLOBAL_ANNOUNCEMENT', createdAt: new Date(+now - 3000) },
    { examId: exam.id, candidateId: candidates[0].id, content: 'PRIVATE_ANNOUNCEMENT_FOR_0', createdAt: new Date(+now - 2000) },
    { examId: otherExam.id, content: 'OTHER_EXAM_SECRET', createdAt: new Date(+now - 1000) },
  ] });

  const openedAt = performance.now();
  const clients = await Promise.all(identities.map(identity => connect(identity)));
  const setupMs = Math.round(performance.now() - openedAt);
  queries = [];
  const first = await Promise.all(clients.map(batch));
  const firstReads = assertFourReads();
  first.forEach((output, index) => {
    assert.match(output, /GLOBAL_ANNOUNCEMENT/);
    assert.equal(output.includes('PRIVATE_ANNOUNCEMENT_FOR_0'), index === 0);
    assert.equal(output.includes('PRIVATE_REPLY_FOR_1'), index === 1);
    assert.match(output, /event: refresh\ndata: {"reason":"question"}/);
    assert.doesNotMatch(output, /OTHER_EXAM_SECRET|Private question must never|TokenHash/);
    if (index !== 1) assert.ok(!output.includes(question.id), 'private question ID cannot leak through refresh');
  });

  queries = [];
  const second = await Promise.all(clients.map(batch));
  const secondReads = assertFourReads();
  second.forEach(output => assert.doesNotMatch(output, /event: announcement|event: reply|event: refresh/, 'overlap must not duplicate events'));

  // A late phone subscription catches up from its own cursor, without adding
  // another whole-exam scan. The other 100 readers do not replay old events.
  const phone = await connect(identities[1], identities[1].phoneToken);
  queries = [];
  const third = await Promise.all([...clients, phone].map(batch));
  const thirdReads = assertFourReads();
  third.slice(0, 100).forEach(output => assert.doesNotMatch(output, /event: announcement|event: reply|event: refresh/));
  assert.match(third[100], /GLOBAL_ANNOUNCEMENT/);
  assert.match(third[100], /PRIVATE_REPLY_FOR_1/);
  assert.doesNotMatch(third[100], /PRIVATE_ANNOUNCEMENT_FOR_0/);

  // Withdrawal must invalidate all clients even though the question no longer
  // passes an isPublished filter, without broadcasting its identity or text.
  await prisma.examQuestion.update({ where: { id: question.id }, data: { isPublished: false } });
  queries = [];
  const withdrawal = await Promise.all([...clients, phone].map(batch));
  assertFourReads();
  withdrawal.forEach(output => {
    assert.match(output, /event: refresh\ndata: {"reason":"question"}/);
    assert.ok(!output.includes(question.id));
    assert.doesNotMatch(output, /PRIVATE_REPLY_FOR_1|Private question must never/);
  });

  // Revocation and desktop token rotation must take effect on the next shared
  // authorization scan, while the same session's valid phone token survives.
  await prisma.clientSession.update({ where: { id: identities[0].id }, data: { revokedAt: new Date() } });
  await prisma.clientSession.update({ where: { id: identities[1].id }, data: { desktopTokenHash: createClientSessionToken().tokenHash } });
  await prisma.examAnnouncement.create({ data: { examId: exam.id, content: 'AFTER_REVOCATION' } });
  queries = [];
  const revoked = Promise.all([clients[0].reader.read(), clients[1].reader.read()]);
  const remaining = await Promise.all([...clients.slice(2), phone].map(batch));
  assertFourReads();
  (await revoked).forEach(result => assert.equal(result.done, true));
  remaining.forEach(output => assert.match(output, /AFTER_REVOCATION/));
  const rejected = await GET(new Request(`http://localhost/api/client/qa/events?sessionId=${identities[0].id}`, {
    headers: { 'x-proctor-session-token': identities[0].token },
  }));
  assert.equal(rejected.status, 401);

  // Cancel one actual response body and abort all others. No background scan
  // may survive after the final subscriber leaves.
  await clients[2].reader.cancel();
  connections.forEach(connection => connection.abort.abort());
  const closed = await Promise.all(connections.filter(connection => connection !== clients[2]).map(connection => connection.reader.read()));
  closed.forEach(result => assert.equal(result.done, true));
  queries = [];
  await delay(1250);
  assert.equal(queries.length, 0, 'last subscriber must stop the shared timer and database work');
  console.log(JSON.stringify({ status: 'PASS', subscriptions: 100, lateSubscription: 1, setupMs,
    sqlReadsPerScan: [firstReads, secondReads, thirdReads], checks: ['private isolation', 'cross-exam isolation',
      'since catch-up', 'overlap deduplication', 'publication withdrawal', 'fresh revocation', 'token rotation', 'abort/cancel cleanup'] }));
} finally {
  clearTimeout(timeout);
  connections.forEach(connection => connection.abort.abort());
  await prisma.exam.deleteMany({ where: { id: { in: exams }, name: marker } });
  await prisma.$disconnect();
}
