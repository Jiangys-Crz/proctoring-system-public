import { getDesktopReleases } from '@/lib/desktop-releases';
import { ok, fail } from '@/lib/http';
import { DESKTOP_CHANNELS, type DesktopChannel } from '@cwnupaa/proctor-shared';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const channel = new URL(request.url).searchParams.get('channel') || 'public';
  if (!DESKTOP_CHANNELS.includes(channel as DesktopChannel)) return fail('客户端类型无效', 400);
  try { return ok(await getDesktopReleases(channel as DesktopChannel), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return fail('客户端版本服务暂时不可用，请稍后重试', 503); }
}
