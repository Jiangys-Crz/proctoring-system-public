import { z } from 'zod';
import type { User } from '@prisma/client';
import { prisma } from './db';
import { storeReactionAsset } from './reaction-presentation';
import { deleteStoredObject } from './storage';
import { UploadSecurityError } from './upload-security';

export const ReactionLogoDetailsSchema = z.object({ label: z.string().trim().min(1).max(100), schoolName: z.string().trim().max(200).optional() }).strict();
const boundedSetting = (name: string, fallback: number, maximum: number) => {
  const value = Number(process.env[name] || fallback);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
};
export function reactionLogoLibraryLimits() {
  return { total: boundedSetting('REACTION_LOGO_LIBRARY_MAX_ITEMS', 500, 2000), perUser: boundedSetting('REACTION_LOGO_LIBRARY_MAX_PER_USER', 100, 500) };
}
export function reactionLogoView(row: { id: string; label: string; schoolName: string | null; createdById: string; createdAt: Date; archivedAt: Date | null }, user: Pick<User, 'id' | 'role'>, examId: string) {
  return { id: row.id, label: row.label, schoolName: row.schoolName, createdAt: row.createdAt, archived: Boolean(row.archivedAt), canArchive: user.role === 'SUPER_ADMIN' || row.createdById === user.id,
    previewUrl: `/api/exams/${encodeURIComponent(examId)}/reactions/logo-library/${encodeURIComponent(row.id)}` };
}
export async function listReactionLogos(user: Pick<User, 'id' | 'role'>, examId: string) {
  const limits = reactionLogoLibraryLimits();
  const [items, total] = await Promise.all([
    prisma.reactionLogo.findMany({ where: { archivedAt: null }, orderBy: [{ label: 'asc' }, { createdAt: 'desc' }], take: limits.total }),
    prisma.reactionLogo.count()
  ]);
  return { items: items.map(item => reactionLogoView(item, user, examId)), total, limit: limits.total };
}
export async function createReactionLogo(user: Pick<User, 'id' | 'role'>, examId: string, file: File, details: unknown) {
  const input = ReactionLogoDetailsSchema.parse(details), limits = reactionLogoLibraryLimits();
  const stored = await storeReactionAsset('logo-library', file, 'logo');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const row = await prisma.$transaction(async tx => {
          // Serializable count+insert bounds concurrent uploads without a new service.
          const total = await tx.reactionLogo.count();
          const owned = await tx.reactionLogo.count({ where: { createdById: user.id } });
          if (total >= limits.total || owned >= limits.perUser) throw new UploadSecurityError('校徽素材库已达到容量上限，请联系部署管理员调整配额', 409);
          return tx.reactionLogo.create({ data: { label: input.label, schoolName: input.schoolName || null, objectPath: stored.path, createdById: user.id } });
        }, { isolationLevel: 'Serializable' });
        return reactionLogoView(row, user, examId);
      } catch (error) {
        if (attempt < 2 && error && typeof error === 'object' && 'code' in error && error.code === 'P2034') continue;
        throw error;
      }
    }
  } catch (error) {
    // Only the fresh, unpublished UUID object from this failed upload is removed.
    await deleteStoredObject(stored.path).catch(() => {});
    throw error;
  }
}
export async function archiveReactionLogo(id: string, user: Pick<User, 'id' | 'role'>, examId: string) {
  const row = await prisma.reactionLogo.findUnique({ where: { id } });
  if (!row) throw new UploadSecurityError('校徽不存在', 404);
  if (user.role !== 'SUPER_ADMIN' && row.createdById !== user.id) throw new UploadSecurityError('只有素材创建者或超级管理员可以归档校徽', 403);
  const updated = await prisma.reactionLogo.update({ where: { id }, data: { archivedAt: row.archivedAt || new Date() } });
  return reactionLogoView(updated, user, examId);
}
