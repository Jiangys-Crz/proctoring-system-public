import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const SYNC_VERSION = 1;
export const SYNC_BATCH = 8;
export const SYNC_BYTES = 16 * 1024 * 1024;
export class FederationError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export function canonical(value: unknown): string {
  const chunks: string[] = []; let nodes = 0, length = 0;
  const append = (part: string) => { length += part.length; if (length > 32 * 1024 * 1024) throw new FederationError('同步数据结构过大'); chunks.push(part); };
  const walk = (item: unknown, depth: number) => {
    if (++nodes > 500000 || depth > 64) throw new FederationError('同步数据结构过深或过复杂');
    if (item === undefined) { append('null'); return; }
    if (item === null || typeof item !== 'object') { append(JSON.stringify(item)); return; }
    if (item instanceof Date) { append(JSON.stringify(item.toISOString())); return; }
    if (Array.isArray(item)) { append('['); for (let index = 0; index < item.length; index++) { if (index) append(','); walk(item[index], depth + 1); } append(']'); return; }
    append('{');
    const pairs = Object.entries(item).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    pairs.forEach(([key, child], index) => { if (index) append(','); append(JSON.stringify(key) + ':'); walk(child, depth + 1); }); append('}');
  };
  walk(value, 0); return chunks.join('');
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
export const newSyncKey = () => randomBytes(32).toString('base64url');
export function equalHash(a: string, b: string) {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new FederationError('请先为服务器配置至少 32 字符的会话密钥', 400);
  return createHash('sha256').update(`exam-federation:v1:${secret}`).digest();
}
export function sealKey(value: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}
export function openKey(value: string | null) {
  try {
    const parts = (value || '').split('.').map(part => Buffer.from(part, 'base64url'));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), parts[0]);
    decipher.setAuthTag(parts[1]);
    return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8');
  } catch { throw new FederationError('同步密钥无法读取，请重新配置同步密钥', 400); }
}
export const accountDigest = (key: string, account: unknown) => createHmac('sha256', key).update(canonical(account)).digest('hex');
export function syncBaseUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new FederationError('公网地址必须是完整的 HTTPS 地址', 400); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new FederationError('请填写公网系统的 HTTPS 根地址，不含路径或账号密码', 400);
  }
  return url.origin;
}
const date = z.string().datetime({ offset: true });
const nullableDate = date.nullable();
const integer = z.number().int().min(0).max(2147483647);
export const SnapshotSchema = z.object({
  id: z.string().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/), originNodeId: z.string().uuid(), writerNodeId: z.string().uuid(), revision: integer.min(1),
  examNumber: z.string().min(1).max(191), problemOrder: integer, problemNumber: z.string().min(1).max(191),
  lang: z.string().min(1).max(64), code: z.string().max(512 * 1024),
  status: integer, statusText: z.string().max(1000).nullable(), score: z.number().finite(), manualScore: z.number().finite().min(0).nullable(),
  manualScoreUpdatedAt: nullableDate, totalTestCases: integer, passedTestCases: integer, time: integer, memory: integer,
  testCases: z.unknown().refine(value => value !== undefined).nullable(), subtasks: z.unknown().refine(value => value !== undefined).nullable(), judgeAt: nullableDate, createdAt: date,
}).strict();
export type SyncSnapshot = z.infer<typeof SnapshotSchema>;
/** Lamport counter plus stable writer tie-break: concurrent offline edits converge on every node. */
export function compareSnapshotVersion(a: Pick<SyncSnapshot, 'revision' | 'writerNodeId'>, b: Pick<SyncSnapshot, 'revision' | 'writerNodeId'>) {
  return a.revision - b.revision || (a.writerNodeId < b.writerNodeId ? -1 : a.writerNodeId > b.writerNodeId ? 1 : 0);
}
export const CursorSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(value => BigInt(value) <= 9223372036854775807n);
export const ExchangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('manifest'), version: z.literal(SYNC_VERSION) }).strict(),
  z.object({ action: z.literal('exchange'), version: z.literal(SYNC_VERSION), nodeId: z.string().uuid(), hubId: z.string().uuid(),
    contractHash: z.string().regex(/^[a-f0-9]{64}$/), after: CursorSchema, entries: z.array(SnapshotSchema).max(SYNC_BATCH) }).strict(),
]);
export const ManifestSchema = z.object({ version: z.literal(SYNC_VERSION), capabilities: z.array(z.string().max(40)).max(20).optional(), nodeId: z.string().uuid(), now: date,
  examCode: z.string().regex(/^\d{10}$/), rules: z.string(), hash: z.string(),
  candidates: z.array(z.object({ number: z.string(), hash: z.string() })).max(100000),
  problems: z.array(z.object({ order: integer, number: z.string(), hash: z.string(), definitionHash: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(10000),
});
export type SyncManifest = z.infer<typeof ManifestSchema>;
/** Keep the v1 contract hash stable: optional capabilities/definition hashes are
 * negotiation metadata, not a change to an already bound hub's wire identity. */
export function manifestContractHash(manifest: Pick<SyncManifest, 'examCode' | 'rules' | 'candidates' | 'problems'>) {
  return digest({ examCode: manifest.examCode, rules: manifest.rules, candidates: manifest.candidates,
    problems: manifest.problems.map(({ order, number, hash }) => ({ order, number, hash })) });
}
export const ExchangeReplySchema = z.object({ nodeId: z.string().uuid(), now: date, after: CursorSchema, entries: z.array(SnapshotSchema).max(SYNC_BATCH) });

/** Read responses with the same size/deadline bounds as requests. Never follow redirects with credentials. */
export async function syncRequest<T>(baseUrl: string, examCode: string, key: string, body: unknown, schema: z.ZodType<T>) {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > SYNC_BYTES) throw new FederationError('同步请求内容过大', 413);
  const signal = AbortSignal.timeout(18_000);
  const response = await fetch(`${syncBaseUrl(baseUrl)}/api/exam-sync/${examCode}`, { method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: serialized, cache: 'no-store' });
  const reader = response.body?.getReader();
  if (!reader) throw new FederationError('公网同步服务没有返回内容', 502);
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SYNC_BYTES) { await reader.cancel(); throw new FederationError('公网同步响应过大', 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { throw new FederationError('公网同步响应格式不正确', 502); }
  if (!response.ok || result?.ok !== true) {
    // Never propagate arbitrary remote HTML, URLs or credentials to logs/UI.
    const message = typeof result?.message === 'string' && result.message.length < 160 && !/https?:|secret|Bearer|\n/i.test(result.message)
      ? result.message.replaceAll(key, '[已隐藏]') : '公网同步请求失败';
    throw new FederationError(message, response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new FederationError('公网同步协议不兼容，请确认两端均已更新', 502);
  return parsed.data;
}
