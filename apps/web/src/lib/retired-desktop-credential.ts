import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { clientSessionTokenFromRequest, hashClientSessionToken } from './client-auth';

type Store = Pick<Prisma.TransactionClient, 'systemSetting'>;

function retirementKey(sessionId: string, tokenHash: string) {
  return 'client.desktop-retirement.' + createHash('sha256').update(JSON.stringify([sessionId, tokenHash])).digest('hex');
}

/** Durable, logout-only proof survives a server restart and device rebind.
 * It never authorizes exam data, heartbeat writes or a new login. */
export async function retireDesktopCredential(store: Store, session: { id: string; desktopTokenHash: string | null }) {
  if (!session.desktopTokenHash) return;
  const key = retirementKey(session.id, session.desktopTokenHash);
  const value = { sessionId: session.id, retiredAt: new Date().toISOString() };
  await store.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function isRetiredDesktopCredential(store: Store, request: Request, sessionId: string) {
  const token = clientSessionTokenFromRequest(request);
  if (!token || token.length > 8192) return false;
  const row = await store.systemSetting.findUnique({ where: { key: retirementKey(sessionId, hashClientSessionToken(token)) }, select: { value: true } });
  const value = row?.value;
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.sessionId === sessionId);
}
