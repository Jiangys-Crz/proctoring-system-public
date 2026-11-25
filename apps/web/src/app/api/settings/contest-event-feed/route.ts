import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { ContestFeedSettingsSchema, contestFeedSettingsStatus, saveContestFeedSettings } from '@/lib/contest-event-feed-settings';
import { fail, ok, parseBody, RequestParseError } from '@/lib/http';
import { assertLiveKeyRequestOrigin } from '@/lib/live-api-key';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    await requireSuperAdmin(request);
    return ok(await contestFeedSettingsStatus(), { headers });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail('无法读取赛事 Event Feed 凭据设置', 500);
  }
}

export async function PUT(request: Request) {
  try {
    await requireSuperAdmin(request);
    assertLiveKeyRequestOrigin(request);
    await saveContestFeedSettings(await parseBody(request, ContestFeedSettingsSchema, 8 * 1024));
    return ok(await contestFeedSettingsStatus(), { headers });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail('凭据格式无效，请检查站点地址、账号或密钥', 400);
    return fail('无法保存赛事 Event Feed 凭据', 500);
  }
}
