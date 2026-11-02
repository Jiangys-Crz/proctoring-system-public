import type { CreateExamInput } from '@cwnupaa/proctor-shared';
import type { Prisma } from '@prisma/client';
import { nextExamCode } from './exam-code';
import { prisma } from './db';
import { requestHydroProblem } from './hydro-contest';
import { getHydroSettings } from './settings';
import { ExamSettingsError, normalizeExamSettings } from './exam-settings';
import { problemLimits } from './problem-limits';
import { problemFullScore } from './problem-score';

export async function saveExam(input: CreateExamInput, userId: string, examId?: string) {
  const { administratorIds, problemIds, scoreboardFrozenAt: _frozen, ...fields } = input;
  const settings = normalizeExamSettings(input);
  const nova = input.platform === 'NOVAJUDGE';
  const hydro = nova ? null : await getHydroSettings();
  const admins = administratorIds === undefined ? undefined : [...new Set(administratorIds)];
  if (admins && await prisma.user.count({ where: { id: { in: admins } } }) !== admins.length) {
    throw new ExamSettingsError('部分比赛管理员不存在，请重新选择');
  }
  const selected = nova || problemIds === undefined ? undefined : [...new Set(problemIds)];
  const currentProblems = examId ? await prisma.examProblem.findMany({ where: { examId } }) : [];
  // Finish all remote reads before the transaction: a Hydro failure must not create a partial exam.
  const problems = selected ? await Promise.all(selected.map(async (id, order) => {
    const existing = currentProblems.find(problem => problem.hydroProblemId === id);
    if (existing) return { existing, order };
    const problem = await requestHydroProblem({ platformBaseUrl: hydro!.baseUrl }, id);
    const config = problem.config || {};
    const limits = problemLimits(config);
    const hydroScore = problemFullScore(problem) ?? 100;
    return { order, data: {
      hydroDomain: hydro!.problemDomainId, hydroProblemId: String(problem.id),
      title: problem.title, content: problem.content || '', html: Boolean(problem.html),
      problemType: String(config.type || 'default'), config: config as Prisma.InputJsonValue,
      hydroScore, scorePercent: 100, score: 100,
      timeLimitMs: limits.timeLimitMs, memoryLimitMb: limits.memoryLimitMb,
      languages: Array.isArray(config.langs) ? config.langs as string[] : [],
      files: (problem.files || []) as Prisma.InputJsonValue,
    } };
  })) : undefined;
  return prisma.$transaction(async tx => {
    const allData = {
      ...fields, ...settings, platformBaseUrl: hydro ? hydro.baseUrl : settings.platformBaseUrl,
      platformContestId: hydro ? 'local' : input.platformContestId,
      ...(nova ? { published: true } : selected ? { published: selected.length > 0 } : {}),
    };
    // Existing exams control live push settings through their dedicated endpoint.
    // Saving an older editor draft must never overwrite a newer live switch/configuration.
    const { externalBoardEnabled, externalBoardBaseUrl, externalBoardApiKey, externalBoardEventId, externalBoardIntervalSeconds, ...ordinaryData } = allData;
    const data = examId ? ordinaryData : allData;
    const exam = examId
      ? await tx.exam.update({ where: { id: examId }, data })
      : await tx.exam.create({ data: { ...data, examCode: await nextExamCode(tx, settings.startAt), createdById: userId } });
    if (admins) {
      await tx.examAdministrator.deleteMany({ where: { examId: exam.id } });
      if (admins.length) await tx.examAdministrator.createMany({ data: admins.map(id => ({ examId: exam.id, userId: id })) });
    }
    if (problems) {
      const removed = currentProblems.filter(p => !selected!.includes(p.hydroProblemId)).map(p => p.id);
      if (removed.length && await tx.contestSubmission.count({ where: { problemId: { in: removed } } })) {
        throw new ExamSettingsError('已有提交记录的题目不能从考试中移除');
      }
      await tx.examProblem.deleteMany({ where: { examId: exam.id, id: { in: removed } } });
      // Move retained rows out of the unique order range before reordering.
      for (const problem of currentProblems.filter(p => !removed.includes(p.id))) {
        await tx.examProblem.update({ where: { id: problem.id }, data: { order: -problem.order - 1 } });
      }
      for (const problem of problems) {
        if (problem.existing) await tx.examProblem.update({ where: { id: problem.existing.id }, data: { order: problem.order } });
        else await tx.examProblem.create({ data: { ...problem.data!, examId: exam.id, order: problem.order } });
      }
    }
    return exam;
  }, { timeout: 15_000 });
}
