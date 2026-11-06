import sharp from 'sharp';
import { z } from 'zod';
import type { Prisma, User } from '@prisma/client';
import { prisma } from './db';
import { AuthError } from './auth';
import { storeReactionAsset, reactionAssetFilename } from './reaction-presentation';
import { deleteStoredObject } from './storage';
import { UploadSecurityError } from './upload-security';
import { reactionLogoSelection } from './reaction-render-settings';
import { defaultReactionBranding, normalizeReactionOrganizationName, REACTION_BRANDING_ORGANIZATION_LIMIT, REACTION_BUILTIN_BADGE_URL, type ReactionBrandingSettings, type ReactionBrandingView } from './reaction-branding-contract';

export const REACTION_BRANDING_SETTING_KEY = 'reactionBranding';
const Name = z.string().max(1000).transform(normalizeReactionOrganizationName).pipe(z.string().min(1, '请输入组织名称').max(200, '组织名称不能超过200个字符').regex(/^[^\u0000-\u001f\u007f]+$/, '组织名称包含无效字符'));
export const ReactionBrandingSettingsSchema = z.object({
  version: z.literal(1), organizations: z.array(z.object({ name: Name, logoId: z.string().cuid() }).strict()).max(REACTION_BRANDING_ORGANIZATION_LIMIT),
  defaultLogoId: z.string().cuid().nullable(),
}).strict().refine(value => new Set(value.organizations.map(item => item.name)).size === value.organizations.length, '归一后的组织名称不能重复');
export const ReactionBrandingRenameSchema = z.object({ name: Name, newName: Name }).strict();
export const ReactionBrandingDeleteSchema = z.object({ name: Name.optional() }).strict();
export const ReactionBrandingUploadSchema = z.object({
  kind: z.enum(['organization', 'default']), name: Name.optional(), replace: z.boolean().default(false), existingName: z.string().max(1000).optional(),
}).strict();
type Actor = Pick<User, 'id' | 'role'>;
const requireActor = (user: Actor) => { if (user.role !== 'SUPER_ADMIN') throw new AuthError('只有超级管理员可以维护组织徽章', 403); };

export async function getReactionBranding(client: Pick<Prisma.TransactionClient, 'systemSetting'> = prisma): Promise<ReactionBrandingSettings> {
  const row = await client.systemSetting.findUnique({ where: { key: REACTION_BRANDING_SETTING_KEY } });
  return ReactionBrandingSettingsSchema.parse(row?.value || defaultReactionBranding());
}

export async function getReactionBrandingView(): Promise<ReactionBrandingView> {
  const value = await getReactionBranding();
  const defaultRow = value.defaultLogoId ? await prisma.reactionLogo.findUnique({ where: { id: value.defaultLogoId }, select: { id: true, archivedAt: true } }) : null;
  // Preserve an assigned ID even if its record was externally removed/archived,
  // so the UI can explicitly replace/reset that stale binding. Its preview still
  // falls back to the neutral badge instead of becoming an unusable URL.
  const defaultLogoId = value.defaultLogoId;
  return { version: 1, organizations: value.organizations.map(item => ({ ...item, previewUrl: `/api/settings/reaction-branding/logos/${item.logoId}` })),
    defaultBadge: { logoId: defaultLogoId, previewUrl: defaultRow && !defaultRow.archivedAt ? `/api/settings/reaction-branding/logos/${defaultRow.id}` : REACTION_BUILTIN_BADGE_URL }, limit: REACTION_BRANDING_ORGANIZATION_LIMIT };
}

async function mutateBranding(change: (value: ReactionBrandingSettings, tx: Prisma.TransactionClient) => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.systemSetting.upsert({ where: { key: REACTION_BRANDING_SETTING_KEY }, create: { key: REACTION_BRANDING_SETTING_KEY, value: defaultReactionBranding() }, update: {} });
        await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${REACTION_BRANDING_SETTING_KEY} FOR UPDATE`;
        const value = await getReactionBranding(tx);
        await change(value, tx);
        const saved = ReactionBrandingSettingsSchema.parse(value);
        await tx.systemSetting.update({ where: { key: REACTION_BRANDING_SETTING_KEY }, data: { value: saved } });
      }, { isolationLevel: 'Serializable', timeout: 15000 });
    } catch (error) {
      if (attempt < 2 && error && typeof error === 'object' && 'code' in error && ['P2034', 'P2002'].includes(String(error.code))) continue;
      throw error;
    }
  }
}

function checkReplacement(value: ReactionBrandingSettings, input: z.infer<typeof ReactionBrandingUploadSchema>) {
  if (input.kind === 'default') {
    if (input.name) throw new UploadSecurityError('默认徽章无需组织名称');
    if (input.replace && input.existingName !== 'default') throw new UploadSecurityError('替换默认徽章时须明确指定默认项');
    if (value.defaultLogoId && (!input.replace || input.existingName !== 'default')) throw new UploadSecurityError('已设置默认徽章，请明确选择替换', 409);
    return;
  }
  if (!input.name) throw new UploadSecurityError('请输入组织名称');
  const existing = value.organizations.find(item => item.name === input.name);
  if (input.replace) {
    if (!input.existingName || normalizeReactionOrganizationName(input.existingName) !== input.name) throw new UploadSecurityError('替换时组织名称必须与原组织一致；更名请单独操作');
    if (!existing) throw new UploadSecurityError('待替换的组织不存在，请刷新列表', 404);
  } else if (existing) throw new UploadSecurityError('该组织名称已经存在，请选择替换', 409);
  if (!existing && value.organizations.length >= REACTION_BRANDING_ORGANIZATION_LIMIT) throw new UploadSecurityError('组织徽章数量已达到上限', 409);
}

export async function uploadReactionBranding(user: Actor, file: File, rawInput: unknown) {
  requireActor(user);
  const input = ReactionBrandingUploadSchema.parse(rawInput);
  checkReplacement(await getReactionBranding(), input);
  const stored = await storeReactionAsset('logo-library', file, 'logo');
  try {
    await mutateBranding(async (value, tx) => {
      checkReplacement(value, input);
      const configured = Number(process.env.REACTION_BRANDING_MAX_ASSETS || 2000);
      const assetLimit = Number.isSafeInteger(configured) && configured >= 500 ? Math.min(configured, 10000) : 2000;
      if (await tx.reactionLogo.count() >= assetLimit) throw new UploadSecurityError('徽章历史素材已达到容量上限，请联系部署管理员', 409);
      const logo = await tx.reactionLogo.create({ data: { label: input.kind === 'default' ? '系统默认徽章' : input.name!, schoolName: input.kind === 'organization' ? input.name : null, objectPath: stored.path, createdById: user.id } });
      if (input.kind === 'default') value.defaultLogoId = logo.id;
      else {
        const existing = value.organizations.find(item => item.name === input.name);
        if (existing) existing.logoId = logo.id;
        else value.organizations.push({ name: input.name!, logoId: logo.id });
      }
      // Old images remain immutable for historical references. Only their system
      // binding changes; never delete another exam's or prior render's source.
    });
  } catch (error) {
    await deleteStoredObject(stored.path).catch(() => {});
    throw error;
  }
  return getReactionBrandingView();
}

export async function renameReactionBrandingOrganization(user: Actor, rawInput: unknown) {
  requireActor(user);
  const input = ReactionBrandingRenameSchema.parse(rawInput);
  await mutateBranding(async value => {
    const entry = value.organizations.find(item => item.name === input.name);
    if (!entry) throw new UploadSecurityError('组织不存在，请刷新列表', 404);
    if (input.newName !== input.name && value.organizations.some(item => item.name === input.newName)) throw new UploadSecurityError('归一后的组织名称已经存在', 409);
    entry.name = input.newName;
  });
  return getReactionBrandingView();
}

export async function deleteReactionBrandingBinding(user: Actor, rawInput: unknown) {
  requireActor(user);
  const input = ReactionBrandingDeleteSchema.parse(rawInput);
  await mutateBranding(async value => {
    if (input.name) {
      const index = value.organizations.findIndex(item => item.name === input.name);
      if (index < 0) throw new UploadSecurityError('组织不存在，请刷新列表', 404);
      value.organizations.splice(index, 1);
    } else value.defaultLogoId = null;
  });
  return getReactionBrandingView();
}

export async function resolveReactionBrandingLogo(schoolName: string | null) {
  const value = await getReactionBranding();
  const selected = reactionLogoSelection(value, schoolName);
  const candidates = [selected, ...(selected.basis === 'system-organization' ? [reactionLogoSelection({ ...value, organizations: [] }, schoolName)] : [])];
  for (const candidate of candidates) {
    if (!candidate.logoId) continue;
    const row = await prisma.reactionLogo.findUnique({ where: { id: candidate.logoId }, select: { id: true, objectPath: true, archivedAt: true } });
    if (!row || row.archivedAt) continue;
    reactionAssetFilename('logo-library', row.objectPath);
    return { ...candidate, path: row.objectPath };
  }
  return reactionLogoSelection(defaultReactionBranding(), schoolName) as ReturnType<typeof reactionLogoSelection> & { path?: string };
}

let builtinBadge: Promise<Buffer> | undefined;
/** Fixed neutral artwork is both the System preview and the actual generator input. */
export function readBuiltinReactionBadge(): Promise<Buffer> {
  builtinBadge ??= sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><circle cx="256" cy="256" r="232" fill="#f8fafc" stroke="#334155" stroke-width="18"/><circle cx="256" cy="256" r="208" fill="none" stroke="#94a3b8" stroke-width="4"/><path d="M112 214l144-86 144 86H112zm32 24h32v112h-32zm64 0h32v112h-32zm64 0h32v112h-32zm64 0h32v112h-32zM120 366h272v24H120z" fill="#475569"/><path d="M256 160v20" stroke="#f8fafc" stroke-width="12" stroke-linecap="round"/></svg>')).png().toBuffer();
  return builtinBadge;
}
