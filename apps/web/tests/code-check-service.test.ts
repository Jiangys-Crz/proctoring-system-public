import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/lib/db';
import { canonicalComparison, cancelCodeCheckJob, codeCheckPairEstimate, createCodeCheckJob, getCodeCheckData, getCodeCheckDetail, recoverCodeCheckJobs, runCodeCheckJob } from '../src/lib/code-check/service';
import type { Comparison, Submission } from '../src/lib/code-check/engine';

async function mocked(mocks: Array<[object, string, unknown]>, run: () => Promise<void>) {
  const original = mocks.map(([target, key]) => (target as Record<string, unknown>)[key]);
  for (const [target, key, implementation] of mocks) (target as Record<string, unknown>)[key] = implementation;
  try { await run(); }
  finally { mocks.forEach(([target, key], index) => { (target as Record<string, unknown>)[key] = original[index]; }); }
}

test('concurrent requests to start the same exam return one persisted active report', async () => {
  let active: Record<string, unknown> | null = null; let creates = 0;
  await mocked([
    [prisma.codeCheckJob, 'updateMany', async () => ({ count: 0 })],
    [prisma.codeCheckJob, 'findFirst', async () => active],
    [prisma.exam, 'findUnique', async () => ({ id: 'exam' })],
    [prisma.codeCheckJob, 'create', async ({ data }: { data: Record<string, unknown> }) => {
      if (active) throw Object.assign(new Error('duplicate active exam'), { code: 'P2002' });
      creates++; active = { ...data, id: 'report' }; return active;
    }],
  ], async () => {
    const reports = await Promise.all([createCodeCheckJob('exam', 'admin', { minTokens: 9, submissionScope: 'all' }), createCodeCheckJob('exam', 'admin', { minTokens: 9, submissionScope: 'all' })]);
    assert.equal(creates, 1); assert.equal(reports[0].id, reports[1].id);
  });
});

test('interrupted cancelling reports remain cancelled, while interrupted running reports fail', async () => {
  const transitions: Array<{ where: { status: string }; data: { status: string; activeExamId: null } }> = [];
  await mocked([[prisma.codeCheckJob, 'updateMany', async (args: typeof transitions[number]) => { transitions.push(args); return { count: 1 }; }]], async () => {
    await recoverCodeCheckJobs('exam');
    assert.deepEqual(transitions.map(item => [item.where.status, item.data.status, item.data.activeExamId]), [['cancelling', 'cancelled', null], ['running', 'failed', null]]);
  });
});

test('queued cancellation releases the active slot without starting the engine', async () => {
  const writes: Array<{ data: { status: string; activeExamId: unknown } }> = [];
  await mocked([[prisma.codeCheckJob, 'updateMany', async (args: typeof writes[number]) => { writes.push(args); return { count: 1 }; }]], async () => {
    await cancelCodeCheckJob('exam', 'queued-report');
    assert.equal(writes.length, 1); assert.equal(writes[0].data.status, 'cancelled'); assert.equal(writes[0].data.activeExamId, null);
  });
});

test('selected history and source details cannot cross exam boundaries', async () => {
  await mocked([
    [prisma.codeCheckJob, 'updateMany', async () => ({ count: 0 })],
    [prisma.exam, 'findUniqueOrThrow', async () => ({ id: 'exam-a', name: 'A', problems: [] })],
    [prisma.codeCheckJob, 'findMany', async () => []],
    [prisma.codeCheckJob, 'findFirst', async () => null],
    [prisma.codeCheckPair, 'findFirst', async ({ where }: { where: { job: { examId: string } } }) => { assert.equal(where.job.examId, 'exam-a'); return null; }],
  ], async () => {
    await assert.rejects(getCodeCheckData('exam-a', { jobId: 'exam-b-report', level: 'all', page: 1 }), /不属于本场比赛/);
    assert.equal(await getCodeCheckDetail('exam-a', 'exam-b-pair'), null);
  });
});

test('canonical contestant order also swaps source coverage and matched line locations', () => {
  const first: Submission = { id: 'a', uid: 2, pid: 1, lang: 'cpp', code: '' };
  const second: Submission = { ...first, id: 'b', uid: 1 };
  const comparison: Comparison = { firstSubmissionId: 'a', secondSubmissionId: 'b', firstSimilarity: .5, secondSimilarity: 1, similarities: { AVG: .66, MAX: 1 }, matches: [{ startInFirst: { line: 2, column: 0 }, endInFirst: { line: 3, column: 10 }, startInSecond: { line: 4, column: 1 }, endInSecond: { line: 5, column: 11 }, lengthOfFirst: 9, lengthOfSecond: 9 }] };
  const normalized = canonicalComparison(comparison, first, second);
  assert.equal(normalized.first.id, 'b'); assert.equal(normalized.comparison.firstSimilarity, 1);
  assert.equal(normalized.comparison.matches[0].startInFirst.line, 4);
});

test('running a local AC report reads programming records only, snapshots local times, and never calls any external API', async () => {
  const job = { id: 'report-local', examId: 'exam-local', status: 'queued', createdAt: new Date('2026-10-07T12:00:00Z'), minTokens: 9, submissionScope: 'accepted', problemId: null };
  const snapshots: Record<string, unknown>[] = []; const writes: Record<string, unknown>[] = [];
  let read = false; let locked = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('查重不得发起外部网络请求'); }) as typeof fetch;
  try {
    await mocked([
      [prisma.codeCheckEngineLease, 'upsert', async () => ({ id: 'syntax' })],
      [prisma.codeCheckEngineLease, 'updateMany', async ({ data }: { data: { ownerId?: string | null } }) => { locked = data.ownerId !== null; return { count: 1 }; }],
      [prisma.codeCheckJob, 'updateMany', async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return { count: 1 }; }],
      [prisma.codeCheckJob, 'findUniqueOrThrow', async () => job],
      [prisma.codeCheckJob, 'findFirst', async () => null],
      [prisma.contestSubmission, 'count', async ({ where }: { where: { examId: string; status: number; problem: { problemType: string } } }) => { assert.equal(where.examId, 'exam-local'); assert.equal(where.status, 1); assert.equal(where.problem.problemType, 'default'); return 1; }],
      [prisma.contestSubmission, 'findMany', async ({ where }: { where: { createdAt: { lte: Date }; problem: { problemType: string } } }) => {
        assert.equal(locked, true); assert.equal(where.createdAt.lte, job.createdAt); assert.equal(where.problem.problemType, 'default');
        if (read) return []; read = true;
        return [{ id: 'local-submission', candidateId: 'candidate', problemId: 'problem', actorKey: 'candidate', lang: 'cpp', code: 'int main(){return 0;}', createdAt: new Date('2026-10-07T11:00:00Z'), candidate: { examNumber: '001', name: 'Alice', teamName: null }, problem: { id: 'problem', title: '本地题目', order: 1, problemType: 'default' } }];
      }],
      [prisma.codeCheckSource, 'create', async ({ data }: { data: Record<string, unknown> }) => { snapshots.push(data); return { ...data, id: 'snapshot' }; }],
      [prisma.codeCheckSource, 'findMany', async () => snapshots.map(item => ({ ...item, id: 'snapshot' }))],
      [prisma.codeCheckPair, 'count', async () => 0],
    ], async () => {
      await runCodeCheckJob(job.id);
      assert.equal(snapshots[0].submissionId, 'local-submission'); assert.equal(snapshots[0].candidateName, 'Alice');
      assert.equal((snapshots[0].submittedAt as Date).toISOString(), '2026-10-07T11:00:00.000Z');
      assert.equal(writes.at(-1)?.status, 'complete'); assert.equal(locked, false);
    });
  } finally { globalThis.fetch = previousFetch; }
});

test('the global engine lease keeps another contest queued instead of creating a second worker', async () => {
  let claims = 0;
  await mocked([
    [prisma.codeCheckEngineLease, 'upsert', async () => ({ id: 'syntax' })],
    [prisma.codeCheckEngineLease, 'updateMany', async () => ({ count: 0 })],
    [prisma.codeCheckJob, 'updateMany', async () => { claims++; throw new Error('busy engine must not claim queued job'); }],
  ], async () => {
    await runCodeCheckJob('another-contest-job'); assert.equal(claims, 0);
  });
});

test('oversized local source is never persisted, and capacity overflow produces a partial report', async () => {
  const job = { id: 'capacity-report', examId: 'exam-local', status: 'queued', createdAt: new Date(), minTokens: 9, submissionScope: 'all', problemId: null };
  let read = false; let snapshots = 0; let finalized: Record<string, unknown> = {};
  await mocked([
    [prisma.codeCheckEngineLease, 'upsert', async () => ({ id: 'syntax' })],
    [prisma.codeCheckEngineLease, 'updateMany', async () => ({ count: 1 })],
    [prisma.codeCheckJob, 'updateMany', async ({ data }: { data: Record<string, unknown> }) => { if (data.finishedAt) finalized = data; return { count: 1 }; }],
    [prisma.codeCheckJob, 'findUniqueOrThrow', async () => job],
    [prisma.codeCheckJob, 'findFirst', async () => null],
    [prisma.contestSubmission, 'count', async () => 10001],
    [prisma.contestSubmission, 'findMany', async () => {
      if (read) return []; read = true;
      return [{ id: 'oversized-local', candidateId: 'candidate', problemId: 'problem', lang: 'cpp', code: 'x'.repeat(256 * 1024 + 1), createdAt: new Date(), candidate: { examNumber: '001', name: 'Alice' }, problem: { id: 'problem', title: '题目', order: 1, problemType: 'default' } }];
    }],
    [prisma.codeCheckSource, 'create', async () => { snapshots++; throw new Error('oversized source must never be persisted'); }],
    [prisma.codeCheckPair, 'count', async () => 0],
  ], async () => {
    await runCodeCheckJob(job.id);
    assert.equal(snapshots, 0); assert.equal(finalized.status, 'partial'); assert.equal(finalized.skipped, 10001);
    assert.ok((finalized.warnings as string[]).some(value => value.includes('10000')));
    assert.ok((finalized.warnings as string[]).some(value => value.includes('256 KiB')));
  });
});

test('capacity estimates exclude each contestant own versions and sum all problem/language groups', () => {
  assert.deepEqual(codeCheckPairEstimate([[10, 20], [3, 2, 1], [300]]), { versionPairs: 211, resultPairs: 4 });
  assert.deepEqual(codeCheckPairEstimate([Array(10000).fill(1)]), { versionPairs: 49995000, resultPairs: 49995000 });
});

test('cancellation from a different process during final commit cannot be overwritten as complete', async () => {
  const job = { id: 'cancel-on-final', examId: 'exam-local', status: 'queued', createdAt: new Date(), minTokens: 9, submissionScope: 'all', problemId: null };
  let status = 'running'; let finalized: Record<string, unknown> = {};
  await mocked([
    [prisma.codeCheckEngineLease, 'upsert', async () => ({ id: 'syntax' })],
    [prisma.codeCheckEngineLease, 'updateMany', async () => ({ count: 1 })],
    [prisma.codeCheckJob, 'updateMany', async ({ where, data }: { where: { status: unknown }; data: Record<string, unknown> }) => {
      if (data.status === 'complete') {
        status = 'cancelling';
        assert.equal(where.status, 'running', 'completion must only commit against running status');
        return { count: 0 };
      }
      if (data.finishedAt) finalized = data;
      return { count: 1 };
    }],
    [prisma.codeCheckJob, 'findUniqueOrThrow', async () => job],
    [prisma.codeCheckJob, 'findUnique', async () => ({ status })],
    [prisma.codeCheckJob, 'findFirst', async () => null],
    [prisma.contestSubmission, 'count', async () => 0],
    [prisma.contestSubmission, 'findMany', async () => []],
    [prisma.codeCheckPair, 'count', async () => 0],
  ], async () => {
    await runCodeCheckJob(job.id);
    assert.equal(finalized.status, 'cancelled'); assert.equal(finalized.activeExamId, null);
    assert.match(String(finalized.phase), /保留已完成/);
  });
});

test('excessive report pair count fails explicitly before launching syntax workers', async () => {
  const job = { id: 'too-many-pairs', examId: 'exam-local', status: 'queued', createdAt: new Date(), minTokens: 9, submissionScope: 'all', problemId: null };
  let read = false; let finalized: Record<string, unknown> = {}; let sourceNumber = 0;
  await mocked([
    [prisma.codeCheckEngineLease, 'upsert', async () => ({ id: 'syntax' })],
    [prisma.codeCheckEngineLease, 'updateMany', async () => ({ count: 1 })],
    [prisma.codeCheckJob, 'updateMany', async ({ data }: { data: Record<string, unknown> }) => { if (data.finishedAt) finalized = data; return { count: 1 }; }],
    [prisma.codeCheckJob, 'findUniqueOrThrow', async () => job],
    [prisma.codeCheckJob, 'findUnique', async () => ({ status: 'running' })],
    [prisma.codeCheckJob, 'findFirst', async () => null],
    [prisma.contestSubmission, 'count', async () => 500],
    [prisma.contestSubmission, 'findMany', async () => {
      if (read) return []; read = true;
      return Array.from({ length: 500 }, (_, index) => ({ id: `local-${index}`, candidateId: `candidate-${index}`, problemId: 'problem', lang: 'cpp', code: 'int main(){return 0;}', createdAt: new Date(), candidate: { examNumber: String(index), name: `选手 ${index}` }, problem: { id: 'problem', title: '编程题', order: 1, problemType: 'default' } }));
    }],
    [prisma.codeCheckSource, 'create', async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: `snapshot-${sourceNumber++}` })],
    [prisma.codeCheckSource, 'findMany', async () => { throw new Error('pair budget must be checked before loading a worker batch'); }],
    [prisma.codeCheckPair, 'count', async () => 0],
  ], async () => {
    await runCodeCheckJob(job.id);
    assert.equal(finalized.status, 'failed'); assert.match(String(finalized.phase), /容量超限/);
    assert.match(String(finalized.phase), /124,750/); assert.match(String(finalized.phase), /CODE_CHECK_MAX_RESULT_PAIRS/);
  });
});
