import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { mediaApiToken } from './media-api-auth';
import { liveChannels, mediaStreamPath, type LiveChannel } from './media-read-token';

// The path APIs describe already attached readers and sources. WebRTC's
// session list also includes peers still waiting for ICE or the first track.
const protocols = {
  webRTCSession: 'webrtc/sessions',
  hlsSession: 'hls/sessions',
  rtmpConn: 'rtmp/conns',
  rtmpsConn: 'rtmps/conns',
} as const;
type Protocol = keyof typeof protocols;
type Connection = { type: Protocol; id: string };
const connection = z.object({ type: z.string(), id: z.string() });
const sessionRow = z.object({ path: z.string(), id: z.string() });
const pathRow = z.object({
  name: z.string(),
  source: connection.nullish(),
  readers: z.array(connection).nullish(),
});
const pageSize = 250;
const maxPages = 40;
const pageShape = z.object({ items: z.array(z.unknown()).max(pageSize).nullable(), pageCount: z.number().int().min(0).max(maxPages) });
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function mediaPage(response: Response) {
  // Keep the shared media node from returning unbounded data to a session
  // mutation. Responses can contain signaling credentials; retain only IDs.
  const body = response.body?.getReader();
  if (!body) throw new Error('媒体服务未返回连接列表');
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await body.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error('媒体服务连接列表过大');
      parts.push(value);
    }
  } finally {
    await body.cancel().catch(() => {});
    body.releaseLock();
  }
  return pageShape.parse(JSON.parse(Buffer.concat(parts, bytes).toString('utf8')));
}

export function createSessionLiveMediaStopper(options: { fetch: typeof fetch; base: () => string; token: () => string }) {
  return async function stop(paths: ReadonlySet<string>) {
    if (!paths.size) return;
    const base = new URL(options.base());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new Error('媒体管理地址无效');
    }
    // Both inventory and teardown share one deadline. Desktop reattachment
    // waits for this operation before issuing replacement credentials.
    const signal = AbortSignal.timeout(5000);
    const token = options.token();
    const request = (path: string, method = 'GET') => options.fetch(base.origin + path, {
      method, signal, redirect: 'error', cache: 'no-store', headers: { authorization: `Bearer ${token}` },
    });
    async function list(endpoint: string, accept: (item: unknown) => void, optional = false) {
      for (let page = 0; page < maxPages; page++) {
        const response = await request(`/v3/${endpoint}/list?itemsPerPage=${pageSize}&page=${page}`);
        if (!response.ok) {
          await response.body?.cancel();
          if (page === 0 && optional && response.status === 404) return;
          throw new Error('媒体服务无法列出监控连接');
        }
        const parsed = await mediaPage(response);
        for (const item of parsed.items ?? []) accept(item);
        if (page + 1 >= parsed.pageCount) return;
      }
    }
    const targets = new Map<string, Connection>();
    function add(type: string, id: string) {
      if (!Object.hasOwn(protocols, type)) return;
      if (!uuid.test(id)) throw new Error('媒体服务返回无效的监控连接编号');
      const key = type as Protocol;
      targets.set(`${key}:${id.toLowerCase()}`, { type: key, id });
    }
    const results = await Promise.allSettled([
      list('paths', item => {
        if (!item || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string' || !paths.has(item.name)) return;
        const path = pathRow.parse(item);
        if (path.source) add(path.source.type, path.source.id);
        for (const reader of path.readers ?? []) add(reader.type, reader.id);
      }),
      ...Object.entries(protocols).map(([protocol, endpoint]) => list(endpoint, item => {
        if (!item || typeof item !== 'object' || !('path' in item) || typeof item.path !== 'string' || !paths.has(item.path)) return;
        add(protocol, sessionRow.parse(item).id);
      }, true)),
    ]);
    let failure = results.find(result => result.status === 'rejected')?.reason as unknown;
    const connections = [...targets.values()];
    for (let offset = 0; offset < connections.length; offset += 16) {
      const closed = await Promise.allSettled(connections.slice(offset, offset + 16).map(async ({ type, id }) => {
        const response = await request(`/v3/${protocols[type]}/kick/${id}`, 'POST');
        await response.body?.cancel();
        if (!response.ok && response.status !== 404) throw new Error('媒体服务拒绝断开监控连接');
      }));
      failure ??= closed.find(result => result.status === 'rejected')?.reason;
    }
    if (failure) throw failure;
  };
}

const stopStreams = createSessionLiveMediaStopper({
  fetch: (...args) => fetch(...args),
  base: () => process.env.MEDIA_API_INTERNAL_BASE || 'http://127.0.0.1:9997',
  token: mediaApiToken,
});

/** Stop only the exact session's camera/screen streams; do not touch voice,
 * relays, or another user's stream, even if it has a similar path. */
export async function stopSessionLiveMedia(sessionIds: readonly string[], channels: readonly LiveChannel[] = liveChannels,
  db: Pick<Prisma.TransactionClient, 'liveWebRtcConnection' | 'contestLiveConnection'> = prisma) {
  const ids = [...new Set(sessionIds)];
  const paths = new Set(ids.flatMap(id => channels.map(channel => mediaStreamPath(id, channel).slice(1))));
  if (!paths.size) return;
  await stopStreams(paths);
  const where = { sessionId: { in: ids }, channel: { in: [...channels] } };
  await Promise.all([
    db.liveWebRtcConnection.deleteMany({ where }),
    db.contestLiveConnection.deleteMany({ where }),
  ]);
}
