import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { digest, FederationError } from './exam-federation-protocol';
import { comparePlatformVersion, PlatformItemSchema, type PlatformItem } from './platform-sync-protocol';
import { assertPlatformLease } from './platform-sync-lock';

export const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v)) as Record<string, Prisma.InputJsonValue | null>;
export const itemHash = (payload: unknown, deleted = false) => digest({ payload, deleted });
export async function appendItem(tx: Prisma.TransactionClient, input: Omit<PlatformItem, 'hash'> & { hash?: string }, localId: string | null, appliedHash?: string) {
  await assertPlatformLease(tx);
  const previous = await tx.platformSyncItem.findUnique({ where: { id: input.id } });
  if (previous && (previous.scope !== input.scope || previous.kind !== input.kind || (previous.localId && localId && previous.localId !== localId && !(previous.kind === 'BANK' && previous.deleted)))) throw new FederationError('同步标识已绑定其他记录，不能覆盖');
  const hash = itemHash(input.payload, input.deleted);
  if (previous) {
    const version = comparePlatformVersion(previous, input);
    if (version > 0) throw new FederationError('资料版本已更新，不能写回旧版本');
    if (!version) {
      if (previous.hash !== hash) throw new FederationError('同一同步版本包含不同内容，已停止覆盖');
      return previous;
    }
  }
  const state = await tx.platformSyncState.upsert({ where: { id: 'peer' }, create: { id: 'peer', sequence: 1 }, update: { sequence: { increment: 1 } } });
  const data = { ...input, hash, payload: input.payload as Prisma.InputJsonValue, localId,
    appliedHash: appliedHash ?? hash, sequence: state.sequence };
  return tx.platformSyncItem.upsert({ where: { id: input.id }, create: data, update: data });
}
export async function captureItem(tx: Prisma.TransactionClient, nodeId: string, scope: string, kind: PlatformItem['kind'], localId: string, payload: Record<string, unknown>, preferredId?: string) {
  const byLocal = await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope, kind, localId } } });
  const old = byLocal || (preferredId ? await tx.platformSyncItem.findUnique({ where: { id: preferredId } }) : null);
  if (old && (old.scope !== scope || old.kind !== kind || (old.localId && old.localId !== localId))) throw new FederationError('同步身份已经绑定其他本地记录');
  const hash = itemHash(payload);
  // Retained history rows (including soft deletes) must never revive a remote tombstone.
  if (old?.deleted) return old;
  if (old && !old.deleted && old.appliedHash === hash) return old;
  return appendItem(tx, { id: old?.id ?? preferredId ?? randomUUID(), scope, kind, payload, deleted: false, revision: (old?.revision ?? 0) + 1, writer: nodeId }, localId);
}
export async function captureDeletions(tx: Prisma.TransactionClient, nodeId: string, scope: string, kind: PlatformItem['kind'], existing: Set<string>, prefix?: string, target?: string) {
  let after: string | undefined, deleted = 0, bytes = 0;
  for (;;) {
    // Photos and code reports can contain megabytes per payload. Scan identities
    // first; only a genuinely missing row needs its complete previous snapshot.
    const rows = await tx.platformSyncItem.findMany({ where: { scope, kind, deleted: false, ...(after ? { id: { gt: after } } : {}), ...(target ? { localId: target } : prefix ? { localId: { startsWith: prefix } } : {}) },
      select: { id: true, localId: true }, orderBy: { id: 'asc' }, take: 256 });
    for (const row of rows) if (row.localId && !existing.has(row.localId)) {
      const old = await tx.platformSyncItem.findUniqueOrThrow({ where: { id: row.id } });
      const size = Buffer.byteLength(JSON.stringify(old.payload));
      if (deleted && (deleted >= 32 || bytes + size > 16 * 1024 * 1024)) return;
      bytes += size; deleted++;
      await appendItem(tx, { ...wireItem(old), revision: old.revision + 1, writer: nodeId, deleted: true }, old.localId);
    }
    if (rows.length < 256) break;
    after = rows[rows.length - 1].id;
  }
}
export function wireItem(row: { id: string; scope: string; kind: string; revision: number; writer: string; deleted: boolean; hash: string; payload: unknown }): PlatformItem {
  return PlatformItemSchema.parse(row);
}
export async function readPlatformPage(after: bigint, writer?: string) {
  return prisma.$transaction(async tx => {
  const state = await tx.platformSyncState.findUnique({ where: { id: 'peer' } });
  if (after > (state?.sequence ?? 0n)) throw new FederationError('同步进度超出本机历史，请检查数据库备份', 409);
  const rows = await tx.platformSyncItem.findMany({ where: { sequence: { gt: after, lte: state?.sequence ?? 0n }, ...(writer ? { writer: { not: writer } } : {}) }, select: { id: true, sequence: true }, orderBy: { sequence: 'asc' }, take: 32 });
  const entries: PlatformItem[] = []; let bytes = 0, cursor = after;
  for (const row of rows) {
    // A page of 32 photos can exceed hundreds of MB even when the wire page
    // is capped. Keep only the page's identities and read payloads on demand.
    const value = wireItem(await tx.platformSyncItem.findUniqueOrThrow({ where: { id: row.id } })), size = Buffer.byteLength(JSON.stringify(value));
    if (size > 16 * 1024 * 1024) throw new FederationError('单条同步资料过大', 413);
    if (bytes + size > 16 * 1024 * 1024 && entries.length) break;
    bytes += size; entries.push(value); cursor = row.sequence;
  }
  if (entries.length === rows.length && rows.length < 32) cursor = state?.sequence ?? cursor;
  return { after: cursor.toString(), entries };
  }, { isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 15_000 });
}
/** Keep the losing side of cross-node edits for recovery instead of silently discarding it. */
export async function retainPlatformConflict(tx: Prisma.TransactionClient, value: PlatformItem) {
  const key = `platform-conflict:${digest(value)}`;
  await tx.systemSetting.upsert({ where: { key }, create: { key, value: value as Prisma.InputJsonValue }, update: {} });
}
export async function acceptItem(tx: Prisma.TransactionClient, value: PlatformItem, apply: (oldLocalId: string | null) => Promise<{ localId: string | null; actual?: Record<string, unknown> }>) {
  await assertPlatformLease(tx);
  if (value.hash !== itemHash(value.payload, value.deleted)) throw new FederationError(`同步资料校验失败（${value.kind}）`, 400);
  const old = await tx.platformSyncItem.findUnique({ where: { id: value.id } });
  if (old && (old.scope !== value.scope || old.kind !== value.kind)) throw new FederationError('同步资料来源冲突');
  if (old) {
    const version = comparePlatformVersion(old, value);
    if (version > 0) { if (old.writer !== value.writer && old.hash !== value.hash) await retainPlatformConflict(tx, value); return; }
    if (!version) { if (old.hash !== value.hash) throw new FederationError('同一版本资料内容不同'); return; }
  }
  if (old && old.writer !== value.writer && old.hash !== value.hash) await retainPlatformConflict(tx, wireItem(old));
  const result = await apply(old?.localId ?? null);
  await appendItem(tx, value, result.localId, result.actual ? itemHash(result.actual, value.deleted) : undefined);
}
