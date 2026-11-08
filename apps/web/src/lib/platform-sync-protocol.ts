import { z } from 'zod';
import { FederationError } from './exam-federation-protocol';
import { platformOrigin } from './platform-sync-settings';
export const PlatformItemSchema = z.object({ id: z.string().min(1).max(191), scope: z.string().min(1).max(64),
  kind: z.enum(['BANK', 'EXAM', 'PROBLEM', 'CANDIDATE', 'ROOM', 'ROOM_ASSIGNMENT', 'PRINT', 'CHEATING', 'RECEIPT', 'MESSAGE_RECEIPT', 'ADMINISTRATORS', 'ALERT', 'LOGIN', 'SESSION', 'PHOTO', 'SCREEN_GROUP', 'SCREEN_IMAGE', 'SCREEN_DISPLAY', 'CODE_JOB', 'CODE_SOURCE', 'CODE_PAIR']),
  revision: z.number().int().positive().max(2147483647), writer: z.string().uuid(), deleted: z.boolean(), hash: z.string().regex(/^[a-f0-9]{64}$/), payload: z.record(z.string(), z.unknown()) });
export type PlatformItem = z.infer<typeof PlatformItemSchema>;
export const PLATFORM_SYNC_PROTOCOL = 'platform-sync-v3' as const;
export const PlatformExchangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('hello'), nodeId: z.string().uuid(), peerId: z.string().uuid().optional() }),
  z.object({ action: z.literal('exchange'), nodeId: z.string().uuid(), peerId: z.string().uuid(), after: z.string().regex(/^\d{1,19}$/), entries: z.array(PlatformItemSchema).max(32) }),
  z.object({ action: z.literal('exam'), examCode: z.string().regex(/^[a-zA-Z0-9_-]{1,191}$/), after: z.string().regex(/^\d{1,19}$/).default('0'), snapshot: z.string().uuid().optional() }),
]);
export const PlatformReplySchema = z.object({ protocol: z.literal(PLATFORM_SYNC_PROTOCOL), nodeId: z.string().uuid(), after: z.string().regex(/^\d{1,19}$/), entries: z.array(PlatformItemSchema).max(32), snapshot: z.string().uuid().optional(), definition: PlatformItemSchema.optional(), hasMore: z.boolean().optional() });
export async function platformRequest<T>(baseUrl: string, apiKey: string, path: string, input: unknown, schema: z.ZodType<T>) {
  const response = await fetch(`${platformOrigin(baseUrl)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(input), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60_000) });
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new FederationError('同步服务器没有返回内容', 502);
  const reader = response.body.getReader();
  try { for (;;) { const { value: part, done } = await reader.read(); if (done) break; size += part.length; if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new FederationError('同步响应过大', 413); } chunks.push(part); } } finally { reader.releaseLock(); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new FederationError('同步服务器响应无效', 502); }
  if (!response.ok || !result.ok) throw new FederationError('同步请求失败，请检查两端地址、密钥及同步开关', response.status || 502);
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new FederationError('同步协议不兼容，请更新两端服务', 502);
  return parsed.data;
}
export function comparePlatformVersion(a: Pick<PlatformItem, 'revision' | 'writer'>, b: Pick<PlatformItem, 'revision' | 'writer'>) {
  return a.revision - b.revision || (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0);
}
