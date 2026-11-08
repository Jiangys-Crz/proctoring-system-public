import { z } from 'zod';
import { AuthError } from './auth';
import { relayEnabled } from './live-relay-token';
import { mediaApiToken } from './media-api-auth';

const PathSchema = z.object({ name: z.string().max(128), ready: z.boolean().optional(), available: z.boolean().optional(), online: z.boolean().optional(), onlineTime: z.string().nullable().optional(), readyTime: z.string().nullable().optional(),
  source: z.object({ type: z.string(), id: z.string() }).nullable().optional(),
  tracks: z.array(z.unknown()).max(32).optional(), readers: z.array(z.object({ type: z.string(), id: z.string() })).max(256).optional(), bytesReceived: z.number().optional(), bytesSent: z.number().optional() });
export type RelayMediaPath = z.infer<typeof PathSchema>;
const SessionSchema = z.object({ id: z.string().uuid() });
export type RelayMediaProtocol = 'webrtc' | 'rtmp' | 'rtmps';
const endpoints = { webrtc: 'webrtcsessions', rtmp: 'rtmp/conns', rtmps: 'rtmps/conns' } as const;
const maxPages = 64;
const state = globalThis as typeof globalThis & { relayPaths?: { until: number; rows: RelayMediaPath[] }; relayPathsTask?: Promise<RelayMediaPath[]> };
async function mediaRequest(path: string, method = 'GET') {
  if (!/^\/v3\/(?:(?:paths|webrtcsessions|rtmps?\/conns)\/list\?page=\d+&itemsPerPage=100|(?:webrtcsessions|rtmps?\/conns)\/(?:get|kick)\/[a-f0-9-]{36})$/i.test(path)) throw new AuthError('直播管理请求无效', 400);
  const base = new URL(process.env.MEDIA_API_INTERNAL_BASE || 'http://127.0.0.1:9997');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/') throw new AuthError('直播内部服务配置无效', 503);
  const response = await fetch(base.origin + path, { method, redirect: 'error', cache: 'no-store',
    headers: { authorization: `Bearer ${mediaApiToken()}` }, signal: AbortSignal.timeout(3000) });
  if (response.status === 404 && method === 'GET') { await response.body?.cancel(); throw new AuthError('媒体连接不存在', 404); }
  if (!response.ok && !(method === 'POST' && response.status === 404)) { await response.body?.cancel(); throw new AuthError('直播媒体服务暂不可用', 503); }
  if (method === 'POST') { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader(); if (!reader) throw new AuthError('直播媒体服务响应无效', 502);
  let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > 1024 * 1024) { await reader.cancel(); throw new AuthError('直播媒体服务响应过大', 502); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
}
export async function readRelayPaths(force = false) {
  if (!relayEnabled()) return [];
  if (!force && state.relayPaths && state.relayPaths.until > Date.now()) return state.relayPaths.rows;
  if (state.relayPathsTask) return state.relayPathsTask;
  const task = (async () => {
    const rows: RelayMediaPath[] = [];
    // Shared media also contains exam paths. Filter each bounded page before
    // retaining it, and fail closed if inventory cannot complete in time.
    const deadline = Date.now() + 10000;
    for (let page = 0; page < maxPages; page++) {
      if (Date.now() > deadline) throw new AuthError('媒体状态读取超时，请稍后重试', 503);
      const response = z.object({ items: z.array(z.unknown()).max(100), pageCount: z.number().int().min(0).max(maxPages) }).parse(await mediaRequest(`/v3/paths/list?page=${page}&itemsPerPage=100`));
      for (const item of response.items) {
        const name = typeof item === 'object' && item && 'name' in item ? item.name : null;
        if (typeof name === 'string' && /^relay\/[A-Za-z0-9_-]{1,64}$/.test(name)) rows.push(PathSchema.parse(item));
      }
      if (page + 1 >= response.pageCount) break;
    }
    state.relayPaths = { until: Date.now() + 2000, rows }; return rows;
  })().finally(() => { if (state.relayPathsTask === task) delete state.relayPathsTask; });
  state.relayPathsTask = task; return task;
}
export async function kickRelayPath(path: RelayMediaPath) {
  if (!/^relay\/[A-Za-z0-9_-]{1,64}$/.test(path.name)) throw new AuthError('不是直播转发路径', 400);
  for (const item of [path.source, ...(path.readers ?? [])]) {
    const protocol = item?.type === 'webRTCSession' ? 'webrtc' : item?.type === 'rtmpConn' ? 'rtmp' : item?.type === 'rtmpsConn' ? 'rtmps' : null;
    if (protocol && item && /^[a-f0-9-]{36}$/i.test(item.id)) await kickRelayMediaConnection(protocol, item.id);
  }
  delete state.relayPaths;
}
// A negotiated publisher exists before it has produced its first track/path.
// Query the actual sessions rather than inferring their existence from paths.
export async function readRelayConnectionIds(protocols: RelayMediaProtocol[]) {
  const ids = new Set<string>();
  const deadline = Date.now() + 10000;
  for (const protocol of new Set(protocols)) {
    for (let page = 0; page < maxPages; page++) {
      if (Date.now() > deadline) throw new AuthError('媒体连接核对超时，请稍后重试', 503);
      const response = z.object({ items: z.array(SessionSchema).max(100), pageCount: z.number().int().min(0).max(maxPages) })
        .parse(await mediaRequest(`/v3/${endpoints[protocol]}/list?page=${page}&itemsPerPage=100`));
      for (const session of response.items) ids.add(`${protocol}:${session.id}`);
      if (page + 1 >= response.pageCount) break;
    }
  }
  return ids;
}
export async function relayRtmpConnectionProtocol(id: string, expectedPath: string): Promise<RelayMediaProtocol> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new AuthError('RTMP 连接编号无效', 400);
  let unavailable: unknown;
  for (const protocol of ['rtmp', 'rtmps'] as const) {
    try {
      const data = SessionSchema.extend({ path: z.string().optional() }).parse(await mediaRequest(`/v3/${endpoints[protocol]}/get/${id}`));
      if (data.path && data.path !== expectedPath) throw new AuthError('RTMP 连接不属于此直播', 403);
      if (data.id === id) return protocol;
    } catch (error) {
      if (error instanceof AuthError && error.status === 403) throw error;
      if (!(error instanceof AuthError && error.status === 404)) unavailable = error;
    }
  }
  if (unavailable) throw unavailable;
  throw new AuthError('RTMP 连接不存在', 401);
}
export async function kickRelayMediaConnection(protocol: RelayMediaProtocol, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new AuthError('直播连接编号无效', 400);
  await mediaRequest(`/v3/${endpoints[protocol]}/kick/${id}`, 'POST');
  delete state.relayPaths;
}
