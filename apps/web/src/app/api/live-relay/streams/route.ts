import { requireSuperAdmin } from '@/lib/auth';
import { createRelayStream, liveRelayState, RelayPatchSchema, RelayStreamCreateSchema, updateRelay } from '@/lib/live-relay';
import { parseBody } from '@/lib/http';
import { relayFailure, relayHeaders } from '@/lib/live-relay-http';

export async function GET() {
  try { await requireSuperAdmin(); return Response.json({ ok: true, data: await liveRelayState() }, { headers: relayHeaders }); }
  catch (error) { return relayFailure(error); }
}
export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request);
    const input = await parseBody(request, RelayStreamCreateSchema, 2048);
    await createRelayStream(input);
    return Response.json({ ok: true, data: { id: input.id } }, { status: 201, headers: relayHeaders });
  } catch (error) { return relayFailure(error); }
}
export async function PATCH(request: Request) {
  try {
    await requireSuperAdmin(request);
    await updateRelay(await parseBody(request, RelayPatchSchema, 4096));
    return Response.json({ ok: true, data: { saved: true } }, { headers: relayHeaders });
  } catch (error) { return relayFailure(error); }
}
