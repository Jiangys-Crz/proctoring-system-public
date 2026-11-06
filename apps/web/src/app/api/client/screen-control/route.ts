import { requireClientSession } from '@/lib/client-auth';
import { fail, ok, options } from '@/lib/http';
import { getClientScreenControl } from '@/lib/screen-control';
import { screenControlRouteError } from '@/lib/screen-control-route';
import { prisma } from '@/lib/db';
import { isRetiredDesktopCredential } from '@/lib/retired-desktop-credential';

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) return fail('缺少客户端会话', 400);
    const authorization = await requireClientSession(request, sessionId, 'DESKTOP');
    if (!authorization.ok) {
      // A replacement login deliberately retires this exact session. Confirm
      // termination even though its tokens were erased; no exam data is exposed.
      // A device recovery also retains a hash-only retirement proof for its
      // previous desktop. Network errors and unrelated invalid credentials
      // still cannot masquerade as a STOP instruction to the active overlay.
      const retired = await prisma.clientSession.findUnique({ where: { id: sessionId }, select: { revokedAt: true } });
      if (retired?.revokedAt || await isRetiredDesktopCredential(prisma, request, sessionId)) {
        return ok({ serverNow: new Date().toISOString(), nextStartsAt: null, active: null }, { headers: { 'cache-control': 'no-store' } });
      }
      return fail(authorization.message, authorization.status);
    }
    return ok(await getClientScreenControl(authorization.session.examId, sessionId), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return screenControlRouteError(error); }
}

export const OPTIONS = options;
