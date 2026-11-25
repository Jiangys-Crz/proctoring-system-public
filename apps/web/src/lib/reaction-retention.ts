import { prisma } from './db';
import { Prisma } from '@prisma/client';
import { activeReactionStates, reactionChannels } from './reaction-domain';
import { pinReactionSegments } from './reaction-events';
import { getStorageSettings } from './settings';
import { deletionStorage, queueFileDeletion, processFileDeletions } from './file-deletion';
import { isIncidentRecording } from './recording-policy';
import { reactionStoredBytes } from './reaction-storage-budget';

export async function maintainReactionCache(examId:string, processDeletions = true) {
  const storage=deletionStorage(await getStorageSettings()); const now=new Date();
  await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
    const exam=await tx.exam.findUniqueOrThrow({where:{id:examId},include:{reactionConfig:true}}); const c=exam.reactionConfig;
    if(!c) return;
    if (!exam.recordingsDeletedAt) {
      // A client may deliver a usable clip after the first capture settled.
      // Recover from that clip once, preserving the original window and verdict.
      const late = await tx.$queryRaw<{ id: string }[]>`
        SELECT r.id FROM Reaction r
        WHERE r.examId = ${examId} AND r.status = 'MISSING'
          AND r.expiresAt > ${now} AND r.generationStatus = 'IDLE'
          AND r.cameraPath IS NULL AND r.desktopPath IS NULL AND r.reactionPath IS NULL
          AND EXISTS (
            SELECT 1 FROM MediaSegment m
            WHERE m.examId = r.examId AND m.candidateId = r.candidateId
              AND m.channel IN (${Prisma.join(reactionChannels)}) AND m.deletedAt IS NULL
              AND m.receivedAt > r.finalizedAt AND m.endedAt > r.windowStart
              AND m.startedAt < r.windowEnd AND m.durationSeconds > 0
              AND TIMESTAMPADD(MICROSECOND, FLOOR(m.durationSeconds * 1000000), m.startedAt) > r.windowStart
          )
        ORDER BY r.finalizedAt LIMIT 50`;
      if (late.length) await tx.reaction.updateMany({
        where: { id: { in: late.map(row => row.id) }, status: 'MISSING' },
        data: { status: 'TAIL', error: null },
      });
    }
    const active=await tx.reaction.findMany({where:{examId,status:{in:activeReactionStates}}});
    for(const r of active) {
      if(r.status==='PENDING' && +now-+r.submissionObservedAt>c.maxPendingSeconds*1000) {
        await tx.reaction.update({where:{id:r.id},data:{status:'TIMEOUT',error:'JUDGEMENT_TIMEOUT',windowEnd:now,finalizedAt:now}});
      }
      await pinReactionSegments(tx,r.id);
    }
    const expired=await tx.reaction.findMany({where:{examId,expiresAt:{lt:now},status:{notIn:[...activeReactionStates,'EXPIRED']},generationStatus:{not:'RUNNING'}}});
    for(const r of expired) {
      for(const key of [r.cameraPath,r.desktopPath,r.metadataPath,r.reactionPath]) if(key) await queueFileDeletion(tx,{kind:'MEDIA',examId,objectPath:key,storage,requestedById:'reaction-retention'},true);
      await tx.reactionSegment.deleteMany({where:{reactionId:r.id}});
      await tx.reaction.update({where:{id:r.id},data:{status:'EXPIRED',cameraPath:null,desktopPath:null,metadataPath:null,reactionPath:null,outputBytes:0n,reservedBytes:0n}});
    }
    // Only cache-owned clips can be aged out. Existing full/incident evidence is never removed here.
    const stale=await tx.mediaSegment.findMany({where:{examId,reactionCache:true,deletedAt:null,endedAt:{lt:new Date(+now-c.bufferSeconds*1000)},receivedAt:{lt:new Date(+now-60_000)},reactionSegments:{none:{}}},orderBy:{startedAt:'asc'},take:500});
    for(const s of stale) {
      if(exam.saveFullRecording || (exam.saveIncidentRecording && s.sessionId && s.endedAt && await isIncidentRecording(s.sessionId,s.channel,s.startedAt,s.endedAt,tx))) {
        await tx.mediaSegment.update({where:{id:s.id},data:{reactionCache:false}});continue;
      }
      await tx.mediaSegment.update({where:{id:s.id},data:{deletedAt:now}});
      await queueFileDeletion(tx,{kind:'MEDIA',examId,objectPath:s.objectPath,storage,requestedById:'reaction-buffer'},true);
    }
    if(await reactionStoredBytes(tx,examId)>c.maxStorageBytes) {
      await tx.reactionConfig.update({where:{examId},data:{lastError:'STORAGE_LIMIT: capture uploads paused; protected footage retained'}});
    }
  },{timeout:30000,isolationLevel:'ReadCommitted'});
  if (processDeletions) await processFileDeletions({examId},100);
}
