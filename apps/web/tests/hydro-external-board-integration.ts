// Isolated database + loopback HTTP source/receiver; never calls a real website.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { prisma } from '../src/lib/db';
import { saveHydroSettings } from '../src/lib/settings';
import { pushExternalBoard, cancelExternalBoardPush } from '../src/lib/external-board';
import { saveExternalBoardSettings } from '../src/lib/external-board-settings';
import { readExternalBoardLogs } from '../src/lib/external-board-log';

if (!process.env.DATABASE_URL?.includes('/proctor_external_board_qa')) throw new Error('Use the external-board fixture database.');
const tid = '691000000000000000000001';
const stamp = new Date(Math.floor((Date.now() - 100_000) / 1000) * 1000);
const prefix = Math.floor(+stamp / 1000).toString(16);
const rows = Array.from({ length: 106 }, (_, index) => ({ id: prefix + index.toString(16).padStart(16, '0'),
  username: index < 50 ? 'not-on-roster' : 'team01', problemId: '9', status: index === 105 ? 20 : 1,
  score: 100, language: 'cpp', code: '// source', runtime: 3, memory: 1024, createdAt: stamp.toISOString() }));
const problems = [{ id: '9', label: 'A', title: 'Native problem', score: 100, hydroScore: 100, timeLimitMs: 1000, memoryLimitMb: 256 }];
const sourceCalls: any[] = [], posts: any[] = [], received = new Map<string, any>();
let mode: 'ok' | 'partial' | 'fail' = 'ok';
let afterProblems: (() => Promise<void>) | undefined;
let sourceHook: (() => Promise<void>) | undefined;
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    if (req.url === `/d/xcpc/api/proctor/board-contest/${tid}`) {
      assert.equal(req.headers['x-proctor-api-key'], 'fixture-source-key');
      assert.deepEqual(body.usernames, ['team01']); sourceCalls.push(body);
      await sourceHook?.();
      const page = rows.filter(row => !body.after || row.id > body.after).slice(0, 51);
      res.end(JSON.stringify({ ok: true, data: { contestId: tid, rule: 'acm', problems,
        records: page.slice(0, 50).filter(row => body.usernames.includes(row.username)), nextAfter: page.length > 50 ? page[49].id : null } }));
      return;
    }
    assert.match(req.url || '', /^\/api\/external\/board\/123\/(problems|submissions)$/);
    assert.equal(body.api_key, 'fixture-target-key'); posts.push(body);
    if (mode === 'fail') { res.statusCode = 503; res.end(JSON.stringify({ msg: 'fixture-target-key' })); return; }
    if (body.problems) { await afterProblems?.(); res.end(JSON.stringify({ code: 200 })); return; }
    for (const record of body.submissions) received.set(record.rid, record);
    res.end(JSON.stringify({ code: 200, data: `成功处理并保存了 ${mode === 'partial' ? 0 : body.submissions.length} 条提交记录` }));
  } catch (error) { res.statusCode = 500; res.end('{}'); console.error(error); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
let examId = '';
async function tick() {
  await prisma.externalBoardSync.updateMany({ where: { examId }, data: { nextAttemptAt: null } });
  await pushExternalBoard(examId);
}
const state = () => prisma.externalBoardSync.findUniqueOrThrow({ where: { examId } });
async function cycle() {
  for (let i = 0; i < 6; i++) { await tick(); if (!(await state()).scanUntil) return; }
  throw new Error('Scan did not complete');
}
try {
  await saveHydroSettings({ baseUrl: base, apiKey: 'fixture-source-key', problemDomainId: 'Problems' });
  const startAt = new Date(+stamp - 3600_000);
  const exam = await prisma.exam.create({ data: { examCode: '2099010110', name: 'Hydro external board QA',
    startAt, latestStartAt: startAt, endAt: new Date(Date.now() + 3600_000), durationMinutes: 120,
    platform: 'HYDRO_BROWSER', platformBaseUrl: `${base}/d/xcpc`, platformContestId: tid, contestType: 'INDIVIDUAL', contestRule: 'XCPC', rules: '',
    externalBoardBaseUrl: `${base}/api`, externalBoardEventId: '123', externalBoardApiKey: 'fixture-target-key',
    candidates: { create: { examNumber: 'team01', password: 'fixture-password', seatNo: '1' } },
  } }); examId = exam.id;
  await tick(); assert.equal(sourceCalls.length, 0); assert.equal(posts.length, 0);
  await saveExternalBoardSettings(examId, { externalBoardEnabled: true });
  await (globalThis as any).externalBoardTask;
  assert.equal(sourceCalls.length, 1); assert.equal((await state()).cursorId, rows[49].id, 'empty filtered page advances');
  const cutoff = (await state()).scanUntil!.toISOString();
  await tick(); assert.equal(received.size, 50); assert.equal((await state()).scanUntil!.toISOString(), cutoff);
  const secondCursor = (await state()).cursorId;
  mode = 'partial'; await tick();
  assert.equal((await state()).cursorId, secondCursor);
  assert.match((await state()).lastError!, /未完整接收/);
  mode = 'ok'; await tick(); assert.equal(received.size, 55); assert.equal((await state()).scanUntil, null);
  assert.equal(await prisma.contestSubmission.count({ where: { examId } }), 0, 'native records require no local submission copies');
  assert.ok(sourceCalls.slice(0, 4).every(call => call.until === cutoff), 'a resumed scan preserves its upper bound');
  const beforeUnchanged = posts.length;
  await cycle();
  assert.equal(posts.slice(beforeUnchanged).flatMap(post => post.submissions ?? []).length, 55);
  assert.ok(posts.slice(beforeUnchanged).every(post => !post.problems));
  rows[50].status = 2; rows[50].score = 0; rows[105].status = 1;
  await cycle(); assert.equal(received.size, 56, 'old rejudge updates instead of adding another RID');
  const updated = [...received.values()].find(row => row.rid.endsWith(rows[50].id)); assert.equal(updated.status, 'Wrong Answer');
  rows[50].status = 30; await cycle();
  assert.equal([...received.values()].find(row => row.rid === updated.rid).status, 'Compile Error');
  rows[51].status = 2; mode = 'fail'; await tick(); await tick();
  assert.ok((await state()).lastError); assert.ok(!JSON.stringify(readExternalBoardLogs(examId)).includes('fixture-target-key'));
  mode = 'ok'; await cycle();

  // Closing between the manifest and submissions must cancel the second POST.
  problems[0].title = 'Renamed native problem'; rows[50].status = 1;
  afterProblems = async () => { await prisma.exam.update({ where: { id: examId }, data: { externalBoardEnabled: false } }); };
  const beforeStop = posts.length; await tick(); assert.equal(posts.length, beforeStop + 1);
  afterProblems = undefined;
  const stoppedSource = sourceCalls.length; await tick(); assert.equal(sourceCalls.length, stoppedSource);
  await saveExternalBoardSettings(examId, { externalBoardEnabled: true }); await (globalThis as any).externalBoardTask;
  await cycle(); assert.ok(posts.length > beforeStop + 1, 're-enabling replays unchanged native records too');

  // Abort a source read in flight; no receiver POST or successful cursor commit.
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  sourceHook = async () => { entered(); await blocked; };
  const running = tick(); await started;
  const postsBeforeAbort = posts.length;
  await saveExternalBoardSettings(examId, { externalBoardEnabled: false }); release(); await running;
  sourceHook = undefined; assert.equal(posts.length, postsBeforeAbort); assert.equal((await state()).lastError, null);
  const readsBeforeOff = sourceCalls.length; await tick(); assert.equal(sourceCalls.length, readsBeforeOff);
  assert.ok(posts.every(post => !post.submissions || post.submissions.length <= 50));
  console.log('PASS: native HTTP export, full submission replay, persisted cursor, partial-response retry, rejudge and in-flight cancellation.');
} finally {
  if (examId) { cancelExternalBoardPush(examId); await (globalThis as any).externalBoardTask; await prisma.exam.deleteMany({ where: { id: examId } }); }
  await prisma.systemSetting.deleteMany({ where: { key: 'hydro' } });
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.$disconnect();
}
