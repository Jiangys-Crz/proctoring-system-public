// Run only against the disposable proctor_novajudge_qa MySQL database.
import assert from 'node:assert/strict';
import http from 'node:http';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { prisma } from '../src/lib/db';
import { saveExam } from '../src/lib/exam-save';
import { createClientSessionToken } from '../src/lib/client-auth';
import { pushExternalBoard } from '../src/lib/external-board';
import { saveExternalBoardSettings } from '../src/lib/external-board-settings';
import { POST as login } from '../src/app/api/client/oj-cookie/route';
import { POST as start } from '../src/app/api/client/session/start/route';
import { POST as finish } from '../src/app/api/client/session/finish/route';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';
import { GET as screenControl } from '../src/app/api/client/screen-control/route';
import { requireContestSession } from '../src/lib/client-contest';
import { PUBLIC_TEST_MARKER } from '../src/lib/public-test';

const db = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(db.pathname, '/proctor_novajudge_qa');
assert.ok(['127.0.0.1', 'localhost'].includes(db.hostname));

let sourceAuthorized = true, loginMode = 'ok', loginCount = 0, sourceReads = 0, receiverMode = 'ok';
let pauseLogin: (() => Promise<void>) | undefined;
const records = Array.from({ length: 51 }, (_, index) => ({ rid: index + 1, username: '0000123', problem: 'A+B',
  status: 'Accepted', score: 100, runtime: 15, memory: 1024, language: 'cpp', submit_time: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' '), code: `int main(){return ${index};}` }));
records.push({ ...records[0], rid: 52, username: 'unmonitored-account' }, { ...records[0], rid: 53, submit_time: '2050-01-01 00:00:00' });
const posts: Array<{ kind: string; body: any }> = [];
const receiverRecords = new Map<string, any>();
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  const send = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/api/cli/login') {
    loginCount++; assert.deepEqual(body, { username: '0000123', password: 'candidate-password-fixture', contestId: 12, loginSource: 'PROCTORING' });
    assert.equal(req.headers['x-api-key'], 'nova-source-fixture'); await pauseLogin?.();
    if (loginMode === 'credentials') return send({ error: 'invalid credentials' }, 401);
    return send({ token: 'header.payload.signature', loginSource: 'PROCTORING', proctoringKey: 'a'.repeat(43), user: { username: body.username, contestId: loginMode === 'wrong-contest' ? 13 : 12, role: loginMode === 'admin' ? 'ADMIN' : 'TEAM' } });
  }
  if (req.url === '/api/contests/12/problems' || req.url === '/api/contests/12/submissions') {
    sourceReads++; assert.equal(req.headers['x-api-key'], 'nova-source-fixture');
    if (!sourceAuthorized) return send({ error: 'must not persist nova-source-fixture' }, 403);
    return send(req.url.endsWith('problems') ? [{ displayId: 'A', name: 'A+B', time: 1000, memory: 256, score: 100 }] : records);
  }
  const match = req.url?.match(/^\/api\/external\/board\/123\/(problems|submissions)$/);
  if (match) {
    const kind = match[1]; assert.equal(body.api_key, 'receiver-fixture'); assert.equal(req.headers['x-api-key'], undefined);
    posts.push({ kind, body });
    if (receiverMode === 'fail') return send({ code: 403, msg: 'must not persist receiver-fixture' }, 403);
    if (kind === 'submissions') {
      if (receiverMode === 'partial') return send({ code: 200, data: '成功处理并保存了 0 条提交记录' });
      for (const item of body.submissions) receiverRecords.set(item.rid, item);
    }
    return send({ code: 200, data: kind === 'submissions' ? `成功处理并保存了 ${body.submissions.length} 条提交记录` : '成功更新题目' });
  }
  send({ error: 'unexpected request' }, 404);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let examId: string | undefined, userId: string | undefined;

try {
  const user = await prisma.user.create({ data: { username: 'novajudge-qa', role: 'SUPER_ADMIN' } }); userId = user.id;
  const startAt = new Date(Date.now() - 60_000);
  const input = CreateExamSchema.parse({ name: 'NovaJudge 集成验证', platform: 'NOVAJUDGE', platformBaseUrl: origin, platformContestId: '12', novaJudgeApiKey: 'nova-source-fixture',
    startAt, latestStartAt: startAt, endAt: startAt, durationMinutes: 120, contestType: 'INDIVIDUAL', administratorIds: [user.id], requireMiniProgram: false, requireFrontCamera: false,
    externalBoardBaseUrl: `${origin}/api`, externalBoardEventId: '123', externalBoardApiKey: 'receiver-fixture' });
  const exam = await saveExam(input, user.id); examId = exam.id;
  assert.equal(exam.platform, 'NOVAJUDGE'); assert.equal(exam.platformBaseUrl, origin); assert.equal(exam.platformContestId, '12'); assert.equal(exam.published, true);
  assert.equal(await prisma.examProblem.count({ where: { examId } }), 0);
  // Avoid creating unrelated public-test data; the marker only needs to be a different ID.
  await prisma.systemSetting.upsert({ where: { key: PUBLIC_TEST_MARKER }, create: { key: PUBLIC_TEST_MARKER, value: { examId: 'test-exam-fixture' } }, update: { value: { examId: 'test-exam-fixture' } } });
  const candidate = await prisma.candidate.create({ data: { examId, examNumber: '0000123', password: 'candidate-password-fixture', name: '测试考生', seatNo: 'A01' } });
  const token = createClientSessionToken();
  const miniToken = createClientSessionToken();
  const session = await prisma.clientSession.create({ data: { examId, candidateId: candidate.id, desktopDeviceId: 'novajudge-qa-desktop', status: 'WAITING_REVIEW', desktopTokenHash: token.tokenHash, miniProgramTokenHash: miniToken.tokenHash } });
  const request = (path: string, body: unknown = { sessionId: session.id }, value = token.token) => new Request(`${origin}/api/client/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': value }, body: JSON.stringify(body),
  });
  assert.equal((await login(request('oj-cookie', undefined, 'wrong-token'))).status, 401);
  assert.equal((await login(request('oj-cookie', undefined, miniToken.token))).status, 401);
  assert.equal((await login(request('oj-cookie'))).status, 403);
  await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'APPROVED' } });
  assert.equal((await login(request('oj-cookie'))).status, 403); assert.equal(loginCount, 0, 'no credentials sent before exam start');
  const started = await start(request('session/start', { sessionId: session.id, confirm: true })); assert.equal(started.status, 200);
  const response = await login(request('oj-cookie')); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = (await response.json()).data; assert.equal(data.loginUrl, `${origin}/contest/12`); assert.equal(data.cookie.name, 'user_token');
  assert.equal(JSON.stringify(data).includes(candidate.password), false); assert.equal(JSON.stringify(data).includes('nova-source-fixture'), false);
  assert.equal(await prisma.oJLoginTicket.count({ where: { sessionId: session.id, loginUrl: { contains: 'payload' } } }), 0);
  assert.equal((await requireContestSession(request('contest'), session.id)).ok, false, 'local Hydro APIs cannot serve a Nova exam');
  const hb = await heartbeat(request('heartbeat', { sessionId: session.id, deviceId: 'novajudge-qa-desktop', side: 'DESKTOP', capture: { screenOk: true } }));
  assert.equal(hb.status, 200); assert.equal((await hb.json()).data.session.status, 'IN_EXAM');
  assert.equal((await screenControl(new Request(`${origin}/api/client/screen-control?sessionId=${session.id}`, { headers: { 'x-proctor-session-token': token.token } }))).status, 200);
  for (const mode of ['credentials', 'wrong-contest', 'admin']) { loginMode = mode; assert.equal((await login(request('oj-cookie'))).status, 502); }
  loginMode = 'ok';
  await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'LOCKED', lockdown: true } });
  const oldCount = loginCount; assert.equal((await login(request('oj-cookie'))).status, 403); assert.equal(loginCount, oldCount);
  await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'IN_EXAM', lockdown: false } });
  pauseLogin = async () => { await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'LOCKED', lockdown: true } }); };
  assert.equal((await login(request('oj-cookie'))).status, 403, 'locking during remote auth does not release a cookie'); pauseLogin = undefined;
  await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'IN_EXAM', lockdown: false } });

  const tick = async () => { await prisma.externalBoardSync.updateMany({ where: { examId }, data: { nextAttemptAt: null } }); await pushExternalBoard(examId!); };
  await prisma.exam.update({ where: { id: examId }, data: { externalBoardEnabled: true } });
  receiverMode = 'partial'; await tick(); assert.equal(await prisma.novaJudgeBoardRecord.count({ where: { examId } }), 0, 'partial acceptance never advances checkpoints');
  receiverMode = 'ok'; await tick(); assert.equal(await prisma.novaJudgeBoardRecord.count({ where: { examId } }), 50);
  await tick(); assert.equal(await prisma.novaJudgeBoardRecord.count({ where: { examId } }), 51); assert.equal(receiverRecords.size, 51);
  const before = posts.length; await tick(); assert.equal(posts.length, before, 'unchanged remote records are not pushed again');
  records[0] = { ...records[0], status: 'Wrong Answer', score: 0 }; await tick();
  assert.equal(posts.at(-1)!.body.submissions.length, 1); assert.equal(receiverRecords.get(`novajudge:${examId}:1`).status, 'Wrong Answer');
  records[0] = { ...records[0], status: 'Accepted', score: 100 }; receiverMode = 'fail'; await tick();
  assert.equal(receiverRecords.get(`novajudge:${examId}:1`).status, 'Wrong Answer'); receiverMode = 'ok'; await tick();
  assert.equal(receiverRecords.get(`novajudge:${examId}:1`).status, 'Accepted');
  sourceAuthorized = false; await tick();
  const sync = await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId } }); assert.match(sync.lastError!, /NovaJudge/); assert.equal(sync.lastError!.includes('nova-source-fixture'), false);
  sourceAuthorized = true;
  await saveExternalBoardSettings(examId, { externalBoardEnabled: false }); const readsBefore = sourceReads; await tick(); assert.equal(sourceReads, readsBefore);
  const saved = await saveExam({ ...input, name: 'NovaJudge 修改后' }, user.id, examId); assert.equal(saved.externalBoardEnabled, false); assert.equal(saved.novaJudgeApiKey, 'nova-source-fixture');
  const ended = await finish(request('session/finish', { sessionId: session.id, confirmationText: '考号0000123，姓名测试考生确认结束考试' })); assert.equal(ended.status, 200);
  assert.equal((await login(request('oj-cookie'))).status, 403);
  console.log('NovaJudge MySQL/HTTP integration passed: create/edit, approval/start, identity checks, lock race, heartbeat/control, 51-record checkpoints, partial retry, rejudge, source failure, stop and finish.');
} finally {
  if (examId) await prisma.exam.deleteMany({ where: { id: examId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
