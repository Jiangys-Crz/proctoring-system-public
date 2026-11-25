import { AuthError } from '@/lib/auth';
import { contestLiveHeaders, contestLiveViewer, contestLiveViewerUnchanged, requireContestLiveManager } from '@/lib/contest-live-access';
import { contestLiveBroadcast } from '@/lib/contest-live-broadcast';
import { updateContestLiveConfig } from '@/lib/contest-live-config';
import { contestLiveSourceUnchanged, readContestLiveData } from '@/lib/contest-live-data';
import { validContestFreezeTime } from '@/lib/contest-live-contract';
import { contestLiveSettingsPatchSchema, mergeContestLiveSettings } from '@/lib/contest-live-settings';
import { admittedContestLiveRead } from '@/lib/heavy-read-admission';
import { fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

async function loadBroadcast(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const viewer = await contestLiveViewer(request, id);
    const scoreboardOnly = new URL(request.url).searchParams.get('view') === 'scoreboard';
    if (scoreboardOnly && !viewer.settings.freeze.at) throw new AuthError('请先在直播设置中手动设置封榜时间', 403);
    const teamIds = scoreboardOnly ? [] : [...viewer.settings.selectedTeamIds, ...viewer.settings.spotlight.teamIds];
    const content = await readContestLiveData(id, teamIds, scoreboardOnly ? 'normal' : viewer.settings.scoreboard.version, viewer.settings.freeze);
    if (!content) return fail('该考试暂无赛事数据', 404);
    const broadcast = await contestLiveBroadcast(content.data, scoreboardOnly ? { ...viewer, mediaAllowed: false } : viewer);
    const [latest, sourceUnchanged] = await Promise.all([
      contestLiveViewer(request, id), contestLiveSourceUnchanged(id, content.sourceRevision),
    ]);
    if (!sourceUnchanged || !contestLiveViewerUnchanged(viewer, latest)) {
      throw new AuthError('直播访问授权或设置已更新，正在重新同步', 409);
    }
    return ok(broadcast, { headers: contestLiveHeaders });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export function GET(request: Request, context: Context) {
  return admittedContestLiveRead(request, () => loadBroadcast(request, context));
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    await requireContestLiveManager(id, request);
    const patch = await parseBody(request, contestLiveSettingsPatchSchema, 256 * 1024);
    const result = await updateContestLiveConfig(id, (config, exam) => {
      const freezeAt = patch.freeze?.at;
      if (freezeAt && !validContestFreezeTime(freezeAt, exam)) {
        throw new AuthError('封榜时间必须在比赛开始和结束之间', 400);
      }
      const settings = mergeContestLiveSettings(config.settings, patch);
      if ((patch.publicEnabled || patch.publicMediaEnabled) && !settings.freeze.at) {
        throw new AuthError('请先在直播设置中手动设置封榜时间', 403);
      }
      if (patch.freeze?.revealed && (!settings.freeze.at || Date.parse(settings.freeze.at) > Date.now())) {
        throw new AuthError('赛事直播开始封榜后才能解封', 400);
      }
      if (config.settings.freeze.at && !settings.freeze.at) {
        return { settings: { ...settings, publicEnabled: false, publicMediaEnabled: false }, obsKeyHash: null };
      }
      return { ...config, settings };
    });
    return ok({ settings: { ...result.settings, obsKeyActive: Boolean(result.obsKeyHash) } }, { headers: contestLiveHeaders });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}
