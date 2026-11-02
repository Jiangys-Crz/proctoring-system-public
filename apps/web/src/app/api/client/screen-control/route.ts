import { requireClientSession } from '@/lib/client-auth';
import { fail, ok, options } from '@/lib/http';
import { getClientScreenControl } from '@/lib/screen-control';
import { screenControlRouteError } from '@/lib/screen-control-route';

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) return fail('缺少客户端会话', 400);
    const authorization = await requireClientSession(request, sessionId, 'DESKTOP');
    if (!authorization.ok) return fail(authorization.message, authorization.status);
    return ok(await getClientScreenControl(authorization.session.examId, sessionId), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return screenControlRouteError(error); }
}

export const OPTIONS = options;
