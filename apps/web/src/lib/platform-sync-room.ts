import type { Prisma } from '@prisma/client';
import { digest } from './exam-federation-protocol';

const pendingKey = (candidateKey: string) => `platform-room-await:${digest(candidateKey)}`;

/** A replicated candidate initially has an unknown room, not an intentional null assignment. */
export async function awaitRoomAssignment(tx: Prisma.TransactionClient, candidateKey: string) {
  const key = pendingKey(candidateKey);
  await tx.systemSetting.upsert({ where: { key }, create: { key, value: { candidateKey } }, update: {} });
}
export async function roomAssignmentPending(tx: Prisma.TransactionClient, candidateKey: string) {
  return Boolean(await tx.systemSetting.findUnique({ where: { key: pendingKey(candidateKey) }, select: { key: true } }));
}
/** Called by a received assignment or an explicit local room mutation, in its transaction. */
export async function clearRoomAssignmentPending(tx: Prisma.TransactionClient, keys: Array<string | null>) {
  const names = keys.filter((key): key is string => Boolean(key)).map(pendingKey);
  if (names.length) await tx.systemSetting.deleteMany({ where: { key: { in: names } } });
}
