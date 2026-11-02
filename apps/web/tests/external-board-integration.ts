// Run against an isolated MySQL fixture; the real CWNUPAA website is never contacted.
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/db';
import { pushExternalBoard, cancelExternalBoardPush } from '../src/lib/external-board';
import { saveExam } from '../src/lib/exam-save';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { saveExternalBoardSettings } from '../src/lib/external-board-settings';
import { appendExternalBoardLog, readExternalBoardLogs } from '../src/lib/external-board-log';

if (!process.env.DATABASE_URL?.includes('/proctor_external_board_qa')) throw new Error('Use the external-board fixture database.');
const realFetch = globalThis.fetch;
const findSetting = prisma.systemSetting.findUnique;
const calls: Array<{ url: string; body: any }> = [];
const received = new Map<string, any>();
let mode: 'ok' | 'network' | 'forbidden' | 'partial' = 'ok';
let expectedKey = 'fixture-app-key';
let afterProblems: (() => Promise<void>) | undefined;
let holdSubmission: (() => Promise<void>) | undefined;
const examIds: string[] = [];
const userIds: string[] = [];

async function tick(id: string) {
  await prisma.externalBoardSync.updateMany({ where: { examId: id }, data: { nextAttemptAt: null } });
  await new Promise(resolve => setTimeout(resolve, 5));
  await pushExternalBoard(id);
}

try {
  prisma.systemSetting.findUnique = (async (args: any) => args.where.key === 'externalLogin'
    ? { key: 'externalLogin', value: { apiBase: 'https://board-fixture.example/api', appKey: 'fixture-app-key' } }
    : findSetting.call(prisma.systemSetting, args)) as typeof findSetting;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body));
    const path = new URL(String(url)).pathname;
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    assert.equal(body.api_key, expectedKey);
    assert.match(path, /^\/api\/external\/board\/\d+\/(problems|submissions)$/);
    calls.push({ url: String(url), body });
    if (mode === 'network') throw new Error('fixture outage containing fixture-app-key');
    if (mode === 'forbidden') return Response.json({ code: 403, msg: 'do not echo fixture-app-key' });
    if (body.problems) {
      await afterProblems?.();
      return Response.json({ code: 200, data: `成功更新了 ${body.problems.length} 个题目信息` });
    }
    await holdSubmission?.();
    for (const record of body.submissions) received.set(record.rid, record);
    return Response.json({ code: 200, data: `成功处理并保存了 ${mode === 'partial' ? 0 : body.submissions.length} 条提交记录` });
  };

  const startAt = new Date(Date.now() - 3600_000), endAt = new Date(Date.now() + 3600_000);
  const exam = await prisma.exam.create({ data: {
    examCode: '2099010101', name: 'External board QA', startAt, latestStartAt: startAt, endAt, durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: 'http://unused-hydro.example', platformContestId: 'local', contestType: 'INDIVIDUAL', rules: '',
    externalBoardBaseUrl: 'https://board-fixture.example/api', externalBoardEventId: '123',
    problems: { create: { order: 0, hydroProblemId: '1', title: 'QA problem', content: '', score: 80, hydroScore: 200 } },
  }, include: { problems: true } });
  examIds.push(exam.id);
  const candidate = await prisma.candidate.create({ data: { examId: exam.id, examNumber: '0000123', password: 'qa-password', seatNo: '1' } });
  const submission = await prisma.contestSubmission.create({ data: {
    examId: exam.id, candidateId: candidate.id, problemId: exam.problems[0].id,
    lang: 'cc.cc17o2', code: 'int main() {}', status: 1, statusText: 'Accepted', score: 100,
    judgeAt: new Date(), createdAt: new Date(+startAt + 60_000), updatedAt: new Date(Date.now() - 60_000),
  } });
  await pushExternalBoard(exam.id);
  assert.equal(calls.length, 0, 'disabled exams make zero HTTP requests');
  assert.equal(await prisma.externalBoardSync.count({ where: { examId: exam.id } }), 0);
  await prisma.exam.update({ where: { id: exam.id }, data: { externalBoardEnabled: true } });
  await tick(exam.id);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.problems);
  assert.equal(calls[1].body.submissions[0].username, candidate.examNumber);
  assert.equal(calls[1].body.submissions[0].score, 50);
  let state = await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } });
  assert.ok(state.syncedThrough); assert.equal(state.lastError, null); assert.equal(state.leaseToken, null);
  let log = readExternalBoardLogs(exam.id)[0];
  assert.equal(log.status, 'SUCCESS'); assert.equal(log.problemCount, 1); assert.equal(log.submissionCount, 1);
  assert.ok(+state.nextAttemptAt! - Date.now() > 9000, 'default ten-second interval is persisted');
  const scheduledCalls = calls.length;
  await pushExternalBoard(exam.id); assert.equal(calls.length, scheduledCalls, 'not due: no additional requests');
  await prisma.exam.update({ where: { id: exam.id }, data: { externalBoardIntervalSeconds: 120 } });
  await tick(exam.id);
  state = await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } });
  assert.ok(+state.nextAttemptAt! - Date.now() > 119000, 'per-exam interval controls the next batch');
  const before = calls.length;
  await tick(exam.id);
  assert.equal(calls.length, before, 'unchanged old records and problems are not resent');
  await prisma.exam.update({ where: { id: exam.id }, data: { externalBoardApiKey: 'custom-push-key' } });
  expectedKey = 'custom-push-key'; await tick(exam.id);
  assert.equal(calls.at(-1)!.body.api_key, 'custom-push-key');
  await prisma.exam.update({ where: { id: exam.id }, data: { externalBoardApiKey: '' } });
  expectedKey = 'fixture-app-key'; await tick(exam.id);
  assert.equal(calls.at(-1)!.body.api_key, 'fixture-app-key', 'blank key falls back to external-login key');
  const oldCheckpoint = (await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } })).syncedThrough;

  await prisma.contestSubmission.update({ where: { id: submission.id }, data: { status: 2, statusText: 'Wrong Answer', score: 25 } });
  mode = 'network'; await tick(exam.id);
  state = await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } });
  assert.equal(+state.syncedThrough!, +oldCheckpoint!);
  assert.match(state.lastError!, /超时/); assert.ok(!state.lastError!.includes('fixture-app-key'));
  log = readExternalBoardLogs(exam.id).find(row => row.status === 'ERROR')!;
  assert.match(log.message, /120 秒后/); assert.ok(!log.message.includes('fixture-app-key'));
  mode = 'ok'; await tick(exam.id);
  assert.equal(received.size, 1, 'stable rid updates an existing result');
  assert.equal(received.get(`proctor:${submission.id}`).status, 'Wrong Answer');
  assert.equal(received.get(`proctor:${submission.id}`).score, 13);
  await prisma.contestSubmission.update({ where: { id: submission.id }, data: { manualScore: 60 } });
  await tick(exam.id); assert.equal(received.get(`proctor:${submission.id}`).score, 75);
  await prisma.contestSubmission.update({ where: { id: submission.id }, data: { status: 30 } });
  await tick(exam.id); assert.equal(received.get(`proctor:${submission.id}`).score, 0);
  assert.equal(received.get(`proctor:${submission.id}`).status, 'Compile Error');

  await prisma.exam.update({ where: { id: exam.id }, data: { externalBoardBaseUrl: 'https://other-fixture.example/api', externalBoardEventId: '456' } });
  const beforeUntrustedTarget = calls.length;
  await tick(exam.id);
  assert.equal(calls.length, beforeUntrustedTarget, 'an exam manager cannot redirect a system credential to another origin');
  state = await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } });
  assert.match(state.lastError!, /专用推送密钥/);
  assert.ok(!state.lastError!.includes('fixture-app-key'));
  await prisma.exam.update({ where: { id: exam.id }, data: { externalBoardApiKey: 'fixture-app-key' } });
  await tick(exam.id);
  assert.ok(calls.at(-2)!.url.includes('other-fixture.example/api/external/board/456/problems'));
  assert.equal(calls.at(-1)!.body.submissions[0].rid, `proctor:${submission.id}`);

  await prisma.examProblem.update({ where: { id: exam.problems[0].id }, data: { title: 'Changed title' } });
  afterProblems = async () => { await prisma.exam.update({ where: { id: exam.id }, data: { externalBoardEnabled: false } }); };
  const switchCalls = calls.length;
  await tick(exam.id);
  assert.equal(calls.length, switchCalls + 1, 'turning off between POSTs stops the submissions POST');
  afterProblems = undefined;
  await tick(exam.id); assert.equal(calls.length, switchCalls + 1);

  await prisma.exam.update({ where: { id: exam.id }, data: { externalBoardEnabled: true } });
  mode = 'forbidden'; await tick(exam.id);
  state = await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } });
  assert.match(state.lastError!, /外榜权限/); assert.ok(!state.lastError!.includes('fixture-app-key'));
  mode = 'ok'; await tick(exam.id);
  await prisma.contestSubmission.update({ where: { id: submission.id }, data: { score: 30 } });
  mode = 'partial'; await tick(exam.id);
  assert.match((await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } })).lastError!, /未完整接收/);
  mode = 'ok'; await tick(exam.id);

  // More than one batch, tied timestamps, new worker invocation and pending rows.
  const stamp = new Date(Date.now() - 10_000);
  await prisma.contestSubmission.createMany({ data: Array.from({ length: 55 }, (_, index) => ({
    id: `qa-submission-${index.toString().padStart(3, '0')}`, examId: exam.id, candidateId: candidate.id,
    problemId: exam.problems[0].id, lang: 'cpp', code: '// QA', status: 1, score: 200, judgeAt: stamp,
    createdAt: new Date(+startAt + 120_000), updatedAt: stamp,
  })) });
  const pending = await prisma.contestSubmission.create({ data: { examId: exam.id, candidateId: candidate.id, problemId: exam.problems[0].id, lang: 'cpp', code: '// pending', createdAt: stamp, updatedAt: stamp } });
  await tick(exam.id);
  assert.ok((await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } })).scanUntil);
  await tick(exam.id);
  assert.equal(received.size, 56);
  assert.ok(calls.every(call => !call.body.submissions || call.body.submissions.length <= 50));
  assert.ok(!received.has(`proctor:${pending.id}`), 'pending results are not advertised as judged scores');
  await prisma.contestSubmission.update({ where: { id: pending.id }, data: { judgeAt: new Date(), status: 1, score: 200 } });
  await tick(exam.id); await tick(exam.id); assert.ok(received.has(`proctor:${pending.id}`));

  // A second process cannot POST while the first owns the database lease.
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  holdSubmission = async () => { entered(); await held; };
  const first = tick(exam.id); await started;
  const heldCalls = calls.length; await pushExternalBoard(exam.id); assert.equal(calls.length, heldCalls);
  release(); await first; holdSubmission = undefined;

  // Saving the switch revokes a live lease in the SAME transaction and
  // leaves existing exam data, candidates, records and other settings intact.
  const manager = await prisma.user.create({ data: { username: 'external-board-qa-admin', role: 'SUPER_ADMIN' } }); userIds.push(manager.id);
  const current = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
  await prisma.externalBoardSync.update({ where: { examId: exam.id }, data: { leaseToken: 'held-worker', leaseUntil: new Date(Date.now() + 60_000) } });
  // Even a stale ordinary exam editor containing an old switch must preserve the live configuration.
  const ordinarySaved = await saveExam(CreateExamSchema.parse({ ...current, externalBoardEnabled: false, externalBoardEventId: '789' }), manager.id, exam.id);
  assert.equal(ordinarySaved.externalBoardEnabled, true);
  assert.equal(ordinarySaved.externalBoardEventId, current.externalBoardEventId);
  assert.equal(ordinarySaved.externalBoardIntervalSeconds, 120);
  assert.equal((await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } })).leaseToken, 'held-worker');
  expectedKey = 'config-only-key';
  const configOnly = await saveExternalBoardSettings(exam.id, { externalBoardApiKey: 'config-only-key' });
  assert.equal(configOnly.externalBoardEnabled, true); assert.equal(configOnly.externalBoardEventId, current.externalBoardEventId);
  // Wait for its immediate background trigger before checking the explicit stop.
  await (globalThis as any).externalBoardTask;
  await prisma.externalBoardSync.update({ where: { examId: exam.id }, data: { leaseToken: 'held-worker', leaseUntil: new Date(Date.now() + 60_000) } });
  const saved = await saveExternalBoardSettings(exam.id, { externalBoardEnabled: false });
  const unchanged = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
  assert.equal(saved.externalBoardEnabled, false);
  assert.equal(unchanged.name, current.name);
  assert.equal(unchanged.contestRule, current.contestRule); assert.equal(unchanged.requireMiniProgram, current.requireMiniProgram);
  assert.equal((await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } })).leaseToken, null);
  assert.equal(await prisma.candidate.count({ where: { examId: exam.id } }), 1);
  assert.equal(await prisma.contestSubmission.count({ where: { examId: exam.id } }), 57);
  const stoppedCalls = calls.length; await tick(exam.id); assert.equal(calls.length, stoppedCalls);
  const priorCheckpoint = (await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } })).configHash;
  await saveExternalBoardSettings(exam.id, { externalBoardIntervalSeconds: 15 });
  const intervalOnly = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
  assert.equal(intervalOnly.externalBoardEnabled, false); assert.equal(intervalOnly.externalBoardIntervalSeconds, 15);
  assert.equal((await prisma.externalBoardSync.findUniqueOrThrow({ where: { examId: exam.id } })).configHash, priorCheckpoint);
  const history = readExternalBoardLogs(exam.id);
  assert.ok(history.some(row => row.message.includes('已关闭推送')));
  assert.ok(!JSON.stringify(history).includes('config-only-key'), 'logs never store credentials');
  // A noisy long-running exam must not grow its log storage indefinitely.
  for (let index = 0; index < 105; index++) appendExternalBoardLog({ examId: exam.id, status: 'INFO', message: `retention fixture ${index}` });
  assert.equal(readExternalBoardLogs(exam.id).length, 100);
  assert.equal(readExternalBoardLogs(exam.id)[0].message, 'retention fixture 104');

  console.log('PASS: disabled gate, per-exam domain/event, payload ordering, incremental updates, retry checkpoints, manual scores, ignored results, target replay, switch checks, permission/count errors, durable pagination, pending judging, worker lease and transactional switch save.');
} finally {
  for (const id of examIds) cancelExternalBoardPush(id);
  globalThis.fetch = realFetch;
  prisma.systemSetting.findUnique = findSetting;
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}
