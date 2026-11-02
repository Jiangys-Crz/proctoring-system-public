// Run against the isolated local QA server with its matching SESSION_SECRET.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '33319');
assert.equal(database.pathname, '/proctor_alerts_qa');
const base = new URL(process.env.MONITOR_NOTIFICATIONS_QA_BASE || 'http://127.0.0.1:43319');
assert.equal(base.hostname, '127.0.0.1');
const marker = `alert-ack-http-${randomUUID()}`;
let examId = '', userId = '', cookie = '';
async function action(path: string, body: object, method = 'POST') {
  const response = await fetch(new URL(path, base), { method,
    headers: { 'content-type': 'application/json', origin: base.origin, cookie }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify({ path, status: response.status, result }));
  return result.data;
}
try {
  const user = await prisma.user.create({ data: { username: marker, role: 'ADMIN' } }); userId = user.id;
  cookie = `cwnupaa_proctor_session=${createSessionToken(user)}`;
  const now = new Date();
  examId = (await prisma.exam.create({ data: {
    createdById: userId, examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: marker,
    startAt: new Date(+now - 600_000), latestStartAt: now, endAt: new Date(+now + 3_600_000), durationMinutes: 60,
    platform: 'HYDRO', platformBaseUrl: 'http://127.0.0.1:1', platformContestId: marker,
    contestType: 'INDIVIDUAL', rules: 'QA only', requireFrontCamera: false, requireMiniProgram: false
  } })).id;
  const candidate = await prisma.candidate.create({ data: { examId, examNumber: marker, seatNo: 'QA', password: 'QA-only',
    status: 'ONLINE_ABNORMAL', abnormal: true, startedAt: new Date(+now - 60_000) } });
  const session = await prisma.clientSession.create({ data: { examId, candidateId: candidate.id, status: 'IN_EXAM',
    startedAt: candidate.startedAt, lastDesktopSeenAt: new Date(+now + 600_000) } });
  const incident = () => prisma.alert.create({ data: { examId, candidateId: candidate.id, sessionId: session.id,
    type: 'PROCESS_POLICY', severity: 4, message: `${marker} pending process incident` } });
  const state = () => prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
  const mark = () => action(`/api/candidates/${candidate.id}/cheating`, { sessionId: session.id, reason: 'QA cheating lock' });
  const cancel = () => action(`/api/candidates/${candidate.id}/cheating`, { reason: 'QA cancellation' }, 'DELETE');
  const ack = (id: string) => action(`/api/alerts/${id}/ack`, {});
  const pending = await incident();
  await mark();
  await cancel();
  assert.equal((await state()).abnormal, true, 'cancelling cheating cannot clear another unhandled alert');
  assert.equal((await state()).status, 'ONLINE_ABNORMAL');
  await ack(pending.id);
  assert.equal((await state()).abnormal, false);
  assert.equal((await state()).status, 'ONLINE_NORMAL');

  for (let index = 0; index < 12; index++) {
    const row = await incident();
    await Promise.all(index % 2 ? [ack(row.id), mark()] : [mark(), ack(row.id)]);
    assert.equal((await state()).abnormal, true, 'a concurrent cheating mark cannot be cleared by acknowledgement');
    assert.equal((await prisma.clientSession.findUniqueOrThrow({ where: { id: session.id } })).lockdown, true);
    assert.equal(await prisma.cheatingRecord.count({ where: { candidateId: candidate.id, canceledAt: null } }), 1);
    await cancel();
    assert.equal((await state()).abnormal, false);
    assert.equal((await state()).status, 'ONLINE_NORMAL');
  }
  console.log(JSON.stringify({ cheatingAcknowledgementRaces: 12, pendingAlertSurvivesCheatingCancellation: true,
    allHandledThenCancelledRestoresNormal: true }));
} finally {
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
}
