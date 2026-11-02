import type { ExamProblem, Prisma } from '@prisma/client';
import { prisma } from './db';
import { getHydroSettings } from './settings';
import { requestHydroBridge, requestHydroProblem, type HydroProblemPayload } from './hydro-contest';
import { isPublicTestExam } from './public-test';
import { publicTestProblemId } from './public-test-config';
import { problemLimits } from './problem-limits';
import { problemFullScore } from './problem-score';

let cache: { key: string; expiresAt: number; pending: Promise<ExamProblem> } | undefined;

/** Keep the statement, language restrictions and numeric judge ID on the same configured problem. */
export async function syncPublicTestProblem(examId: string): Promise<ExamProblem> {
  if (!await isPublicTestExam(examId)) throw new Error('不是系统测试考试');
  const settings = await getHydroSettings();
  const configuredId = publicTestProblemId();
  const key = JSON.stringify([examId, settings.baseUrl, settings.problemDomainId, settings.apiKey, configuredId]);
  if (cache?.key === key && cache.expiresAt > Date.now()) return cache.pending;
  const pending = (async () => {
    const exam = { platformBaseUrl: settings.baseUrl };
    // Hydro's detail API takes a numeric docId; resolve a configured PID by exact match.
    const matches = await requestHydroBridge<HydroProblemPayload[]>(exam, '/api/proctor/problems', { query: configuredId, exactPid: configuredId, limit: 100 });
    const match = matches.find(problem => problem.pid === configuredId);
    const selectedId = match?.id || (/^[1-9]\d*$/.test(configuredId) ? configuredId : '');
    if (!selectedId) throw new Error(`系统测试题目 ${configuredId} 不存在，请联系管理员检查测试题号和题库域`);
    const problem = await requestHydroProblem(exam, selectedId);
    const id = Number(problem.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('系统测试题目编号无效，请联系管理员');
    const config = problem.config || {};
    const problemType = String(config.type || 'default');
    if (['objective', 'submit_answer'].includes(problemType)) throw new Error('系统测试需要配置编程题，请联系管理员修改测试题号');
    const limits = problemLimits(config);
    const hydroScore = problemFullScore(problem) ?? 100;
    const data = {
      hydroDomain: settings.problemDomainId, hydroProblemId: String(id),
      title: problem.title, content: problem.content || '', html: Boolean(problem.html),
      problemType, config: config as Prisma.InputJsonValue,
      hydroScore, scorePercent: 100, score: 100,
      timeLimitMs: limits.timeLimitMs, memoryLimitMb: limits.memoryLimitMb,
      languages: Array.isArray(config.langs) ? config.langs as string[] : [],
      files: (problem.files || []) as Prisma.InputJsonValue,
    };
    const saved = await prisma.examProblem.upsert({
      where: { examId_order: { examId, order: 0 } },
      create: { examId, order: 0, ...data }, update: data,
    });
    return saved;
  })();
  const next = { key, expiresAt: Infinity, pending };
  next.pending = pending.then(saved => {
    next.expiresAt = Date.now() + 10_000;
    return saved;
  }).catch(error => {
    if (cache === next) cache = undefined;
    throw error;
  });
  cache = next;
  return next.pending;
}

export async function publicTestJudgeProblem(examId: string) {
  return Number((await syncPublicTestProblem(examId)).hydroProblemId);
}
