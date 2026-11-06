import { authorizeRelayTicket } from '@/lib/live-relay';
import { equalRelaySecret, requireRelayEnabled } from '@/lib/live-relay-token';
import { admittedRelay, relayHeaders } from '@/lib/live-relay-http';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  return admittedRelay(request, async () => {
    requireRelayEnabled();
    if (!equalRelaySecret(request.headers.get('x-relay-internal') || '')) return new Response(null, { status: 401, headers: relayHeaders });
    await authorizeRelayTicket(request.headers.get('x-relay-id') || '', request.headers.get('x-relay-ticket') || '');
    return new Response(null, { status: 204, headers: relayHeaders });
  });
}
