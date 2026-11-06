import { z } from 'zod';
import { AuthError } from './auth';
import { relayControlToken, relayEnabled } from './live-relay-token';

const PathSchema = z.object({ name: z.string().max(128), ready: z.boolean().optional(), available: z.boolean().optional(), online: z.boolean().optional(), onlineTime: z.string().nullable().optional(), readyTime: z.string().nullable().optional(),
  source: z.object({ type: z.string(), id: z.string() }).nullable().optional(),
  tracks: z.array(z.unknown()).max(32).optional(), readers: z.array(z.object({ type: z.string(), id: z.string() })).max(256).optional(), bytesReceived: z.number().optional(), bytesSent: z.number().optional() });
export type RelayMediaPath = z.infer<typeof PathSchema>;
const state = globalThis as typeof globalThis & { relayPaths?: { until: number; rows: RelayMediaPath[] }; relayPathsTask?: Promise<RelayMediaPath[]> };
async function mediaRequest(path: string, method = 'GET') {
  if (!/^\/v3\/(?:paths\/list\?page=\d+&itemsPerPage=100|webrtcsessions\/kick\/[a-f0-9-]{36}|rtmp\/conns\/kick\/[a-f0-9-]{36})$/i.test(path)) throw new AuthError('直播管理请求无效', 400);
  const base = new URL(process.env.LIVE_RELAY_API_INTERNAL_BASE || 'http://127.0.0.1:9998');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/') throw new AuthError('直播内部服务配置无效', 503);
  const response = await fetch(base.origin + path, { method, redirect: 'error', cache: 'no-store',
    headers: { authorization: `Bearer ${relayControlToken()}` }, signal: AbortSignal.timeout(3000) });
  if (!response.ok && !(method === 'POST' && response.status === 404)) throw new AuthError('独立直播媒体服务暂不可用', 503);
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
    // Configuration caps total registered streams; still bound unexpected API pagination.
    for (let page = 0; page < 5; page++) {
      const response = z.object({ items: z.array(PathSchema).max(100), pageCount: z.number().int().min(0).max(5) }).parse(await mediaRequest(`/v3/paths/list?page=${page}&itemsPerPage=100`));
      rows.push(...response.items.filter(path => /^relay\/[A-Za-z0-9_-]{1,64}$/.test(path.name)));
      if (page + 1 >= response.pageCount) break;
    }
    state.relayPaths = { until: Date.now() + 2000, rows }; return rows;
  })().finally(() => { if (state.relayPathsTask === task) delete state.relayPathsTask; });
  state.relayPathsTask = task; return task;
}
export async function kickRelayPath(path: RelayMediaPath) {
  if (path.source?.type === 'rtmpConn' && /^[a-f0-9-]{36}$/i.test(path.source.id)) await mediaRequest(`/v3/rtmp/conns/kick/${path.source.id}`, 'POST');
  const sessions = [path.source, ...(path.readers ?? [])].filter(item => item?.type === 'webRTCSession' && /^[a-f0-9-]{36}$/i.test(item.id));
  for (const session of sessions) await kickRelayWebRtc(session!.id);
  delete state.relayPaths;
}
export async function kickRelayWebRtc(id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new AuthError('直播连接编号无效', 400);
  await mediaRequest(`/v3/webrtcsessions/kick/${id}`, 'POST');
  delete state.relayPaths;
}
