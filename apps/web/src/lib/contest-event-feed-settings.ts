import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AuthError } from './auth';
import { prisma } from './db';
import { createSettingCache } from './setting-cache';

const platform = z.enum(['hydro', 'nova']);
function ccsOrigin(value: string) {
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
        url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash) return url.origin;
  } catch { /* Validation below supplies the form error. */ }
  return null;
}
const origin = z.string().trim().max(2048).refine(value => ccsOrigin(value) !== null, '请输入 HTTPS 站点根地址，不含比赛或域路径')
  .transform(value => ccsOrigin(value)!);
const credentialsSchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('hydro'), origin, apiKey: z.string().regex(/^[\x21-\x7e]{32,1024}$/) }),
  z.object({ platform: z.literal('nova'), origin, username: z.string().trim().min(1).max(191).regex(/^[^:\r\n]+$/),
    password: z.string().min(1).max(1024) }),
]);
type Credentials = z.infer<typeof credentialsSchema>;
export type ContestFeedPlatform = z.infer<typeof platform>;
export type ContestFeedSettingsStatus = { nova: { origin: string; username: string } | null };
export const ContestFeedSettingsSchema = z.union([
  z.object({ platform, remove: z.literal(true) }).strict(), credentialsSchema,
]);

const keyOf = (kind: ContestFeedPlatform) => `contest-event-feed:${kind}`;
const cache = createSettingCache<Record<ContestFeedPlatform, string | null>>();
function encryptionKey(kind: ContestFeedPlatform) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new AuthError('请先为后台配置至少 32 字符的会话密钥', 503);
  return createHash('sha256').update(`contest-event-feed:v1:${kind}:${secret}`).digest();
}

function seal(credentials: Credentials) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(credentials.platform), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(value => value.toString('base64url')).join('.');
}

async function saved() {
  return cache.read(async () => {
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: [keyOf('hydro'), keyOf('nova')] } },
      select: { key: true, value: true } });
    const value = (kind: ContestFeedPlatform) => {
      const row = rows.find(row => row.key === keyOf(kind));
      return typeof row?.value === 'string' ? row.value : null;
    };
    return { hydro: value('hydro'), nova: value('nova') };
  });
}

export async function readContestFeedCredential(kind: ContestFeedPlatform) {
  const ciphertext = (await saved())[kind];
  if (!ciphertext) return null;
  try {
    const parts = ciphertext.split('.').map(part => Buffer.from(part, 'base64url'));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(kind), parts[0]);
    decipher.setAuthTag(parts[1]);
    const credential = credentialsSchema.parse(JSON.parse(Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8')));
    if (credential.platform !== kind) throw new Error();
    return credential;
  } catch {
    throw new AuthError('赛事 Event Feed 凭据无法解密，请在系统设置中重新保存', 409);
  }
}

export async function contestFeedSettingsStatus(): Promise<ContestFeedSettingsStatus> {
  // HydroOJ browser exams keep this credential with the exam; only NovaJudge
  // still has a system-level Event Feed credential.
  const nova = await readContestFeedCredential('nova');
  return { nova: nova?.platform === 'nova' ? { origin: nova.origin, username: nova.username } : null };
}

export async function saveContestFeedSettings(input: z.infer<typeof ContestFeedSettingsSchema>) {
  const key = keyOf(input.platform);
  if ('remove' in input) await prisma.systemSetting.deleteMany({ where: { key } });
  else {
    const value = seal(input);
    await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  cache.invalidate();
}
