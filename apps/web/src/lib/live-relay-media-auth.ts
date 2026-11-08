import { z } from 'zod';
import { AuthError } from './auth';
import { authorizeRelaySignal, reserveRelayConnection } from './live-relay-connections';
import { relayRtmpConnectionProtocol } from './live-relay-media';
import { relayStreamForKey } from './live-relay';
import { relayIdPattern, requireRelayEnabled } from './live-relay-token';

export const RelayMediaAuthSchema = z.object({
  action: z.string().max(32), protocol: z.string().max(16).default(''), path: z.string().max(256).default(''),
  token: z.string().max(2048).default(''), query: z.string().max(4096).default(''), id: z.string().uuid().nullable().optional(),
});
export async function authorizeRelayMedia(input: z.infer<typeof RelayMediaAuthSchema>) {
  requireRelayEnabled();
  const id = input.path.startsWith('relay/') ? input.path.slice(6) : '';
  if (!relayIdPattern.test(id) || !input.id || !['publish', 'read'].includes(input.action)) throw new AuthError('直播媒体授权无效', 401);
  if (input.protocol === 'webrtc') {
    await authorizeRelaySignal(input.token, id, input.action, input.id);
    return;
  }
  if (input.protocol !== 'rtmp') throw new AuthError('直播协议不支持', 401);
  const query = new URLSearchParams(input.query), keys = query.getAll('apikey');
  if (keys.length > 1 || keys.length > 0 && input.token) throw new AuthError('请只提供一个直播 API-KEY', 401);
  const credential = keys[0] || input.token;
  const stream = await relayStreamForKey(id, credential);
  // A public caller cannot reserve capacity by forging a callback: the media
  // connection UUID must already exist in the private, authenticated API.
  const protocol = await relayRtmpConnectionProtocol(input.id, `relay/${id}`);
  await reserveRelayConnection(id, input.action as 'publish' | 'read', {
    keyId: stream.keyId, credential, expiresAt: new Date(Date.now() + 24 * 3600_000),
  }, { protocol, id: input.id });
}
