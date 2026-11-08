import { parseBody } from '@/lib/http';
import { RelayMediaAuthSchema, authorizeRelayMedia } from '@/lib/live-relay-media-auth';
import { equalRelaySecret, requireRelayEnabled, validRelayControlToken } from '@/lib/live-relay-token';
import { admittedRelay, relayFailure, relayHeaders } from '@/lib/live-relay-http';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const deny = () => new Response(null, { status: 401, headers: relayHeaders });
    requireRelayEnabled();
    // The callback secret is checked before reading even this small body.
    if (!equalRelaySecret(new URL(request.url).searchParams.get('callback') || '')) return deny();
    const input = await parseBody(request, RelayMediaAuthSchema, 8192);
    // Control authentication is local signature work; it must not wait behind
    // publish DB locks while the reconciler is trying to close a publisher.
    if (input.action === 'api') return new Response(null, { status: validRelayControlToken(input.token) ? 204 : 401, headers: relayHeaders });
    return admittedRelay(request, async () => {
      await authorizeRelayMedia(input);
      return new Response(null, { status: 204, headers: relayHeaders });
    });
  } catch (error) { return relayFailure(error); }
}
