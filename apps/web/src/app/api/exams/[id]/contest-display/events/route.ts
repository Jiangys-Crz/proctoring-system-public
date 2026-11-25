import { AuthError } from '@/lib/auth';
import { authorizeContestDisplay, getContestDisplayViewer, readContestDisplayConfig } from '@/lib/contest-display-config';
import { openContestDisplayStream } from '@/lib/contest-display-events';
import { contestLiveHeaders } from '@/lib/contest-live-access';
import { admittedContestDisplayConnection } from '@/lib/heavy-read-admission';
import { fail } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return admittedContestDisplayConnection(request, async () => {
    try {
      const [config, viewer] = await Promise.all([readContestDisplayConfig(id), getContestDisplayViewer(request, id)]);
      authorizeContestDisplay(config, viewer);
      return new Response(openContestDisplayStream(request, id), { headers: {
        ...contestLiveHeaders, 'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'private, no-cache, no-store, no-transform', 'x-accel-buffering': 'no',
      } });
    } catch (error) {
      return error instanceof AuthError ? fail(error.message, error.status) : fail('无法连接大屏同步服务', 503);
    }
  });
}
