import { AuthError } from '@/lib/auth';
import { requireContestDisplayManager, updateContestDisplayConfig } from '@/lib/contest-display-config';
import { contestDisplayControlState } from '@/lib/contest-display-data';
import { notifyContestDisplay } from '@/lib/contest-display-events';
import { contestLiveHeaders, digestContestLiveValue, makeContestLiveObsKey } from '@/lib/contest-live-access';
import { fail, ok } from '@/lib/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

function accessError(error: unknown) {
  return error instanceof AuthError ? fail(error.message, error.status) : fail('大屏访问链接操作失败，请稍后重试', 500);
}

export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    await requireContestDisplayManager(id, request);
    const key = makeContestLiveObsKey();
    const state = await updateContestDisplayConfig(id, config => {
      if (!config.settings.freeze.at) throw new AuthError('请先设置大屏封榜时间', 403);
      return { ...config, keyHash: digestContestLiveValue(key) };
    });
    notifyContestDisplay(id);
    return ok({ ...contestDisplayControlState(state, true), key }, { headers: contestLiveHeaders });
  } catch (error) { return accessError(error); }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    await requireContestDisplayManager(id, request);
    const state = await updateContestDisplayConfig(id, config => ({ ...config, keyHash: null }));
    notifyContestDisplay(id);
    return ok(contestDisplayControlState(state, true), { headers: contestLiveHeaders });
  } catch (error) { return accessError(error); }
}
