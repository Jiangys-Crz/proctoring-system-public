import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { getStorageSettings } from './settings';
import { withS3Client } from './s3-client-pool';
import { storeBuffer } from './storage';
import { UploadSecurityError } from './upload-security';
import { prisma } from './db';

export const REACTION_ASSET_MAX_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const assetName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;
const assetPath = z.string().max(240).regex(/^reactions\/[a-zA-Z0-9_-]+\/assets\/[0-9a-f-]+\.png$/);
const logoReference = { path: assetPath.optional(), logoId: z.string().cuid().optional() };
const oneLogoReference = (value: { path?: string; logoId?: string }) => Boolean(value.path) !== Boolean(value.logoId);
export type ReactionLogoReference = { path?: string; logoId?: string };
export const ReactionPresentationSchema = z.object({
  version: z.literal(1).default(1),
  fontPreset: z.enum(['broadcast', 'classic']).default('broadcast'),
  backgroundPath: assetPath.optional(), defaultLogoPath: assetPath.optional(), defaultLogoId: z.string().cuid().optional(),
  teamLogos: z.array(z.object({ teamId: z.string().min(1).max(100), ...logoReference }).strict().refine(oneLogoReference, '校徽必须选择素材库或旧版素材中的一种')).max(200).default([]),
  schoolLogos: z.array(z.object({ schoolName: z.string().trim().min(1).max(200), ...logoReference }).strict().refine(oneLogoReference, '校徽必须选择素材库或旧版素材中的一种')).max(100).default([])
}).strict().refine(value => new Set(value.schoolLogos.map(item => item.schoolName)).size === value.schoolLogos.length, '每个学校名称只能绑定一个校徽')
  .refine(value => new Set(value.teamLogos.map(item => item.teamId)).size === value.teamLogos.length, '每个队伍只能绑定一个校徽')
  .refine(value => !value.defaultLogoPath || !value.defaultLogoId, '默认校徽只能选择一种来源');
export type ReactionPresentation = z.infer<typeof ReactionPresentationSchema>;
export const defaultReactionPresentation = (): ReactionPresentation => ({ version: 1, fontPreset: 'broadcast', teamLogos: [], schoolLogos: [] });

export function reactionAssetKey(examId: string, filename: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(examId) || !assetName.test(filename)) throw new UploadSecurityError('素材不存在', 404);
  return `reactions/${examId}/assets/${filename}`;
}
export function reactionAssetFilename(examId: string, key: string) {
  const filename = key.slice(`reactions/${examId}/assets/`.length);
  if (reactionAssetKey(examId, filename) !== key) throw new UploadSecurityError('只能使用本场考试上传的素材', 400);
  return filename;
}
export function reactionPresentationFromJson(value: unknown, examId: string) {
  const parsed = ReactionPresentationSchema.safeParse(value);
  if (!parsed.success) return defaultReactionPresentation();
  try { presentationPaths(parsed.data).forEach(key => reactionAssetFilename(examId, key)); return parsed.data; }
  catch { return defaultReactionPresentation(); }
}
function presentationPaths(value: ReactionPresentation) {
  return [...new Set([value.backgroundPath, value.defaultLogoPath, ...value.teamLogos.map(item => item.path), ...value.schoolLogos.map(item => item.path)].filter((key): key is string => Boolean(key)))];
}
function presentationLibraryBindings(value: ReactionPresentation) {
  return new Map<string, string>([
    ...value.teamLogos.filter(item => item.logoId).map(item => [`team:${item.teamId}`, item.logoId!] as [string, string]),
    ...value.schoolLogos.filter(item => item.logoId).map(item => [`school:${item.schoolName}`, item.logoId!] as [string, string]),
    ...(value.defaultLogoId ? [['default', value.defaultLogoId] as [string, string]] : [])
  ]);
}

/** Archived library entries remain available to render their existing bindings. */
export async function resolveReactionLogoAsset(examId: string, reference?: ReactionLogoReference | null) {
  if (!reference?.path && !reference?.logoId) return null;
  if (!oneLogoReference(reference)) throw new UploadSecurityError('校徽来源不正确');
  if (reference.path) {
    reactionAssetFilename(examId, reference.path);
    return { path: reference.path, archived: false };
  }
  const row = await prisma.reactionLogo.findUnique({ where: { id: reference.logoId! }, select: { id: true, objectPath: true, archivedAt: true } });
  if (!row) return null;
  reactionAssetFilename('logo-library', row.objectPath);
  return { path: row.objectPath, logoId: row.id, archived: Boolean(row.archivedAt) };
}

/** Bounded, authorized callers only. The URL never chooses a raw storage key. */
export async function readReactionAsset(examId: string, key: string) {
  reactionAssetFilename(examId, key);
  const settings = await getStorageSettings();
  let buffer: Buffer;
  try {
    if (settings.provider === 'S3') {
      buffer = await withS3Client(settings, async client => {
        const response = await client.send(new GetObjectCommand({ Bucket: settings.s3.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) });
        if (!response.Body) throw new UploadSecurityError('素材不存在', 404);
        if (Number(response.ContentLength) > REACTION_ASSET_MAX_BYTES) throw new UploadSecurityError('素材文件过大', 413);
        const reader = response.Body.transformToWebStream().getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > REACTION_ASSET_MAX_BYTES) { await reader.cancel(); throw new UploadSecurityError('素材文件过大', 413); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks, size);
      });
    } else {
      const root = await realpath(path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads'));
      const filename = await realpath(path.join(root, key));
      if (!filename.startsWith(root + path.sep)) throw new UploadSecurityError('素材路径无效', 400);
      const info = await stat(filename);
      if (!info.isFile()) throw new UploadSecurityError('素材不存在', 404);
      if (info.size > REACTION_ASSET_MAX_BYTES) throw new UploadSecurityError('素材文件过大', 413);
      buffer = await readFile(filename);
    }
  } catch (error) {
    if (error && typeof error === 'object' && ('code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code)) || '$metadata' in error && (error.$metadata as { httpStatusCode?: number })?.httpStatusCode === 404)) throw new UploadSecurityError('素材不存在，请重新上传', 404);
    throw error;
  }
  if (buffer.length > REACTION_ASSET_MAX_BYTES || buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new UploadSecurityError('素材无效，请重新上传', 400);
  return buffer;
}
export async function validateReactionPresentationAssets(examId: string, value: ReactionPresentation) {
  // Sequential bounded reads avoid decoding/loading a hundred files at once.
  for (const key of presentationPaths(value)) await readReactionAsset(examId, key);
  const bindings = presentationLibraryBindings(value);
  if (bindings.size) {
    const previous = await prisma.reactionConfig.findUnique({ where: { examId }, select: { presentation: true } });
    const previousBindings = presentationLibraryBindings(reactionPresentationFromJson(previous?.presentation, examId));
    const entries = await prisma.reactionLogo.findMany({ where: { id: { in: [...new Set(bindings.values())] } }, select: { id: true, objectPath: true, archivedAt: true } });
    const byId = new Map(entries.map(item => [item.id, item]));
    for (const [binding, id] of bindings) {
      const entry = byId.get(id);
      if (!entry) throw new UploadSecurityError('选择的校徽不存在，请刷新素材库');
      if (entry.archivedAt && previousBindings.get(binding) !== id) throw new UploadSecurityError('该校徽已归档，请选择其他素材；已有绑定可以继续使用', 409);
    }
    for (const entry of entries) await readReactionAsset('logo-library', entry.objectPath);
  }
}

export async function storeReactionAsset(examId: string, file: File, kind: 'background' | 'logo') {
  const mimeFormats: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
  if (!mimeFormats[file.type] || file.size === 0) throw new UploadSecurityError('仅支持 PNG、JPEG、WebP 图片');
  if (file.size > REACTION_ASSET_MAX_BYTES) throw new UploadSecurityError('图片不能超过 4 MiB', 413);
  let image: Buffer;
  try {
    const input = Buffer.from(await file.arrayBuffer());
    const decoder = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'warning', animated: false });
    const metadata = await decoder.metadata();
    if (metadata.format !== mimeFormats[file.type] || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS || metadata.width > 8192 || metadata.height > 8192 || (metadata.pages || 1) !== 1) throw new Error('Invalid image');
    const limit = kind === 'background' ? 1920 : 1024;
    // Re-encoding strips EXIF, external metadata and appended non-image bytes.
    image = await decoder.rotate().resize({ width: limit, height: limit, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  } catch { throw new UploadSecurityError('图片无法解码，或超过 1600 万像素；请上传静态 PNG、JPEG、WebP'); }
  if (image.length > REACTION_ASSET_MAX_BYTES) throw new UploadSecurityError('处理后的图片超过 4 MiB，请降低图片尺寸', 413);
  const filename = `${randomUUID()}.png`;
  reactionAssetKey(examId, filename);
  const stored = await storeBuffer(image, { filename, contentType: 'image/png', prefix: `reactions/${examId}/assets`, stableName: true, immutable: true });
  return { path: stored.objectPath, assetId: filename, previewUrl: `/api/exams/${encodeURIComponent(examId)}/reactions/assets?asset=${filename}` };
}
