import { assertFederationDefinitionMutable } from './exam-federation-contract';
import { isBrowserExam, type CreateExamInput } from '@cwnupaa/proctor-shared';
import type { Prisma, ReactionLogoMatchBy } from '@prisma/client';
import { nextExamCode } from './exam-code';
import { prisma } from './db';
import { requestHydroProblem } from './hydro-contest';
import { getHydroSettings } from './settings';
import { assertHydroBrowserOriginKey, assertNovaJudgeOriginKey, ExamSettingsError, normalizeExamSettings, sameUrlOrigin } from './exam-settings';
import { problemLimits } from './problem-limits';
import { hydroProblemDocId } from './hydro-problem-identity';
import { problemFullScore } from './problem-score';
import { enableHydroBrowserContest, hydroBrowserConnection } from './hydro-browser';
import { enablePlatformSyncForNewExam } from './platform-sync-exams';
import { getPlatformSyncSettings } from './platform-sync-settings';
import { FederationError } from './exam-federation-protocol';
import { revokeInvalidContestLiveSchedule } from './contest-live-config';
import { removeContestLiveConnections } from './contest-live-media';

export async function saveExam(input: CreateExamInput & { reactionLogoMatchBy?: ReactionLogoMatchBy }, userId: string, examId?: string, suppliedNovaJudgeKey?: string | null, suppliedHydroBrowserKey?: string | null, suppliedHydroBrowserEventFeedKey?: string | null) {
  const { administratorIds, problemIds, platformSyncEnabled, scoreboardFrozenAt: _frozen, ...fields } = input;
  const settings = normalizeExamSettings(input);
  const browser = isBrowserExam(input.platform);
  if (examId && platformSyncEnabled !== undefined) throw new ExamSettingsError('请使用编辑页的跨网同步开关');
  if (browser && platformSyncEnabled) throw new ExamSettingsError('跨网同步仅支持监考系统本机考试');
  const syncSettings = platformSyncEnabled ? await getPlatformSyncSettings() : null;
  const hydro = input.platform === 'NOVAJUDGE' ? null : await getHydroSettings();
  if (input.platform === 'HYDRO_BROWSER') {
    try { hydroBrowserConnection(settings, hydro!); }
    catch (error) { throw new ExamSettingsError(error instanceof Error ? error.message : 'HydroOJ 配置无效'); }
  }
  const admins = administratorIds === undefined ? undefined : [...new Set(administratorIds)];
  if (admins && await prisma.user.count({ where: { id: { in: admins } } }) !== admins.length) {
    throw new ExamSettingsError('部分比赛管理员不存在，请重新选择');
  }
  const selected = browser || problemIds === undefined ? undefined : [...new Set(problemIds)];
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
      hydroDomain: hydro!.problemDomainId, hydroProblemId: hydroProblemDocId(problem),
      title: problem.title, content: problem.content || '', html: Boolean(problem.html),
      problemType: String(config.type || 'default'), config: config as Prisma.InputJsonValue,
      hydroScore, scorePercent: 100, score: 100,
      timeLimitMs: limits.timeLimitMs, memoryLimitMb: limits.memoryLimitMb,
      languages: Array.isArray(config.langs) ? config.langs as string[] : [],
      files: (problem.files || []) as Prisma.InputJsonValue,
    } };
  })) : undefined;
  const { exam, staleLiveConnections } = await prisma.$transaction(async tx => {
    if (examId) {
      await assertFederationDefinitionMutable(tx, examId);
      if (input.platform === 'NOVAJUDGE') {
        const current = await tx.exam.findUniqueOrThrow({ where: { id: examId }, select: { platformBaseUrl: true, novaJudgeApiKey: true } });
        assertNovaJudgeOriginKey(current.platformBaseUrl, settings.platformBaseUrl, suppliedNovaJudgeKey);
        // Preserve the current key rather than restoring an earlier copy from
        // a concurrent edit that did not explicitly provide a replacement.
        settings.novaJudgeApiKey = suppliedNovaJudgeKey?.trim() || current.novaJudgeApiKey;
      }
      if (input.platform === 'HYDRO_BROWSER') {
        const current = await tx.exam.findUniqueOrThrow({ where: { id: examId }, select: { platformBaseUrl: true, hydroBrowserApiKey: true, hydroBrowserEventFeedApiKey: true } });
        assertHydroBrowserOriginKey(current.platformBaseUrl, settings.platformBaseUrl, suppliedHydroBrowserKey);
        settings.hydroBrowserApiKey = suppliedHydroBrowserKey?.trim() || current.hydroBrowserApiKey;
        settings.hydroBrowserEventFeedApiKey = suppliedHydroBrowserEventFeedKey?.trim()
          || (sameUrlOrigin(current.platformBaseUrl, settings.platformBaseUrl) ? current.hydroBrowserEventFeedApiKey : null);
      }
      if (problems) {
        const fresh = await tx.examProblem.findMany({ where: { examId } });
        if (fresh.length !== currentProblems.length || fresh.some(row => { const prior = currentProblems.find(p => p.id === row.id); return !prior || prior.hydroProblemId !== row.hydroProblemId || prior.hydroDomain !== row.hydroDomain || prior.order !== row.order || prior.sourceDeleted !== row.sourceDeleted; })) throw new ExamSettingsError('题目列表在编辑期间已改变，请刷新后重试');
      }
    }
    const allData = {
      ...fields, ...settings, platformBaseUrl: browser ? settings.platformBaseUrl : hydro!.baseUrl,
      ...(browser ? { published: true } : selected ? { published: selected.length > 0 } : {}),
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
    if (input.platform === 'HYDRO_BROWSER') {
      try { await enableHydroBrowserContest(exam, hydro!); }
      catch (error) { throw new ExamSettingsError(error instanceof Error ? error.message : 'HydroOJ 比赛接入失败'); }
    }
    if (syncSettings) {
      try { await enablePlatformSyncForNewExam(tx, exam, syncSettings); }
      catch (error) {
        if (error instanceof FederationError) throw new ExamSettingsError(error.message);
        throw error;
      }
    }
    const staleLiveConnections = examId ? await revokeInvalidContestLiveSchedule(tx, exam) : [];
    return { exam, staleLiveConnections };
  }, { timeout: 15_000 });
  await removeContestLiveConnections(staleLiveConnections, '考试已保存，部分直播观看连接暂未断开，请重试');
  return exam;
}
