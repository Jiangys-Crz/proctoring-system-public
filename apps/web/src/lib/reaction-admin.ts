import { z } from 'zod';
import { prisma } from './db';
import { ccsCredential, reactionChannels } from './reaction-domain';
import { ReactionPresentationSchema, reactionPresentationFromJson, validateReactionPresentationAssets } from './reaction-presentation';
import { UploadSecurityError } from './upload-security';
import { resolveReactionTeamName } from './reaction-team-name';
import { getReactionExportSummary } from './reaction-export';

export const ReactionConfigSchema = z.object({
  enabled: z.boolean(), bufferSeconds: z.number().int().min(10).max(600).default(60),
  beforeSeconds: z.number().int().min(0).max(60).default(3), afterSeconds: z.number().int().min(0).max(120).default(10),
  maxPendingSeconds: z.number().int().min(30).max(86400).default(1800),
  maxStorageBytes: z.number().int().min(104857600).max(Number.MAX_SAFE_INTEGER).default(21474836480),
  retentionDays: z.number().int().min(1).max(3650).default(30), autoGenerate: z.boolean().default(false),
  uploadGraceSeconds: z.number().int().min(10).max(600).default(30),
  presentation: ReactionPresentationSchema.optional()
}).strict().refine(v => v.beforeSeconds < v.bufferSeconds, '提交前时间必须小于缓存窗口');

export async function updateReactionConfig(examId: string, input: unknown) {
  const { enabled, maxStorageBytes, presentation, ...values } = ReactionConfigSchema.parse(input);
  if (presentation) {
    if (presentation.teamLogos.length) {
      const teams = await prisma.candidate.findMany({ where: { examId, examNumber: { in: presentation.teamLogos.map(item => item.teamId) } }, select: { examNumber: true } });
      const exact = new Set(teams.map(team => team.examNumber));
      if (presentation.teamLogos.some(item => !exact.has(item.teamId))) throw new UploadSecurityError('校徽必须绑定本场考试中准确匹配的队伍账号');
    }
    await validateReactionPresentationAssets(examId, presentation);
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
    const exam = await tx.exam.findUniqueOrThrow({ where: { id: examId } });
    if (exam.platform !== 'NOVAJUDGE') throw new Error('仅 NovaJudge 考试支持自动 Reaction');
    if (enabled && exam.recordingsDeletedAt) throw new Error('本场录像已删除，不能开启 Reaction');
    if (enabled) ccsCredential(exam);
    // A newly enabled session must ignore submissions made while disabled.
    // Keep the existing cutover when saving an already enabled configuration,
    // and retain prior reactions/checkpoints for audit and replay deduplication.
    const cutover = enabled && !exam.reactionEnabled ? { initializedAt: new Date() } : {};
    const appearance = presentation ? { presentation } : {};
    await tx.reactionConfig.upsert({ where: { examId }, create: { examId, ...values, ...appearance, ...cutover, maxStorageBytes: BigInt(maxStorageBytes) }, update: { ...values, ...appearance, ...cutover, maxStorageBytes: BigInt(maxStorageBytes) } });
    await tx.exam.update({ where: { id: examId }, data: { reactionEnabled: enabled } });
    if (!enabled) await tx.reaction.updateMany({ where: { examId, status: { in: ['PENDING','TAIL'] } }, data: { status: 'CANCELLED', error: 'REACTION_DISABLED', finalizedAt: new Date() } });
  });
  return getReactionAdminData(examId);
}

export async function queueReactionGeneration(examId: string, reactionIds?: string[]) {
  const result = await prisma.reaction.updateMany({ where: { examId, ...(reactionIds ? { id: { in: reactionIds } } : {}), OR: [{ status: 'COMPLETE', cameraPath: { not: null } }, { status: 'PARTIAL' }], desktopPath: { not: null }, judgementObservedAt: { not: null }, windowEnd: { not: null }, generationStatus: { notIn: ['QUEUED', 'RUNNING'] } }, data: { generationStatus: 'QUEUED', generationError: null } });
  return { queued: result.count };
}

export async function getReactionAdminData(examId: string) {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { reactionConfig: true } });
  const c = exam.reactionConfig;
  let credentialsConfigured = false; try { ccsCredential(exam); credentialsConfigured = true; } catch { /* presence only */ }
  const [items, buffer, recent, processedSubmissions, savedVideos, missingOrFailed, candidates, teamEvents, exportSummary] = await Promise.all([
    prisma.reaction.findMany({ where: { examId }, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.mediaSegment.aggregate({ where: { examId, reactionCache: true, deletedAt: null }, _count: true, _sum: { byteSize: true } }),
    prisma.mediaSegment.groupBy({ by: ['candidateId','channel'], where: { examId, deletedAt: null, channel: { in: [...reactionChannels] }, endedAt: { gte: new Date(Date.now() - 25_000) } } }),
    prisma.reaction.count({ where: { examId } }), prisma.reaction.count({ where: { examId, status: 'COMPLETE' } }),
    prisma.reaction.count({ where: { examId, status: { in: ['PARTIAL','MISSING','FAILED','TIMEOUT','UNMAPPED'] } } }),
    prisma.candidate.findMany({ where: { examId }, orderBy: { examNumber: 'asc' }, select: { examId: true, examNumber: true, teamName: true, school: true } }),
    prisma.reactionEvent.findMany({ where: { examId, type: 'teams' }, select: { examId: true, type: true, remoteId: true, payload: true } }),
    getReactionExportSummary(examId)
  ]);
  const candidatesByTeam = new Map(candidates.map(candidate => [candidate.examNumber, candidate]));
  const eventsByTeam = new Map(teamEvents.map(event => [event.remoteId, event]));
  const teamName = (teamId: string) => resolveReactionTeamName({ examId, teamId, candidate: candidatesByTeam.get(teamId), teamEvent: eventsByTeam.get(teamId) });
  return { exam: { id: exam.id, name: exam.name, platform: exam.platform, schools: [...new Set(candidates.map(item => item.school?.trim()).filter((value): value is string => Boolean(value)))].sort() },
    exportSummary,
    candidates: candidates.map(item => ({ teamId: item.examNumber, teamName: teamName(item.examNumber), schoolName: item.school || null })),
    config: { enabled: exam.reactionEnabled, bufferSeconds: c?.bufferSeconds ?? 60, beforeSeconds: c?.beforeSeconds ?? 3, afterSeconds: c?.afterSeconds ?? 10, maxPendingSeconds: c?.maxPendingSeconds ?? 1800, maxStorageBytes: Number(c?.maxStorageBytes ?? 21474836480), retentionDays: c?.retentionDays ?? 30, autoGenerate: c?.autoGenerate ?? false, uploadGraceSeconds: c?.uploadGraceSeconds ?? 30, presentation: reactionPresentationFromJson(c?.presentation, examId), credentialsConfigured },
    health: { feedStatus: c?.leaseUntil && c.leaseUntil > new Date() ? c.feedStatus : 'STOPPED', lastEventAt: c?.lastEventAt ?? null, lastError: c?.lastError ?? null, connectedSources: recent.length, bufferSegments: buffer._count, bufferBytes: buffer._sum.byteSize || 0, processedSubmissions, savedVideos: savedVideos * 2, missingOrFailed },
    items: items.map(r => ({ id:r.id, submissionId:r.submissionId, teamId:r.teamId, teamName:teamName(r.teamId), problemId:r.problemId, problemLabel:r.problemLabel, verdict:r.verdict, originalVerdict:r.originalVerdict, verdictHistory:r.verdictHistory, status:r.status, durationSeconds:r.durationSeconds, reason:r.error, createdAt:r.createdAt, cameraPath:r.cameraPath, desktopPath:r.desktopPath, reactionPath:r.reactionPath, metadataPath:r.metadataPath, generationStatus:r.generationStatus, generationError:r.generationError })) };
}
