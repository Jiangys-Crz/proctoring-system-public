import { prisma } from './db';
import { mediaApiToken } from './media-api-auth';
import { mediaStreamPath } from './media-read-token';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function liveWebRtcResource(location: string, base: string, streamPath: string) {
  const url = new URL(location, base);
  const prefix = `${streamPath}/whep/`;
  const id = url.pathname.slice(prefix.length);
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith(prefix) || !uuid.test(id) || url.search || url.hash || url.username || url.password) throw new Error('媒体服务返回无效直播资源');
  return id;
}
export async function kickLiveWebRtc(id: string) {
  if (!uuid.test(id)) throw new Error('无效直播连接');
  const base = (process.env.MEDIA_API_INTERNAL_BASE || 'http://127.0.0.1:9997').replace(/\/$/, '');
  const response = await fetch(`${base}/v3/webrtcsessions/kick/${id}`, { method: 'POST', headers: { authorization: `Bearer ${mediaApiToken()}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok && response.status !== 404) throw new Error('直播连接断开失败，请重试停用密钥');
}
export async function stopLiveWebRtcConnections(keyId: string) {
  const rows = await prisma.liveWebRtcConnection.findMany({ where: { keyId }, select: { id: true, sessionId: true, channel: true } });
  for (let offset = 0; offset < rows.length; offset += 4) {
    const results = await Promise.allSettled(rows.slice(offset, offset + 4).map(async row => {
      await deleteLiveWebRtcResource(row.id, row.sessionId, row.channel);
      await prisma.liveWebRtcConnection.deleteMany({ where: { id: row.id, keyId } });
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
/** Existing records store the WHEP resource secret, not the control API id.
 * DELETE that exact reader resource; never disconnect the exam publisher. */
export async function deleteLiveWebRtcResource(secret: string, sessionId: string, channel: string) {
  if (!uuid.test(secret)) throw new Error('无效直播连接');
  const base = (process.env.MEDIA_WHIP_INTERNAL_BASE || 'http://127.0.0.1:8889').replace(/\/$/, '');
  const response = await fetch(`${base}${mediaStreamPath(sessionId, channel)}/whep/${secret}`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(8000) });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new Error('直播连接断开失败，请重试停用密钥');
}
