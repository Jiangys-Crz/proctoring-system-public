// Disposable database only. Set PERFORMANCE_QA_BASE to exercise a production
// server as well, including administrator access; no judge service is needed.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { createSessionToken } from '../src/lib/auth';
import { POST as submissions } from '../src/app/api/client/contest/submissions/route';
import { POST as leaderboard } from '../src/app/api/client/contest/leaderboard/route';
import { GET as contest } from '../src/app/api/client/contest/route';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.ok(['/proctor_monitor_freeze_qa', '/proctor_submission_sharing_qa'].includes(database.pathname));
const base = process.env.PERFORMANCE_QA_BASE;
if (base) assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const marker = `xcpc-freeze-${randomUUID()}`;
const now = new Date();
const freeze = new Date(+now - 60_000);
let examId = '';
const users: string[] = [];
const originalFetch = globalThis.fetch;
if (!base) globalThis.fetch = async () => { throw new Error('Judge service intentionally unavailable during freeze regression'); };

type CandidateSession = { id: string; candidateId: string; token: string };
async function call(session: CandidateSession, endpoint: 'submissions' | 'leaderboard', extra: Record<string, unknown> = {}, token = session.token) {
  const path = `/api/client/contest/${endpoint}`;
  const init = { method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': token },
    body: JSON.stringify({ sessionId: session.id, ...extra }) };
  return base ? fetch(`${base}${path}`, init) : (endpoint === 'submissions' ? submissions : leaderboard)(new Request(`http://localhost${path}`, init));
}
async function data(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data;
}


try {
  const exam = await prisma.exam.create({ data: {
    name: marker, examCode: String(randomInt(1_000_000_000, 10_000_000_000)),
    startAt: new Date(+now - 600_000), latestStartAt: new Date(+now - 600_000), endAt: new Date(+now + 600_000),
    durationMinutes: 20, scoreboardFrozenAt: freeze, platform: 'HYDRO', platformBaseUrl: 'http://127.0.0.1:1',
    platformContestId: 'local', contestType: 'INDIVIDUAL', contestRule: 'XCPC', published: true, rules: 'Synthetic freeze regression',
    showTestCaseCount: true, showObjectiveScore: true,
    problems: { create: [0, 1].map(order => ({ order, title: `Problem ${order}`, hydroProblemId: String(order + 1), content: 'Fixture only' })) }
  }, include: { problems: { orderBy: { order: 'asc' } } } });
  examId = exam.id;
  const candidates = await Promise.all(['owner', 'other', 'third'].map(name => prisma.candidate.create({ data: {
    examId, name, examNumber: `${marker}-${name}`, password: 'qa-only', seatNo: name, startedAt: exam.startAt
  } })));
  const sessions = await Promise.all(candidates.map(async candidate => {
    const credentials = createClientSessionToken();
    const session = await prisma.clientSession.create({ data: {
      examId, candidateId: candidate.id, desktopDeviceId: `${marker}-${candidate.id}`, desktopTokenHash: credentials.tokenHash,
      status: 'IN_EXAM', startedAt: exam.startAt, lastDesktopSeenAt: now
    } });
    return { id: session.id, candidateId: candidate.id, token: credentials.token };
  }));
  const record = (name: string, candidateIndex: number, problemIndex: number, at: number, status = 1) => ({
    id: `${marker}-${name}`, examId, candidateId: candidates[candidateIndex].id, problemId: exam.problems[problemIndex].id,
    actorKey: candidates[candidateIndex].examNumber, candidateExamNumber: candidates[candidateIndex].examNumber,
    candidateName: candidates[candidateIndex].name, lang: 'cpp', code: `${name} confidential code`, status,
    statusText: status === 1 ? 'Accepted' : status === 30 ? 'Ignored' : 'Wrong Answer', score: status === 1 ? 100 : 0,
    totalTestCases: 10, passedTestCases: status === 1 ? 10 : 3, time: 321, memory: 654,
    testCases: [{ status, message: 'judge details' }], subtasks: { score: 100 }, createdAt: new Date(at), judgeAt: now
  });
  const records = [
    record('own-after', 0, 1, +freeze + 1000), record('other-before', 1, 0, +freeze - 1000),
    record('other-boundary', 1, 0, +freeze), record('other-after-ac', 1, 1, +freeze + 1000),
    record('other-after-wa', 1, 1, +freeze + 2000, 2), record('third-after-ignored', 2, 1, +freeze + 3000, 30)
  ];
  await prisma.contestSubmission.createMany({ data: records });
  const recordsById = new Map(records.map(row => [row.id, row]));
  const started = performance.now();
  await Promise.all(Array.from({ length: 30 }, async (_, index) => {
    const viewer = sessions[index % sessions.length];
    const rows = await data(await call(viewer, 'submissions', { viewerCandidateId: candidates[1].id, admin: true, timePoint: +freeze - 1 }));
    assert.equal(rows.length, records.filter(row => row.candidateId === viewer.candidateId).length);
    for (const row of rows) {
      const original = recordsById.get(row.id)!;
      assert.equal(original.candidateId, viewer.candidateId, 'other accounts are absent regardless of freeze phase');
      {
        assert.equal(row.resultHidden, false); assert.equal(row.status, original.status);
        assert.equal(row.passedTestCases, original.passedTestCases); assert.equal(row.time, original.time);
        assert.equal(row.canViewDetail, original.candidateId === viewer.candidateId);
        assert.equal(row.code, original.candidateId === viewer.candidateId ? original.code : '');
      }
    }
  }));
  const concurrentMs = Math.round(performance.now() - started);
  const board = await data(await call(sessions[0], 'leaderboard', { timePoint: +now + 10_000_000 }));
  assert.equal(board.frozen, true);
  const other = board.rows.find((row: any) => row.username === candidates[1].examNumber);
  assert.equal(other.solved, 1); assert.equal(other.cells[1].accepted, false); assert.equal(other.cells[1].pending, 2);
  const history = await data(await call(sessions[0], 'leaderboard', { timePoint: +freeze - 1 }));
  assert.equal(history.frozen, false);
  assert.equal(history.rows.find((row: any) => row.username === candidates[1].examNumber).solved, 1);
  assert.equal((await call(sessions[0], 'submissions', {}, 'invalid')).status, 401);
  assert.equal((await call(sessions[0], 'submissions', { sessionId: sessions[1].id })).status, 401);
  await prisma.clientSession.update({ where: { id: sessions[2].id }, data: { revokedAt: new Date() } });
  assert.equal((await call(sessions[2], 'submissions')).status, 401);
  assert.equal((await call(sessions[2], 'leaderboard')).status, 401);

  const initialPath = `/api/client/contest?sessionId=${encodeURIComponent(sessions[0].id)}`;
  const headers = { 'x-proctor-session-token': sessions[0].token };
  const initial = await data(base ? await fetch(`${base}${initialPath}`, { headers }) : await contest(new Request(`http://localhost${initialPath}`, { headers })));
  assert.equal(initial.submissions.length, 1, 'initial contest/detail data contains only the authenticated owner');
  assert.equal(initial.submissions[0].status, 1);

  if (base) {
    const admin = await prisma.user.create({ data: { username: `${marker}-admin`, role: 'SUPER_ADMIN' } }); users.push(admin.id);
    const outsider = await prisma.user.create({ data: { username: `${marker}-outsider`, role: 'ADMIN' } }); users.push(outsider.id);
    const path = `${base}/api/exams/${examId}/submissions`;
    const adminRows = await data(await fetch(path, { headers: { cookie: `cwnupaa_proctor_session=${createSessionToken(admin)}` } }));
    for (const row of adminRows) {
      const original = recordsById.get(row.id)!;
      assert.equal(row.status, original.status); assert.equal(row.code, original.code); assert.equal(row.passedTestCases, original.passedTestCases);
    }
    assert.equal((await fetch(path, { headers: { cookie: `cwnupaa_proctor_session=${createSessionToken(outsider)}` } })).status, 403);
    assert.equal((await fetch(path, { headers })).status, 401);
  }

  await prisma.exam.update({ where: { id: examId }, data: { scoreboardFrozenAt: null } });
  const unfrozen = await data(await call(sessions[0], 'submissions'));
  assert.equal(unfrozen.length, 1);
  assert.equal(unfrozen[0].id, records[0].id);
  assert.equal(unfrozen[0].status, 1);
  await prisma.exam.update({ where: { id: examId }, data: { scoreboardFrozenAt: freeze, endAt: new Date(+now - 1) } });
  const ended = await data(await call(sessions[0], 'submissions'));
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, 1);
  assert.equal((await data(await call(sessions[0], 'leaderboard'))).available, false, 'ended-session leaderboard policy remains unchanged');
  console.log(JSON.stringify({ concurrentPolls: 30, concurrentMs, mode: base ? 'production HTTP + MySQL' : 'route handlers + MySQL', preservedOwnAndPreFreezeResults: true }));
  console.log('PASS: frozen verdict/metrics, owner isolation, history boundaries, initial contest data, unfreeze/end behavior, forged identity/time parameters and immediate revocation.');
} finally {
  globalThis.fetch = originalFetch;
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
}
