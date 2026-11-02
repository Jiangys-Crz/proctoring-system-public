import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CodeCheckJob, CodeCheckSource, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { aggregateComparisons, analyzeGroup, checkEngine, comparisonBatches, comparisonsForBatch, languageFor, type Comparison, type Submission } from './engine';
import { submissionTiming } from './submission-time';
import type { CodeCheckLevel } from './types';

const runtime = globalThis as unknown as { codeCheckControllers?: Map<string, AbortController> };
const controllers = runtime.codeCheckControllers ||= new Map<string, AbortController>();
const activeStatuses = ['queued', 'running', 'cancelling'];
const assets = path.join(process.cwd(), 'vendor/contest-code-check');
function capacity(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
const limits = {
  submissions: capacity('CODE_CHECK_MAX_SUBMISSIONS', 10000, 2, 100000),
  codeBytes: capacity('CODE_CHECK_MAX_CODE_BYTES', 256 * 1024, 1024, 1024 * 1024),
  totalBytes: capacity('CODE_CHECK_MAX_TOTAL_BYTES', 128 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024),
  groupSize: capacity('CODE_CHECK_MAX_GROUP_SIZE', 80, 2, 200),
  versionPairs: capacity('CODE_CHECK_MAX_VERSION_PAIRS', 1_000_000, 1, 50_000_000),
  resultPairs: capacity('CODE_CHECK_MAX_RESULT_PAIRS', 100_000, 1, 5_000_000),
};
export const codeCheckEngineOptions = (minTokens = 9, signal?: AbortSignal) => ({
  parserPath: path.join(assets, 'tokens'), workerPath: path.join(assets, 'token-worker.cjs'),
  heapMb: capacity('CODE_CHECK_WORKER_HEAP_MB', 512, 128, 4096), timeoutSeconds: capacity('CODE_CHECK_TIMEOUT_SECONDS', 180, 5, 3600), minTokens, signal,
});

export async function recoverCodeCheckJobs(examId: string) {
  // A stopped server must release its unique active slot without pretending a
  // partially written report completed. Queued work can be claimed after restart.
  const stale = new Date(Date.now() - 120_000);
  await prisma.codeCheckJob.updateMany({
    where: { examId, status: 'cancelling', leaseAt: { lt: stale } },
    data: { status: 'cancelled', phase: '已停止查重；保留已完成的结果', activeExamId: null, finishedAt: new Date() },
  });
  await prisma.codeCheckJob.updateMany({
    where: { examId, status: 'running', leaseAt: { lt: stale } },
    data: { status: 'failed', phase: '分析服务已中断，请重新查重；已有结果仅覆盖已完成的比较。', activeExamId: null, finishedAt: new Date() },
  });
}

export async function createCodeCheckJob(examId: string, createdById: string, input: { problemId?: string; minTokens: number; submissionScope: string }) {
  await recoverCodeCheckJobs(examId);
  const active = await prisma.codeCheckJob.findFirst({ where: { examId, status: { in: activeStatuses } } });
  if (active) return active;
  await checkEngine(codeCheckEngineOptions(input.minTokens));
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } });
  if (!exam) throw new Error('比赛不存在');
  if (input.problemId && !await prisma.examProblem.findFirst({ where: { id: input.problemId, examId, problemType: 'default' }, select: { id: true } })) throw new Error('所选题目不是本场比赛的编程题');
  try {
    return await prisma.codeCheckJob.create({ data: { examId, activeExamId: examId, createdById, problemId: input.problemId || null, minTokens: input.minTokens, submissionScope: input.submissionScope, warnings: [] } });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      const active = await prisma.codeCheckJob.findFirst({ where: { examId, status: { in: activeStatuses } } });
      if (active) return active;
    }
    throw error;
  }
}

export async function cancelCodeCheckJob(examId: string, jobId: string) {
  const queued = await prisma.codeCheckJob.updateMany({ where: { id: jobId, examId, status: 'queued' }, data: { status: 'cancelled', phase: '已停止查重', activeExamId: null, finishedAt: new Date() } });
  if (queued.count) return;
  await prisma.codeCheckJob.updateMany({ where: { id: jobId, examId, status: { in: ['running', 'cancelling'] } }, data: { status: 'cancelling', phase: '正在停止查重…' } });
  controllers.get(jobId)?.abort(new Error('已停止查重'));
}

const engineSource = (source: CodeCheckSource): Submission => ({ id: source.id, uid: source.uid, pid: source.pid, lang: source.lang, code: source.code });

export function canonicalComparison(comparison: Comparison, first: Submission, second: Submission) {
  if (first.uid <= second.uid) return { first, second, comparison };
  return {
    first: second, second: first,
    comparison: {
      ...comparison, firstSubmissionId: comparison.secondSubmissionId, secondSubmissionId: comparison.firstSubmissionId,
      firstSimilarity: comparison.secondSimilarity, secondSimilarity: comparison.firstSimilarity,
      matches: comparison.matches.map(match => ({ ...match, startInFirst: match.startInSecond, endInFirst: match.endInSecond, startInSecond: match.startInFirst, endInSecond: match.endInFirst, lengthOfFirst: match.lengthOfSecond, lengthOfSecond: match.lengthOfFirst })),
    },
  };
}

export function codeCheckPairEstimate(groups: number[][]) {
  let versionPairs = 0; let resultPairs = 0;
  for (const counts of groups) {
    const n = counts.reduce((sum, count) => sum + count, 0);
    versionPairs += (n * n - counts.reduce((sum, count) => sum + count * count, 0)) / 2;
    resultPairs += counts.length * (counts.length - 1) / 2;
  }
  return { versionPairs, resultPairs };
}

async function analyzeJob(job: CodeCheckJob, leaseId: string, controller: AbortController) {
  const whereLease = { id: job.id, leaseId, status: { in: ['running', 'cancelling'] } };
  const warnings: string[] = [];
  const warning = (value: string) => { if (warnings.length < 150) warnings.push(value); };
  let skipped = 0; let total = 0; let read = 0; let compared = 0; let completedGroups = 0;
  let fatalBatches = 0;
  const update = async (data: Prisma.CodeCheckJobUpdateManyMutationInput) => {
    // Completion is fenced against cancellation requested by another server
    // process, including the interval between the last poll and final commit.
    const finalizing = data.status === 'complete' || data.status === 'partial';
    const saved = await prisma.codeCheckJob.updateMany({ where: finalizing ? { ...whereLease, status: 'running' } : whereLease, data });
    if (!saved.count) controller.abort(new Error('查重任务已失去执行权')); controller.signal.throwIfAborted();
  };
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void (async () => {
      const latest = await prisma.codeCheckJob.findUnique({ where: { id: job.id }, select: { status: true, leaseId: true } });
      if (latest?.leaseId !== leaseId || latest.status !== 'running') controller.abort(new Error('已停止查重'));
      else {
        await prisma.codeCheckJob.updateMany({ where: { id: job.id, leaseId, status: 'running' }, data: { leaseAt: new Date() } });
        const engine = await prisma.codeCheckEngineLease.updateMany({ where: { id: 'syntax', ownerId: leaseId }, data: { leaseAt: new Date() } });
        if (!engine.count) controller.abort(new Error('语法引擎已失去执行权'));
      }
    })().catch(() => controller.abort(new Error('数据库连接中断，查重已停止'))).finally(() => { polling = false; });
  }, 2_000);
  try {
    await checkEngine(codeCheckEngineOptions(job.minTokens, controller.signal));
    const scope: Prisma.ContestSubmissionWhereInput = {
      examId: job.examId, createdAt: { lte: job.createdAt }, problem: { problemType: 'default' },
      ...(job.problemId ? { problemId: job.problemId } : {}),
      status: job.submissionScope === 'accepted' ? 1 : { not: 30 },
    };
    const users = new Map<string, number>(); const problems = new Map<string, number>();
    const groups = new Map<string, { problemId: string; title: string; language: string; ids: string[]; uidCounts: Map<number, number> }>();
    let cursor: string | undefined;
    let scanned = 0; let totalBytes = 0;
    total = await prisma.contestSubmission.count({ where: scope });
    if (total > limits.submissions) warning(`共 ${total} 份提交，超过本次 ${limits.submissions} 份的容量限制；其余提交未分析，请选择单道题重新查重。`);
    for (;;) {
      controller.signal.throwIfAborted();
      const remaining = limits.submissions - scanned;
      if (remaining <= 0) break;
      const records = await prisma.contestSubmission.findMany({
        where: scope, take: Math.min(100, remaining), ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: 'asc' },
        select: {
          id: true, candidateId: true, problemId: true, actorKey: true, candidateExamNumber: true, candidateName: true, teamName: true,
          lang: true, code: true, createdAt: true,
          candidate: { select: { examNumber: true, name: true, teamName: true } },
          problem: { select: { id: true, title: true, order: true, problemType: true } },
        },
      });
      if (!records.length) break;
      for (const record of records) {
        controller.signal.throwIfAborted(); scanned++;
        const language = languageFor(record.lang);
        const codeBytes = Buffer.byteLength(record.code);
        if (!language || !record.code.trim() || record.problem.problemType !== 'default' || codeBytes > limits.codeBytes || totalBytes + codeBytes > limits.totalBytes) {
          skipped++;
          warning(`提交 ${record.id}（${record.candidate.examNumber}）：${!language ? `不支持的语言 ${record.lang}` : !record.code.trim() ? '代码为空' : codeBytes > limits.codeBytes ? `代码超过 ${limits.codeBytes / 1024} KiB` : totalBytes + codeBytes > limits.totalBytes ? `总代码超过 ${limits.totalBytes / 1024 / 1024} MiB 容量` : '只有编程题参与代码查重'}`);
          continue;
        }
        const actorKey = record.actorKey || record.candidateId;
        if (!users.has(actorKey)) users.set(actorKey, users.size + 1);
        if (!problems.has(record.problemId)) problems.set(record.problemId, problems.size + 1);
        const source = await prisma.codeCheckSource.create({ data: {
          jobId: job.id, submissionId: record.id, candidateId: record.candidateId, actorKey,
          uid: users.get(actorKey)!, pid: problems.get(record.problemId)!, problemId: record.problemId,
          problemTitle: record.problem.title, problemOrder: record.problem.order,
          candidateName: record.teamName || record.candidate.teamName || record.candidateName || record.candidate.name || record.candidate.examNumber,
          examNumber: record.candidateExamNumber || record.candidate.examNumber,
          lang: record.lang, code: record.code, submittedAt: record.createdAt,
        } });
        const key = `${record.problemId}:${language.family}`;
        if (!groups.has(key)) groups.set(key, { problemId: record.problemId, title: record.problem.title, language: language.family, ids: [], uidCounts: new Map() });
        const group = groups.get(key)!;
        group.ids.push(source.id); group.uidCounts.set(source.uid, (group.uidCounts.get(source.uid) || 0) + 1); read++;
        totalBytes += codeBytes;
      }
      cursor = records.at(-1)!.id;
      await update({ total, read, skipped, phase: `读取比赛提交 ${scanned}/${total} 份`, warnings });
    }
    skipped += total - scanned;
    await update({ groups: groups.size, phase: '开始比较语法单元' });
    const estimated = codeCheckPairEstimate([...groups.values()].map(group => [...group.uidCounts.values()]));
    if (estimated.versionPairs > limits.versionPairs || estimated.resultPairs > limits.resultPairs) {
      throw new Error(`查重容量超限：预计 ${estimated.versionPairs.toLocaleString('zh-CN')} 次历史版本比较、${estimated.resultPairs.toLocaleString('zh-CN')} 组选手结果；上限分别为 ${limits.versionPairs.toLocaleString('zh-CN')} 次和 ${limits.resultPairs.toLocaleString('zh-CN')} 组。请选择单道编程题或仅 AC 提交，或调整服务器 CODE_CHECK_MAX_VERSION_PAIRS / CODE_CHECK_MAX_RESULT_PAIRS 后重新查重。`);
    }
    const analyzed = new Set<string>(); const failed = new Set<string>();
    for (const group of groups.values()) {
      if (group.uidCounts.size < 2) { completedGroups++; await update({ completedGroups }); continue; }
      let batchNumber = 0;
      for (const batch of comparisonBatches(group.ids, limits.groupSize)) {
        controller.signal.throwIfAborted(); batchNumber++;
        const sources = await prisma.codeCheckSource.findMany({ where: { jobId: job.id, id: { in: batch.ids } } });
        if (new Set(sources.map(source => source.uid)).size < 2) continue;
        await update({ phase: `分析 ${group.title} · ${group.language === 'c-cpp' ? 'C/C++' : group.language} · 第 ${batchNumber} 批（题目组 ${completedGroups + 1}/${groups.size}）` });
        const submissions = sources.map(engineSource);
        try {
          const result = await analyzeGroup(submissions, codeCheckEngineOptions(job.minTokens, controller.signal));
          controller.signal.throwIfAborted();
          const failedIds = new Set(result.failed);
          for (const source of sources) {
            if (!failedIds.has(source.id)) analyzed.add(source.id);
            else if (!failed.has(source.id)) { failed.add(source.id); warning(`提交 ${source.submissionId}（${source.examNumber}）：语法解析失败或有效语法单元不足 ${job.minTokens} 个`); }
          }
          const byId = new Map(sources.map(source => [source.id, source]));
          for (const item of aggregateComparisons(comparisonsForBatch(result.comparisons, batch), submissions)) {
            controller.signal.throwIfAborted();
            const canonical = canonicalComparison(item.comparison, item.first, item.second);
            const first = byId.get(canonical.first.id)!; const second = byId.get(canonical.second.id)!; const comparison = canonical.comparison;
            const key = { jobId: job.id, problemId: group.problemId, language: group.language, firstUid: first.uid, secondUid: second.uid };
            const existing = await prisma.codeCheckPair.findUnique({ where: { jobId_problemId_language_firstUid_secondUid: key } });
            const snapshot = {
              firstSourceId: first.id, secondSourceId: second.id, firstName: first.candidateName, secondName: second.candidateName,
              firstExamNumber: first.examNumber, secondExamNumber: second.examNumber,
              similarity: comparison.similarities.AVG, firstSimilarity: comparison.firstSimilarity, secondSimilarity: comparison.secondSimilarity,
              matches: comparison.matches as unknown as Prisma.InputJsonValue,
            };
            if (!existing) await prisma.codeCheckPair.create({ data: { ...key, problemTitle: first.problemTitle, problemOrder: first.problemOrder, ...snapshot, versions: item.versions } });
            else await prisma.codeCheckPair.update({ where: { id: existing.id }, data: { ...(snapshot.similarity > existing.similarity ? snapshot : {}), versions: { increment: item.versions } } });
          }
          compared = analyzed.size;
          await update({ compared, resultCount: await prisma.codeCheckPair.count({ where: { jobId: job.id } }), warnings });
        } catch (error) {
          controller.signal.throwIfAborted(); fatalBatches++;
          warning(`${group.title} · ${group.language} · 第 ${batchNumber} 批：${error instanceof Error ? error.message : '分析失败'}`);
        }
      }
      completedGroups++;
      await update({ completedGroups, compared });
    }
    await update({
      status: warnings.length || fatalBatches ? 'partial' : 'complete', phase: warnings.length || fatalBatches ? '分析结束；请查看未分析原因' : '语法分析完成',
      activeExamId: null, skipped: skipped + failed.size, warnings, finishedAt: new Date(), resultCount: await prisma.codeCheckPair.count({ where: { jobId: job.id } }),
    });
  } catch (error) {
    const latest = await prisma.codeCheckJob.findUnique({ where: { id: job.id }, select: { status: true } });
    const cancelled = latest?.status === 'cancelling';
    await prisma.codeCheckJob.updateMany({ where: whereLease, data: {
      status: cancelled ? 'cancelled' : 'failed', activeExamId: null, finishedAt: new Date(), total, read, compared, skipped, warnings,
      phase: cancelled ? '已停止查重；保留已完成的结果' : error instanceof Error ? error.message : '查重失败',
      resultCount: await prisma.codeCheckPair.count({ where: { jobId: job.id } }),
    } });
  } finally { clearInterval(timer); }
}

export async function runCodeCheckJob(jobId: string) {
  if (controllers.has(jobId)) return;
  const controller = new AbortController(); controllers.set(jobId, controller);
  const leaseId = randomUUID();
  let engineClaimed = false;
  try {
    await prisma.codeCheckEngineLease.upsert({ where: { id: 'syntax' }, create: { id: 'syntax' }, update: {} });
    const lease = await prisma.codeCheckEngineLease.updateMany({ where: { id: 'syntax', OR: [{ ownerId: null }, { leaseAt: { lt: new Date(Date.now() - 120_000) } }] }, data: { ownerId: leaseId, leaseAt: new Date() } });
    if (!lease.count) return;
    engineClaimed = true;
    const claimed = await prisma.codeCheckJob.updateMany({ where: { id: jobId, status: 'queued' }, data: { status: 'running', phase: '准备读取比赛提交', leaseId, leaseAt: new Date(), startedAt: new Date() } });
    if (claimed.count) {
      const job = await prisma.codeCheckJob.findUniqueOrThrow({ where: { id: jobId } });
      await analyzeJob(job, leaseId, controller);
    }
  } finally {
    controllers.delete(jobId);
    if (engineClaimed) await prisma.codeCheckEngineLease.updateMany({ where: { id: 'syntax', ownerId: leaseId }, data: { ownerId: null, leaseAt: null } });
  }
  if (engineClaimed) {
    const next = await prisma.codeCheckJob.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (next) await runCodeCheckJob(next.id);
  }
}

const jobView = (job: CodeCheckJob) => ({ ...job, warnings: Array.isArray(job.warnings) ? job.warnings : [], leaseId: undefined, leaseAt: undefined, createdById: undefined, activeExamId: undefined });

export async function getCodeCheckData(examId: string, query: { jobId?: string; problemId?: string; level: CodeCheckLevel; page: number }) {
  await recoverCodeCheckJobs(examId);
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, select: { id: true, name: true, problems: { where: { problemType: 'default' }, orderBy: { order: 'asc' }, select: { id: true, order: true, title: true } } } });
  const [history, activeJob] = await Promise.all([
    prisma.codeCheckJob.findMany({ where: { examId }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.codeCheckJob.findFirst({ where: { examId, status: { in: activeStatuses } }, orderBy: { createdAt: 'desc' } }),
  ]);
  const job = query.jobId ? await prisma.codeCheckJob.findFirst({ where: { id: query.jobId, examId } }) : activeJob || history[0] || null;
  if (query.jobId && !job) throw new Error('查重报告不存在或不属于本场比赛');
  const where: Prisma.CodeCheckPairWhereInput = {
    jobId: job?.id || '', ...(query.problemId ? { problemId: query.problemId } : {}),
    ...(query.level === 'high' ? { similarity: { gte: .8 } } : query.level === 'medium' ? { similarity: { gte: .5, lt: .8 } } : query.level === 'low' ? { similarity: { lt: .5 } } : {}),
  };
  const count = job ? await prisma.codeCheckPair.count({ where }) : 0;
  const pageCount = Math.max(1, Math.ceil(count / 50)); const page = Math.min(query.page, pageCount);
  const rows = job ? await prisma.codeCheckPair.findMany({ where, orderBy: [{ similarity: 'desc' }, { id: 'asc' }], take: 50, skip: (page - 1) * 50, omit: { matches: true, firstSourceId: true, secondSourceId: true } }) : [];
  return { exam: { id: exam.id, name: exam.name }, problems: exam.problems, job: job ? jobView(job) : null, activeJob: activeJob ? jobView(activeJob) : null, history: history.map(jobView), rows, count, page, pageCount };
}

export async function getCodeCheckDetail(examId: string, pairId: string) {
  const pair = await prisma.codeCheckPair.findFirst({ where: { id: pairId, job: { examId } } });
  if (!pair) return null;
  const [first, second] = await Promise.all([
    prisma.codeCheckSource.findFirst({ where: { id: pair.firstSourceId, jobId: pair.jobId } }),
    prisma.codeCheckSource.findFirst({ where: { id: pair.secondSourceId, jobId: pair.jobId } }),
  ]);
  if (!first || !second) return null;
  return { pair, first, second, timing: submissionTiming(first, second) };
}
