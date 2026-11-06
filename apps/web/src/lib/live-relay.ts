import { z } from 'zod';
import { AuthError } from './auth';
import { prisma } from './db';
import { authorizeLiveApiKey } from './live-api-key';
import { kickRelayPath, readRelayPaths } from './live-relay-media';
import { reconcileRelayConnections } from './live-relay-connections';
import { createRelayTicket, relayEnabled, relayIdPattern, relayStreamLimit, requireRelayEnabled, verifyRelayTicket } from './live-relay-token';

export const RelayPatchSchema = z.object({ kind: z.literal('stream'), id: z.string().regex(relayIdPattern), enabled: z.boolean().optional(), archived: z.literal(true).optional(), name: z.string().trim().min(1).max(100).optional() })
  .refine(value => value.enabled !== undefined || value.archived || value.name !== undefined);
export const RelayStreamCreateSchema = z.object({ id: z.string().regex(relayIdPattern, '流 ID 只能包含字母、数字、下划线和连字符，最长 64 字符'), name: z.string().trim().min(1).max(100).optional() });
export async function createRelayStream(input: z.infer<typeof RelayStreamCreateSchema>) {
  requireRelayEnabled();
  await prisma.$transaction(async tx => {
    const capacityKey = 'live-relay-capacity-v1';
    await tx.systemSetting.upsert({ where: { key: capacityKey }, create: { key: capacityKey, value: {} }, update: {} });
    await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${capacityKey} FOR UPDATE`;
    if (await tx.liveRelayStream.findUnique({ where: { id: input.id }, select: { id: true } })) throw new AuthError('流 ID 已存在或曾被归档，请使用新 ID（大小写也不能重复）', 409);
    if (await tx.liveRelayStream.count({ where: { archived: false } }) >= relayStreamLimit()) throw new AuthError('直播数量已达上限，请先归档不再使用的流 ID', 429);
    await tx.liveRelayStream.create({ data: { id: input.id, name: input.name || input.id } });
  }, { isolationLevel: 'ReadCommitted', maxWait: 2000, timeout: 5000 });
}
export async function relayStreamForKey(id: string, key: string) {
  requireRelayEnabled();
  if (!relayIdPattern.test(id)) throw new AuthError('直播编号无效', 400);
  const keyId = await authorizeLiveApiKey(key);
  const stream = await prisma.liveRelayStream.findFirst({ where: { id, enabled: true, archived: false }, select: { id: true } });
  if (!stream || stream.id !== id) throw new AuthError('请先在后台创建此流 ID，并核对启用状态和大小写', 404);
  return { id: stream.id, keyId };
}
export async function authorizeRelayTicket(id: string, ticket: string) {
  requireRelayEnabled();
  const claims = verifyRelayTicket(ticket, id);
  if (!claims) throw new AuthError('直播播放授权无效或已过期', 401);
  const key = await prisma.liveApiKey.findUnique({ where: { id: claims.keyId }, select: { enabled: true } });
  const stream = await prisma.liveRelayStream.findFirst({ where: { id, enabled: true, archived: false }, select: { id: true } });
  if (!key?.enabled || !stream || stream.id !== id) throw new AuthError('直播或密钥已停用，或编号大小写不一致', 403);
  if (claims.adminId) {
    const user = await prisma.user.findUnique({ where: { id: claims.adminId }, select: { status: true, role: true } });
    if (user?.status !== 'ACTIVE' || user.role !== 'SUPER_ADMIN') throw new AuthError('管理授权已失效', 403);
  }
  return claims;
}
// Kept for authenticated integrations; the management page does not open video.
export async function relayPreviewTicket(id: string, adminId: string) {
  const key = await prisma.liveApiKey.findFirst({ where: { enabled: true }, select: { id: true } });
  const stream = await prisma.liveRelayStream.findFirst({ where: { id, enabled: true, archived: false }, select: { id: true } });
  if (!key || !stream || stream.id !== id) throw new AuthError('请先启用系统直播密钥并使用原编号推流', 404);
  return createRelayTicket(id, key.id, adminId);
}
export async function liveRelayState() {
  const registered = await prisma.liveRelayStream.findMany({ where: { archived: false }, select: { id: true, name: true, enabled: true }, orderBy: { createdAt: 'desc' }, take: 256 });
  let mediaError = '';
  const paths = relayEnabled() ? await readRelayPaths().catch(() => { mediaError = '独立直播媒体服务暂不可用'; return []; }) : [];
  const active = new Set(paths.filter(p => p.available ?? p.ready ?? p.online).map(p => p.name.slice(6)));
  const streams = registered.map(s => ({ ...s, online: active.has(s.id) }));
  return { configured: relayEnabled(), onlineCount: streams.filter(s => s.online).length, registrationLimit: relayStreamLimit(), mediaError, streams };
}
export async function updateRelay(input: z.infer<typeof RelayPatchSchema>) {
  await prisma.liveRelayStream.update({ where: { id: input.id }, data: { ...(input.archived ? { archived: true, enabled: false } : {}),
    ...(input.enabled !== undefined && !input.archived ? { enabled: input.enabled } : {}), ...(input.name ? { name: input.name } : {}) } });
  if (input.archived || input.enabled === false) await enforceRelayAccess();
}
const worker = globalThis as typeof globalThis & { relayAccessTimer?: ReturnType<typeof setInterval>; relayAccessTask?: Promise<void> };
export function enforceRelayAccess() {
  if (worker.relayAccessTask) return worker.relayAccessTask;
  const task = (async () => {
    if (!relayEnabled()) return;
    const paths = await readRelayPaths(true);
    const allowed = await prisma.liveRelayStream.findMany({ where: { enabled: true, archived: false }, select: { id: true }, take: 256 });
    const ids = new Set(allowed.map(s => s.id));
    const rejected = paths.filter(p => !ids.has(p.name.slice(6)));
    const active = new Set(paths.flatMap(p => [p.source, ...(p.readers || [])]).filter(x => x?.type === 'webRTCSession').map(x => x!.id));
    const results = await Promise.allSettled([reconcileRelayConnections(active), ...rejected.map(kickRelayPath)]);
    if (results.some(r => r.status === 'rejected')) throw new AuthError('断开部分直播连接失败，后台将继续重试', 503);
  })().finally(() => { if (worker.relayAccessTask === task) delete worker.relayAccessTask; });
  worker.relayAccessTask = task; return task;
}
export function startLiveRelayWorker() {
  if (!relayEnabled() || worker.relayAccessTimer) return;
  worker.relayAccessTimer = setInterval(() => { void enforceRelayAccess().catch(() => console.error('Independent live relay access reconciliation unavailable')); }, 5000);
  worker.relayAccessTimer.unref();
}
