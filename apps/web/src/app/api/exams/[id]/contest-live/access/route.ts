import { AuthError } from '@/lib/auth';
import { contestLiveHeaders, digestContestLiveValue, makeContestLiveObsKey, requireContestLiveManager } from '@/lib/contest-live-access';
import { updateContestLiveConfig } from '@/lib/contest-live-config';
import { fail, ok, toErrorMessage } from '@/lib/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    await requireContestLiveManager(id, request);
    const key = makeContestLiveObsKey();
    await updateContestLiveConfig(id, config => {
      if (!config.settings.freeze.at) throw new AuthError('请先在直播设置中手动设置封榜时间', 403);
      return { ...config, obsKeyHash: digestContestLiveValue(key) };
    });
    return ok({ key }, { headers: contestLiveHeaders });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    await requireContestLiveManager(id, request);
    await updateContestLiveConfig(id, config => ({ ...config, obsKeyHash: null }));
    return ok({ obsKeyActive: false }, { headers: contestLiveHeaders });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}
