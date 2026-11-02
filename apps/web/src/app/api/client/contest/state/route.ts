import { requireContestSession } from '@/lib/client-contest';
import { serializeContestState } from '@/lib/client-contest-state';
import { fail, ok, options, toErrorMessage } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId') || '';
    if (!sessionId) return fail('缺少 sessionId', 400);
    // Authenticate every poll with fresh database state. Only problem metadata
    // is loaded; this route never fetches submissions, statements or Hydro.
    const authorized = await requireContestSession(request, sessionId, true);
    if (!authorized.ok) return fail(authorized.message, authorized.status);
    return ok(serializeContestState(authorized.session), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
