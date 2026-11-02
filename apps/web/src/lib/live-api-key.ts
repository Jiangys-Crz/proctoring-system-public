import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db';
import { AuthError } from './auth';

export const LiveKeyCreateSchema = z.object({ name: z.string().trim().min(1).max(100), enabled: z.boolean().default(true) });
export const LiveKeyUpdateSchema = z.object({ id: z.string().min(1).max(128), name: z.string().trim().min(1).max(100).optional(), enabled: z.boolean().optional() })
  .refine(value => value.name !== undefined || value.enabled !== undefined, '请填写名称或启用状态');
export const liveKeyPublicSelect = { id: true, name: true, keyPrefix: true, enabled: true, createdAt: true, updatedAt: true } as const;

export function generateLiveApiKey() { return 'live_' + randomBytes(32).toString('base64url'); }
export function liveApiKeyHash(key: string) { return createHash('sha256').update(key).digest('hex'); }
export function validLiveApiKey(key: string) { return /^live_[A-Za-z0-9_-]{43}$/.test(key); }

export async function authorizeLiveApiKey(key: string) {
  if (!validLiveApiKey(key)) throw new AuthError('直播 API Key 无效或已停用', 401);
  // Never cache a completed permission decision: disabling applies to the next part.
  const record = await prisma.liveApiKey.findUnique({ where: { keyHash: liveApiKeyHash(key) }, select: { id: true, enabled: true } });
  if (!record?.enabled) throw new AuthError('直播 API Key 无效或已停用', 401);
  return record.id;
}

export function assertLiveKeyRequestOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const allowed = [new URL(request.url).origin];
  if (process.env.APP_BASE_URL) allowed.push(new URL(process.env.APP_BASE_URL).origin);
  if (origin && !allowed.includes(origin)) throw new AuthError('请求来源无效', 403);
}
