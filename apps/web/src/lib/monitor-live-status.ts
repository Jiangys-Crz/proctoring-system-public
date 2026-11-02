import { mediaApiToken } from './media-api-auth';
import { liveChannels, mediaStreamPath } from './media-read-token';

type Snapshot = { available: boolean; paths: Set<string> };
type Session = { id: string; status: string };

// MediaMTX v3 paths/list provides ready + bytesReceived and explicit pagination:
// https://github.com/bluenviron/mediamtx/blob/v1.15.4/api/openapi.yaml
// Cache only stream presence, never viewer authorization. Every caller filters
// the snapshot against its freshly authorized sessions, including cache hits.
export function createMonitorLiveStatusLoader(options: {
  fetch: typeof fetch;
  now?: () => number;
  base: () => string;
  token: () => string;
}) {
  const now = options.now || Date.now;
  let cache: { key: string; expires: number; value?: Snapshot; pending?: Promise<Snapshot> } | undefined;

  async function read(base: string, token: string): Promise<Snapshot> {
    const paths = new Set<string>();
    const signal = AbortSignal.timeout(750);
    try {
      for (let page = 0; page < 20; page++) {
        const response = await options.fetch(`${base}/v3/paths/list?itemsPerPage=500&page=${page}`, {
          headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal,
        });
        if (!response.ok) throw new Error('Media status unavailable');
        const body = await response.json();
        if (!Array.isArray(body.items) || !Number.isInteger(body.pageCount) || body.pageCount < 0 || body.pageCount > 20) {
          throw new Error('Invalid media status');
        }
        for (const item of body.items) {
          if (item && typeof item.name === 'string' && item.ready === true && Number(item.bytesReceived) > 0) paths.add(item.name);
        }
        if (page + 1 >= body.pageCount) return { available: true, paths };
      }
    } catch { /* Sorting must never prevent opening the monitor during a media outage. */ }
    return { available: false, paths: new Set() };
  }

  return async (sessions: readonly Session[]) => {
    const active = sessions.filter(session => session.status !== 'FINISHED' && /^[A-Za-z0-9_-]{1,128}$/.test(session.id));
    if (!active.length) return { liveStatusAvailable: true, liveReadySessionIds: [] as string[] };
    let snapshot: Snapshot;
    try {
      const base = options.base().replace(/\/$/, '');
      const token = options.token();
      const key = `${base}:${token}`;
      if (cache?.key !== key) cache = { key, expires: 0 };
      const entry = cache;
      if (entry.value && entry.expires > now()) snapshot = entry.value;
      else {
        if (!entry.pending) entry.pending = read(base, token).then(value => {
          entry.value = value;
          entry.expires = now() + (value.available ? 2000 : 1000);
          entry.pending = undefined;
          return value;
        });
        snapshot = await entry.pending;
      }
    } catch { snapshot = { available: false, paths: new Set() }; }
    return {
      liveStatusAvailable: snapshot.available,
      liveReadySessionIds: active.filter(session => liveChannels.some(channel => snapshot.paths.has(mediaStreamPath(session.id, channel).slice(1)))).map(session => session.id),
    };
  };
}

export const monitorLiveStatus = createMonitorLiveStatusLoader({
  fetch: (...args) => fetch(...args),
  base: () => process.env.MEDIA_API_INTERNAL_BASE || 'http://127.0.0.1:9997',
  token: mediaApiToken,
});
