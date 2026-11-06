import { z } from 'zod';
import { requireSuperAdmin } from '@/lib/auth';
import { relayPreviewTicket } from '@/lib/live-relay';
import { relayIdPattern, relayPlaybackUrl } from '@/lib/live-relay-token';
import { parseBody } from '@/lib/http';
import { relayFailure, relayHeaders } from '@/lib/live-relay-http';

export async function POST(request: Request) {
  try {
    const user = await requireSuperAdmin(request);
    const { id } = await parseBody(request, z.object({ id: z.string().regex(relayIdPattern) }), 1024);
    return Response.json({ ok: true, data: { url: relayPlaybackUrl(await relayPreviewTicket(id, user.id), id) } }, { headers: relayHeaders });
  } catch (error) { return relayFailure(error); }
}
