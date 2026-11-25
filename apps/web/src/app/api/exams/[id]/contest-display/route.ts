import { AuthError } from '@/lib/auth';
import { authorizeContestDisplay, displayPatchSchema, getContestDisplayViewer, mergeContestDisplaySettings, readContestDisplayConfig, requireContestDisplayManager, updateContestDisplayConfig } from '@/lib/contest-display-config';
import { contestDisplayControlState, contestDisplayResponse, contestDisplaySourcesUnchanged, readContestDisplayContent } from '@/lib/contest-display-data';
import { notifyContestDisplay } from '@/lib/contest-display-events';
import { validateContestDisplayHistory } from '@/lib/contest-display-history';
import { contestLiveHeaders } from '@/lib/contest-live-access';
import { admittedContestDisplayRead } from '@/lib/heavy-read-admission';
import { fail, ok, parseBody, RequestParseError } from '@/lib/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

function responseError(error: unknown) {
  if (error instanceof AuthError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  return fail('无法读取或保存大屏数据，请稍后重试', 500);
}

async function load(request: Request, id: string, display: boolean) {
  const [config, viewer] = await Promise.all([readContestDisplayConfig(id), getContestDisplayViewer(request, id)]);
  if (display) authorizeContestDisplay(config, viewer);
  else if (!viewer.manage) throw new AuthError('无权管理该考试的大屏', 403);
  const data = await readContestDisplayContent(id, config);
  const [latest, verifiedViewer, sourcesUnchanged] = await Promise.all([
    readContestDisplayConfig(id), getContestDisplayViewer(request, id), contestDisplaySourcesUnchanged(id, data),
  ]);
  if (display) authorizeContestDisplay(latest, verifiedViewer);
  else if (!verifiedViewer.manage) throw new AuthError('无权管理该考试的大屏', 403);
  if (config.revision !== latest.revision || !sourcesUnchanged) throw new AuthError('大屏设置或名单已更新，请重新同步', 409);
  return ok(contestDisplayResponse(config, data, verifiedViewer), { headers: contestLiveHeaders });
}

export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  return admittedContestDisplayRead(request, async () => {
    try {
      const query = new URL(request.url).searchParams;
      return await load(request, id, query.get('view') === 'display' || query.has('key'));
    } catch (error) { return responseError(error); }
  });
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const manager = await requireContestDisplayManager(id, request);
    const { expectedRevision, restartClock, ...patch } = await parseBody(request, displayPatchSchema, 256 * 1024);
    if (patch.historyExamIds) await validateContestDisplayHistory(id, patch.historyExamIds, manager);
    const config = await updateContestDisplayConfig(id, (config, timing) => {
      if (expectedRevision !== undefined && expectedRevision !== config.revision) {
        throw new AuthError('其他导播已更新大屏，请刷新后重试', 409);
      }
      return { ...config, settings: mergeContestDisplaySettings(config.settings, patch, timing) };
    }, restartClock);
    notifyContestDisplay(id);
    return ok(contestDisplayControlState(config, true), { headers: contestLiveHeaders });
  } catch (error) { return responseError(error); }
}
