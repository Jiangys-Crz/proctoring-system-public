import { z } from 'zod';
import { parseBody } from '@/lib/http';
import { authorizeRelaySignal } from '@/lib/live-relay-connections';
import { equalRelaySecret, relayIdPattern, requireRelayEnabled, validRelayControlToken } from '@/lib/live-relay-token';
import { admittedRelay, relayFailure, relayHeaders } from '@/lib/live-relay-http';

export const runtime = 'nodejs';
const Schema = z.object({ action: z.string().max(32), protocol: z.string().max(32).default(''), path: z.string().max(128).default(''), token: z.string().max(2048).default(''), id: z.string().uuid().nullable().optional() });
export async function POST(request: Request) {
  try {
    const deny = () => new Response(null, { status: 401, headers: relayHeaders });
    requireRelayEnabled();
    // The callback secret is checked before reading even this small body.
    if (!equalRelaySecret(new URL(request.url).searchParams.get('callback') || '')) return deny();
    const input = await parseBody(request, Schema, 8192);
    // Control authentication is local signature work; it must not wait behind
    // publish DB locks while the reconciler is trying to close a publisher.
    if (input.action === 'api') return new Response(null, { status: validRelayControlToken(input.token) ? 204 : 401, headers: relayHeaders });
    return admittedRelay(request, async () => {
      const id = input.path.startsWith('relay/') ? input.path.slice(6) : '';
      if (!relayIdPattern.test(id)) return deny();
      if (['publish', 'read'].includes(input.action) && input.protocol === 'webrtc' && input.id) {
        await authorizeRelaySignal(input.token, id, input.action, input.id);
        return new Response(null, { status: 204, headers: relayHeaders });
      }
      return deny();
    });
  } catch (error) { return relayFailure(error); }
}
