import { mediaStreamPath, liveChannels } from './media-read-token';
import { mediaApiToken } from './media-api-auth';

export async function testMediaState(sessionId: string) {
  const base = (process.env.MEDIA_API_INTERNAL_BASE || 'http://127.0.0.1:9997').replace(/\/$/, '');
  const channels = await Promise.all(liveChannels.map(async channel => {
    try {
      const response = await fetch(`${base}/v3/paths/get/${mediaStreamPath(sessionId, channel).slice(1)}`, { headers: { authorization: `Bearer ${mediaApiToken()}` }, cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (response.status === 404) return { channel, available: true, ready: false };
      if (!response.ok) throw new Error('Media status unavailable');
      const body = await response.json();
      // A ready path plus received bytes confirms the media server has actually received the stream.
      return { channel, available: true, ready: body.ready === true && Number(body.bytesReceived) > 0 };
    } catch { return { channel, available: false, ready: false }; }
  }));
  return channels;
}
