import { z } from 'zod';
import type { User } from '@prisma/client';
import { prisma } from './db';
import { AuthError } from './auth';
import { canManageExam } from './permissions';
import { getStorageSettings } from './settings';
import { deletionStorage, objectHash, fileDeletionId } from './file-deletion';
import { evidenceChannel, EVIDENCE_WINDOW_MS, LEGACY_SEGMENT_MS } from './evidence-window';

export const DeleteRecordingsSchema = z.union([
  z.object({ examIds: z.array(z.string().min(1)).min(1).max(20) }).strict(),
  z.object({ alertIds: z.array(z.string().min(1)).min(1).max(100) }).strict()
]);
export const RECORDING_CHANNELS = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA', 'EVIDENCE_CLIP'] as const;
export async function deleteRecordings(user: User, input: z.infer<typeof DeleteRecordingsSchema>) {
  const wholeExam = 'examIds' in input;
  const alerts = wholeExam ? [] : await prisma.alert.findMany({ where: { id: { in: input.alertIds } } });
  if (!wholeExam && new Set(alerts.map(a => a.id)).size !== new Set(input.alertIds).size) throw new AuthError('录像记录不存在', 404);
  const examIds = [...new Set(wholeExam ? input.examIds : alerts.map(a => a.examId))].sort();
  for (const id of examIds) if (!await canManageExam(user, id)) throw new AuthError('只有比赛管理员可以删除本场考试录像', 403);
  const storage = deletionStorage(await getStorageSettings());
  return prisma.$transaction(async tx => {
    for (const id of examIds) {
      await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${id} FOR UPDATE`;
      const exam = await tx.exam.findUnique({ where: { id } });
      if (!exam) throw new AuthError('考试不存在', 404);
      if (user.role !== 'SUPER_ADMIN' && exam.createdById !== user.id && !await tx.examAdministrator.count({ where: { examId: id, userId: user.id } })) throw new AuthError('比赛管理权限已变化，请刷新页面', 403);
      if (exam.endAt > new Date()) throw new AuthError('考试尚未结束，不能删除监考录像', 409);
      if (await tx.reaction.count({where:{examId:id,status:{not:'EXPIRED'}}})) throw new AuthError('录像受 Reaction 引用保护，请先等待配置的保留期结束',409);
    }
    const selectedWhere = wholeExam ? { examId: { in: examIds } } : { id: { in: input.alertIds } };
    const selected = await tx.alert.findMany({ where: selectedWhere });
    const selectedIds = new Set(selected.map(a => a.id));
    const paths = new Set(selected.filter(a => !a.evidenceDeletedAt && a.evidencePath).map(a => a.evidencePath!));
    const segments = await tx.mediaSegment.findMany({ where: { examId: { in: examIds }, deletedAt: null,
      channel: { in: [...RECORDING_CHANNELS] } } });
    const remaining = wholeExam ? [] : await tx.alert.findMany({ where: { examId: { in: examIds }, evidenceDeletedAt: null, id: { notIn: [...selectedIds] } } });
    const overlaps = (a: typeof selected[number], s: typeof segments[number]) => a.sessionId && a.sessionId === s.sessionId
      && evidenceChannel(a.type, a) === s.channel && s.startedAt.getTime() < a.createdAt.getTime() + EVIDENCE_WINDOW_MS
      && (s.endedAt?.getTime() ?? s.startedAt.getTime() + LEGACY_SEGMENT_MS) > a.createdAt.getTime() - EVIDENCE_WINDOW_MS;
    const doomed = segments.filter(s => wholeExam || (paths.has(s.objectPath) || selected.some(a => overlaps(a, s)))
      && !remaining.some(a => a.evidencePath === s.objectPath || overlaps(a, s)));
    const now = new Date();
    await tx.alert.updateMany({ where: { ...selectedWhere, evidenceDeletedAt: null }, data: { evidenceDeletedAt: now, evidencePath: null } });
    await tx.mediaSegment.updateMany({ where: wholeExam ? { examId: { in: examIds }, channel: { in: [...RECORDING_CHANNELS] }, deletedAt: null } : { id: { in: doomed.map(s => s.id) }, deletedAt: null }, data: { deletedAt: now } });
    if (wholeExam) await tx.exam.updateMany({ where: { id: { in: examIds }, recordingsDeletedAt: null }, data: { recordingsDeletedAt: now } });
    const pathExamIds = new Map(selected.filter(a => a.evidencePath).map(a => [a.evidencePath!, a.examId]));
    for (const s of doomed) { paths.add(s.objectPath); pathExamIds.set(s.objectPath, s.examId); }
    let files = 0;
    const keys = [...paths];
    for (let offset = 0; offset < keys.length; offset += 100) {
      const batch = keys.slice(offset, offset + 100);
      const [media, references, login, voice, frames, images, previous] = await Promise.all([
        tx.mediaSegment.findMany({ where: { objectPath: { in: batch }, deletedAt: null }, select: { objectPath: true } }),
        tx.alert.findMany({ where: { evidencePath: { in: batch }, evidenceDeletedAt: null }, select: { evidencePath: true } }),
        tx.loginRequest.findMany({ where: { OR: [{ identityPhotoPath: { in: batch } }, { roomVideoPath: { in: batch } }] }, select: { identityPhotoPath: true, roomVideoPath: true } }),
        tx.voiceMessage.findMany({ where: { objectPath: { in: batch } }, select: { objectPath: true } }),
        tx.liveFrame.findMany({ where: { objectPath: { in: batch } }, select: { objectPath: true } }),
        tx.screenControlImage.findMany({ where: { objectPath: { in: batch } }, select: { objectPath: true } }),
        tx.fileDeletionJob.findMany({ where: { kind: 'MEDIA', objectHash: { in: batch.map(objectHash) } }, select: { objectHash: true } })
      ]);
      const referenced = new Set([...media, ...voice, ...frames, ...images].map(r => r.objectPath));
      for (const r of references) if (r.evidencePath) referenced.add(r.evidencePath);
      for (const r of login) { if (r.identityPhotoPath) referenced.add(r.identityPhotoPath); if (r.roomVideoPath) referenced.add(r.roomVideoPath); }
      const queued = new Set(previous.map(r => r.objectHash));
      const jobs = batch.filter(key => !referenced.has(key) && !queued.has(objectHash(key))).map(key => ({
        id: fileDeletionId('MEDIA', key, storage), kind: 'MEDIA', examId: pathExamIds.get(key),
        objectPath: key, objectHash: objectHash(key), storage, requestedById: user.id
      }));
      if (jobs.length) files += (await tx.fileDeletionJob.createMany({ data: jobs, skipDuplicates: true })).count;
    }
    return { recordings: doomed.length, files, examIds };
  }, { timeout: 60_000, isolationLevel: 'ReadCommitted' });
}
