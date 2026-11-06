import { randomUUID } from 'node:crypto';
import type { LiveRelayWebRtcConnection } from '@prisma/client';
import { AuthError } from './auth';
import { prisma } from './db';
import { kickRelayWebRtc } from './live-relay-media';
import { relayHash, relayStreamLimit, relayUuid, verifyRelaySignalToken } from './live-relay-token';
import { settleReads } from './request-admission';

export type RelayOwner = { keyId: string; credential: string; adminId?: string; expiresAt: Date };
export async function relayConnectionAllowed(row: Pick<LiveRelayWebRtcConnection, 'streamId' | 'keyId' | 'adminId' | 'expiresAt'>) {
  if (+row.expiresAt <= Date.now()) return false;
  const [stream, key] = await settleReads([
    prisma.liveRelayStream.findFirst({ where: { id: row.streamId, enabled: true, archived: false }, select: { id: true } }),
    prisma.liveApiKey.findUnique({ where: { id: row.keyId }, select: { enabled: true } }),
  ]);
  if (!stream || stream.id !== row.streamId || !key?.enabled) return false;
  if (row.adminId) {
    const admin = await prisma.user.findUnique({ where: { id: row.adminId }, select: { status: true, role: true } });
    if (admin?.status !== 'ACTIVE' || admin.role !== 'SUPER_ADMIN') return false;
  }
  return true;
}
export function relayViewerLimit() {
  const n = Number(process.env.LIVE_RELAY_MAX_CONNECTIONS || 16);
  return Number.isSafeInteger(n) ? Math.max(1, Math.min(128, n)) : 16;
}
export async function reserveRelayConnection(streamId: string, mode: 'publish' | 'read', owner: RelayOwner) {
  return prisma.$transaction(async tx => {
    const capacityKey = 'live-relay-capacity-v1';
    await tx.systemSetting.upsert({ where: { key: capacityKey }, create: { key: capacityKey, value: {} }, update: {} });
    await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${capacityKey} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM LiveApiKey WHERE id = ${owner.keyId} FOR UPDATE`;
    const stream = await tx.liveRelayStream.findFirst({ where: { id: streamId, enabled: true, archived: false }, select: { id: true } });
    const key = await tx.liveApiKey.findUnique({ where: { id: owner.keyId }, select: { enabled: true } });
    if (!stream || stream.id !== streamId || !key?.enabled) throw new AuthError('直播或密钥已停用，或编号大小写不一致', 403);
    const where = { mode };
    const count = await tx.liveRelayWebRtcConnection.count({ where: mode === 'publish' ? { ...where, streamId } : where });
    if (count >= (mode === 'publish' ? 1 : relayViewerLimit())) throw new AuthError(mode === 'publish' ? '此直播已有推流连接，请先停止原推流或等待旧连接回收' : '直播观看连接已达上限', 429);
    if (mode === 'publish' && await tx.liveRelayWebRtcConnection.count({ where: { mode } }) >= relayStreamLimit()) throw new AuthError('推流连接已达上限', 429);
    return tx.liveRelayWebRtcConnection.create({ data: { id: randomUUID(), streamId, keyId: owner.keyId, mode,
      ownerHash: relayHash(owner.credential), adminId: owner.adminId, expiresAt: new Date(Date.now() + 30_000) } });
  }, { isolationLevel: 'ReadCommitted', maxWait: 2000, timeout: 5000 });
}
export async function stopRelayWebRtcConnections(keyId: string) {
  const rows = await prisma.liveRelayWebRtcConnection.findMany({ where: { keyId }, select: { id: true }, take: 256 });
  await closeConnections(rows.map(r => r.id));
}
async function closeConnections(ids: string[]) {
  let failed = false;
  for (let offset = 0; offset < ids.length; offset += 4) {
    const results = await Promise.allSettled(ids.slice(offset, offset + 4).map(closeRelayConnection));
    failed ||= results.some(r => r.status === 'rejected');
  }
  if (failed) throw new AuthError('部分直播连接等待后台重试断开', 503);
}
/** MediaMTX's authentication callback supplies the control API id. Its WHIP
 * Location contains a different secret, which must never be used for kicking. */
export async function authorizeRelaySignal(token: string, streamId: string, mode: string, mediaId: string) {
  const claims = verifyRelaySignalToken(token);
  if (!claims || claims.id !== streamId || claims.mode !== mode || !relayUuid.test(mediaId)) throw new AuthError('直播信令授权无效', 401);
  const row = await prisma.liveRelayWebRtcConnection.findUnique({ where: { id: claims.connectionId } });
  if (!row || row.streamId !== streamId || row.mode !== mode || !await relayConnectionAllowed(row)) throw new AuthError('直播连接授权已失效', 401);
  const changed = await prisma.liveRelayWebRtcConnection.updateMany({ where: { id: row.id, expiresAt: { gt: new Date() }, OR: [{ mediaId: null }, { mediaId }] }, data: { mediaId } });
  if (!changed.count) throw new AuthError('直播连接已被替换或回收', 401);
}
export async function closeRelayConnection(id: string) {
  // Make every late callback fail before attempting remote cleanup. Retain an
  // expired row on failure so the periodic worker can retry after a restart.
  await prisma.liveRelayWebRtcConnection.updateMany({ where: { id }, data: { expiresAt: new Date(0) } });
  const row = await prisma.liveRelayWebRtcConnection.findUnique({ where: { id } });
  if (row?.mediaId) await kickRelayWebRtc(row.mediaId);
  await prisma.liveRelayWebRtcConnection.deleteMany({ where: { id } });
}
export async function reconcileRelayConnections(activeMediaIds: Set<string>) {
  const rows = await prisma.liveRelayWebRtcConnection.findMany({ orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: 256 });
  if (!rows.length) return;
  const queries = await Promise.allSettled([
    prisma.liveRelayStream.findMany({ where: { id: { in: rows.map(r => r.streamId) }, enabled: true, archived: false }, select: { id: true } }),
    prisma.liveApiKey.findMany({ where: { id: { in: rows.map(r => r.keyId) }, enabled: true }, select: { id: true } }),
    prisma.user.findMany({ where: { id: { in: rows.flatMap(r => r.adminId ? [r.adminId] : []) }, status: 'ACTIVE', role: 'SUPER_ADMIN' }, select: { id: true } }),
  ]);
  if (queries.some(r => r.status === 'rejected')) throw new AuthError('暂时无法核对直播连接权限', 503);
  const [streams, keys, admins] = queries.map(r => new Set((r as PromiseFulfilledResult<{ id: string }[]>).value.map(v => v.id)));
  await closeConnections(rows.filter(row => +row.expiresAt <= Date.now() || !streams.has(row.streamId) || !keys.has(row.keyId) || row.adminId && !admins.has(row.adminId)
    || row.resourceSecret && row.mediaId && !activeMediaIds.has(row.mediaId) && +row.createdAt < Date.now() - 30_000).map(row => row.id));
}
