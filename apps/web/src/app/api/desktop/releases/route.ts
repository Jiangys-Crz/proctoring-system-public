import { getDesktopUpdaterReleases } from '@/lib/desktop-releases';
import { ok, fail } from '@/lib/http';
import { DESKTOP_CHANNELS, isDesktopReleaseRuntime, isDesktopTarget, supportsDesktopReleaseRuntime, type DesktopChannel } from '@cwnupaa/proctor-shared';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const channel = searchParams.get('channel') || 'public';
  const runtime = searchParams.get('runtime');
  const target = searchParams.get('target');
  if (!DESKTOP_CHANNELS.includes(channel as DesktopChannel) || runtime !== null && !isDesktopReleaseRuntime(runtime)) return fail('客户端类型无效', 400);
  if (target !== null && (!isDesktopTarget(target) || !supportsDesktopReleaseRuntime(target, runtime ?? undefined))) return fail('客户端架构无效', 400);
  try { return ok(await getDesktopUpdaterReleases(channel as DesktopChannel, runtime ?? undefined, true, target ?? undefined), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return fail('客户端版本服务暂时不可用，请稍后重试', 503); }
}
