import { browserExamPlatformName, isBrowserExam, type CreateExamInput } from '@cwnupaa/proctor-shared';
import { isXcpcRule, normalizeContestFormat } from './contest-format';
import { novaJudgeOrigin, novaJudgeContestId } from './novajudge';
import { hydroBrowserTarget } from './hydro-browser';

export class ExamSettingsError extends Error {}

export function assertNovaJudgeOriginKey(currentBaseUrl: string, nextOrigin: string, suppliedKey?: string | null) {
  if (suppliedKey?.trim()) return;
  let currentOrigin: string | undefined;
  try { currentOrigin = novaJudgeOrigin(currentBaseUrl); } catch { /* An invalid legacy origin cannot authorize key reuse. */ }
  if (currentOrigin !== nextOrigin) throw new ExamSettingsError('更换 NovaJudge 站点时，请填写该站点的外榜 API Key');
}

export function sameUrlOrigin(left: string, right: string) {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
}

export function assertHydroBrowserOriginKey(currentBaseUrl: string, nextBaseUrl: string, suppliedKey?: string | null) {
  if (suppliedKey?.trim()) return;
  if (!sameUrlOrigin(currentBaseUrl, nextBaseUrl)) throw new ExamSettingsError('更换 HydroOJ 站点时，请填写该站点的监考插件 API-Key');
}

// Both creation and editing calculate authoritative times on the server.
export function normalizeExamSettings(input: Omit<CreateExamInput, 'contestRule'> & { contestRule: CreateExamInput['contestRule'] | 'ACM' }) {
  const nova = input.platform === 'NOVAJUDGE';
  const browser = isBrowserExam(input.platform);
  let platformBaseUrl: string | undefined;
  if (nova) {
    try { platformBaseUrl = novaJudgeOrigin(input.platformBaseUrl); novaJudgeContestId(input.platformContestId); }
    catch (error) { throw new ExamSettingsError(error instanceof Error ? error.message : 'NovaJudge 配置无效'); }
    if (!input.novaJudgeApiKey?.trim()) throw new ExamSettingsError('请填写 NovaJudge 外榜 API Key');
  }
  if (input.platform === 'HYDRO_BROWSER') {
    try { platformBaseUrl = hydroBrowserTarget(input.platformBaseUrl, input.platformContestId).base; }
    catch (error) { throw new ExamSettingsError(error instanceof Error ? error.message : 'HydroOJ 配置无效'); }
  }
  const hydroBrowserEventFeedApiKey = input.platform === 'HYDRO_BROWSER'
    ? input.hydroBrowserEventFeedApiKey?.trim() || null : null;
  if (hydroBrowserEventFeedApiKey && !/^[\x21-\x7e]{32,1024}$/.test(hydroBrowserEventFeedApiKey)) {
    throw new ExamSettingsError('HydroOJ EventFeed 密钥应为 32 到 1024 个可打印字符');
  }
  if (browser && input.problemIds?.length) {
    const platform = browserExamPlatformName(input.platform);
    throw new ExamSettingsError(`${platform} 考试的题目由 ${platform} 管理`);
  }
  const externalBoardEventId = input.externalBoardEventId?.trim() || null;
  const externalBoardBaseUrl = input.externalBoardBaseUrl?.trim() || 'https://www.example.org/api';
  if (input.externalBoardEnabled && !externalBoardEventId) throw new ExamSettingsError('开启外榜推送前，请填写 CWNUPAA 官网赛事 ID');
  const contestRule = nova || input.contestRule === 'ACM' ? 'XCPC' as const : input.contestRule;
  const format = normalizeContestFormat({ ...input, contestRule });
  // Keep older exam-editor payloads working: the legacy "allowPrint" switch
  // represents physical printing until that editor is migrated to printMode.
  const printMode = input.printMode === 'DISABLED' && input.allowPrint ? 'PHYSICAL' : input.printMode;
  const startAt = new Date(input.startAt);
  const latestStartAt = browser || isXcpcRule(contestRule) || !input.flexible ? startAt : new Date(input.latestStartAt);
  if (!Number.isFinite(+startAt) || !Number.isFinite(+latestStartAt)) throw new ExamSettingsError('请输入有效的考试时间');
  if (latestStartAt < startAt) throw new ExamSettingsError('最晚开始时间不能早于开始时间');
  const flexible = !isXcpcRule(contestRule) && latestStartAt > startAt;
  const endAt = new Date(+(flexible ? latestStartAt : startAt) + input.durationMinutes * 60_000);
  if (!Number.isFinite(+endAt)) throw new ExamSettingsError('考试时长超出范围');
  const freezeMinutes = browser ? 0 : isXcpcRule(contestRule) ? input.freezeMinutes ?? 0 : null;
  if (freezeMinutes !== null && freezeMinutes >= input.durationMinutes) throw new ExamSettingsError('封榜分钟数必须小于考试时长');
  const admissionDeadline = new Date(Math.min(+startAt + 15 * 60_000, +endAt));
  return {
    platformBaseUrl: platformBaseUrl ?? input.platformBaseUrl,
    platformContestId: nova ? String(novaJudgeContestId(input.platformContestId))
      : input.platform === 'HYDRO_BROWSER' ? input.platformContestId.toLowerCase() : 'local',
    novaJudgeApiKey: nova ? input.novaJudgeApiKey!.trim() : null,
    hydroBrowserApiKey: input.platform === 'HYDRO_BROWSER' ? input.hydroBrowserApiKey?.trim() || null : null,
    hydroBrowserEventFeedApiKey,
    externalBoardEnabled: input.externalBoardEnabled,
    externalBoardIntervalSeconds: input.externalBoardIntervalSeconds,
    externalBoardBaseUrl,
    ...(input.externalBoardApiKey === undefined ? {} : { externalBoardApiKey: input.externalBoardApiKey?.trim() || null }),
    externalBoardEventId,
    contestRule,
    contestType: format.contestType,
    teamAccountMode: format.teamAccountMode,
    allowTeamSubmissionView: format.allowTeamSubmissionView,
    leaderOnlySubmission: format.leaderOnlySubmission,
    startAt, latestStartAt: flexible ? latestStartAt : admissionDeadline, endAt,
    flexible,
    printMode,
    allowPrint: printMode !== 'DISABLED',
    showTestCaseCount: contestRule === 'KS' || input.showTestCaseCount,
    showObjectiveScore: !['OI', 'LANQIAO', 'KS'].includes(contestRule) && input.showObjectiveScore,
    freezeMinutes,
    scoreboardFrozenAt: freezeMinutes ? new Date(+endAt - freezeMinutes * 60_000) : null,
  };
}
