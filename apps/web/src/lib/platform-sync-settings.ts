import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db';
import { digest, FederationError, keyHash, openKey, sealKey } from './exam-federation-protocol';

export const PlatformSyncSettingsSchema = z.object({
  enabled: z.boolean().default(false), role: z.enum(['PUBLIC', 'LOCAL']).default('PUBLIC'),
  publicBaseUrl: z.string().trim().max(512).default(''), localBaseUrl: z.string().trim().max(512).default(''),
  publicApiKey: z.string().trim().max(512).default(''), localApiKey: z.string().trim().max(512).default(''),
});
export type PlatformSyncSettings = z.infer<typeof PlatformSyncSettingsSchema> & { nodeId: string; revision?: string };
export function platformOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new FederationError('请填写完整的服务器地址', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new FederationError('服务器地址须为 HTTP 或 HTTPS 根地址', 400);
  return url.origin;
}
export async function getPlatformSyncSettings(): Promise<PlatformSyncSettings> {
  let row = await prisma.systemSetting.findUnique({ where: { key: 'platformSync' } });
  if (!row) {
    try { row = await prisma.systemSetting.upsert({ where: { key: 'platformSync' }, create: { key: 'platformSync', value: { nodeId: randomUUID() } }, update: {} }); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
      row = await prisma.systemSetting.findUniqueOrThrow({ where: { key: 'platformSync' } });
    }
  }
  const raw = row.value as Record<string, unknown>;
  const parsed = PlatformSyncSettingsSchema.parse({ ...raw, publicApiKey: '', localApiKey: '' });
  // Retain legacy input fields for compatibility, but never use a LAN listener
  // address/key. Every network request is initiated by the LOCAL node.
  return { ...parsed, publicBaseUrl: parsed.role === 'PUBLIC' ? parsed.publicBaseUrl || configuredPublicOrigin() : parsed.publicBaseUrl,
    localBaseUrl: '', localApiKey: '', nodeId: String(raw.nodeId), revision: digest(raw),
    publicApiKey: raw.publicKeyCipher ? openKey(String(raw.publicKeyCipher)) : '' };
}
function configuredPublicOrigin() {
  if (!process.env.APP_BASE_URL) return '';
  return platformOrigin(process.env.APP_BASE_URL);
}
export function publicPlatformSyncSettings(s: PlatformSyncSettings) {
  const { revision: _revision, ...publicValue } = s;
  return { ...publicValue, publicApiKey: '', localBaseUrl: '', localApiKey: '', hasPublicApiKey: Boolean(s.publicApiKey), hasLocalApiKey: false, outboundOnly: true };
}
export async function savePlatformSyncSettings(input: z.infer<typeof PlatformSyncSettingsSchema>, options: { expectedRevision?: string; allowPublicKeyChange?: boolean } = {}) {
  const old = await getPlatformSyncSettings();
  if (options.expectedRevision && options.expectedRevision !== old.revision) throw new FederationError('同步设置已更新，请刷新后重试', 409);
  if (input.role === 'PUBLIC' && input.publicApiKey && (old.role !== 'PUBLIC' || input.publicApiKey !== old.publicApiKey) && !options.allowPublicKeyChange) throw new FederationError('请使用公网的“生成 API Key”按钮创建密钥', 400);
  const value = { ...input, nodeId: old.nodeId,
    publicBaseUrl: input.role === 'PUBLIC' ? (old.role === 'PUBLIC' ? old.publicBaseUrl : '') || configuredPublicOrigin() : input.publicBaseUrl ? platformOrigin(input.publicBaseUrl) : '',
    localBaseUrl: '', publicApiKey: input.publicApiKey || (input.role === old.role ? old.publicApiKey : ''), localApiKey: '' };
  if (value.enabled && !value.publicApiKey) throw new FederationError(value.role === 'PUBLIC' ? '请先生成同步 API Key' : '请填写公网同步 API Key', 400);
  if (value.enabled && value.role === 'LOCAL' && !value.publicBaseUrl) throw new FederationError('请填写公网服务器地址', 400);
  if (value.role === 'LOCAL' && value.publicBaseUrl && value.publicBaseUrl === configuredPublicOrigin()) throw new FederationError('公网地址不能指向本机', 400);
  const { publicApiKey, localApiKey, ...plain } = value;
  await prisma.$transaction(async tx => {
    await tx.platformSyncState.upsert({ where: { id: 'peer' }, create: { id: 'peer' }, update: {} });
    await tx.$queryRaw`SELECT id FROM PlatformSyncState WHERE id = 'peer' FOR UPDATE`;
    await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = 'platformSync' FOR UPDATE`;
    const current = await tx.systemSetting.findUniqueOrThrow({ where: { key: 'platformSync' } });
    if (digest(current.value) !== old.revision) throw new FederationError('同步设置已被其他操作更新，请刷新后重试', 409);
    const history = await tx.platformSyncItem.count();
    if (history && old.role !== value.role) throw new FederationError('本机已有题库或考试同步映射，不能直接更换节点角色', 409);
    const active = await tx.examFederation.count({ where: { enabled: true, managedGlobally: true } });
    if (active && (old.role !== value.role || (old.publicBaseUrl && old.publicBaseUrl !== value.publicBaseUrl))) throw new FederationError('请先关闭考试同步再更换节点角色或公网地址', 409);
    await tx.systemSetting.update({ where: { key: 'platformSync' }, data: { value: { ...plain, publicKeyCipher: publicApiKey ? sealKey(publicApiKey) : '' } } });
    if (publicApiKey) await tx.examFederation.updateMany({ where: { managedGlobally: true }, data: { apiKeyHash: keyHash(publicApiKey), apiKeyCiphertext: sealKey(publicApiKey), remoteBaseUrl: value.publicBaseUrl,
      generation: { increment: 1 }, leaseToken: null, leaseUntil: null, nextAttemptAt: new Date() } });
  }, { isolationLevel: 'ReadCommitted' });
  return publicPlatformSyncSettings(value);
}
export async function publicPlatformSyncKey(generate = false) {
  const old = await getPlatformSyncSettings();
  if (old.role !== 'PUBLIC') throw new FederationError('内网只需填写公网地址与密钥，不生成回连密钥', 400);
  if (old.publicApiKey && (!generate || old.enabled)) return { apiKey: old.publicApiKey, settings: publicPlatformSyncSettings(old) };
  if (!generate) throw new FederationError('请先生成同步 API Key', 400);
  const apiKey = old.publicApiKey || 'sync_' + randomBytes(32).toString('base64url');
  try {
    const settings = await savePlatformSyncSettings({ ...old, publicApiKey: apiKey, enabled: true }, { expectedRevision: old.revision, allowPublicKeyChange: true });
    return { apiKey, settings };
  } catch (error) {
    if (!(error instanceof FederationError && error.status === 409)) throw error;
    const current = await getPlatformSyncSettings();
    if (current.role !== 'PUBLIC' || !current.publicApiKey || !current.enabled) throw error;
    return { apiKey: current.publicApiKey, settings: publicPlatformSyncSettings(current) };
  }
}
export function peerConnection(s: PlatformSyncSettings) {
  if (s.role !== 'LOCAL') throw new FederationError('公网不向内网发起连接，请由内网主动同步', 400);
  return { baseUrl: platformOrigin(s.publicBaseUrl), apiKey: s.publicApiKey };
}
