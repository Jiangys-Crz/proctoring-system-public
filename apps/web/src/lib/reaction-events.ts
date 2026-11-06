import type { Exam, Prisma, ReactionConfig } from '@prisma/client';
import { prisma } from './db';
import { eventHash, finalVerdict, reactionChannels, type CcsEvent } from './reaction-domain';
import { observedReactionRankContext, rankingEventTypes } from './reaction-ranking';
import { resolveReactionTeamName } from './reaction-team-name';

type ConfiguredExam = Exam & { reactionConfig: ReactionConfig | null };
const asString = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v) : '';

export async function pinReactionSegments(tx: Prisma.TransactionClient, reactionId: string) {
  const r = await tx.reaction.findUniqueOrThrow({ where: { id: reactionId } });
  if (!r.candidateId) return;
  const segments = await tx.mediaSegment.findMany({ where: { examId:r.examId, candidateId:r.candidateId, deletedAt:null,
    channel:{ in:[...reactionChannels] }, endedAt:{ gt:r.windowStart }, ...(r.windowEnd ? { startedAt:{ lt:r.windowEnd } } : {}) }, select:{id:true} });
  if (segments.length) await tx.reactionSegment.createMany({ data:segments.map(s=>({reactionId,segmentId:s.id})),skipDuplicates:true });
}

/** Event checkpoint + business state + source references commit atomically under the same exam lock as deletion. */
export async function acceptReactionEvent(exam: ConfiguredExam, event: CcsEvent, observedAt = new Date(), initialize = false) {
  if (!(rankingEventTypes as readonly string[]).includes(event.type)) return;
  const data=event.data || {}; const remoteId=asString(data.id || event.id);
  if (!remoteId || remoteId.length > 191 || !['create','update','delete'].includes(event.op || 'create')) return;
  const hash=eventHash({deleted:event.op==='delete',data});
  await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${exam.id} FOR UPDATE`;
    const current=await tx.exam.findUniqueOrThrow({where:{id:exam.id},include:{reactionConfig:true}});
    if (!current.reactionEnabled || !current.reactionConfig) return;
    if (current.platform !== 'NOVAJUDGE' || current.platformContestId !== exam.platformContestId || new URL(current.platformBaseUrl).origin !== new URL(exam.platformBaseUrl).origin) throw new Error('REACTION_SOURCE_CHANGED');
    const config=current.reactionConfig;
    const key={examId:exam.id,type:event.type,remoteId};
    const previous=await tx.reactionEvent.findUnique({where:{examId_type_remoteId:key}});
    const checkpointOnlyReplay=previous?.payloadHash===hash;
    if (checkpointOnlyReplay) {
      // Nova's initial feed queries submissions and judgements separately. A
      // final judgement can be checkpointed before its submission is emitted.
      // Once the submission exists, replay must finish it instead of leaving
      // a permanently pending Reaction. Keep the *first* observation time.
      if(event.type!=='judgements' || event.op==='delete' || !finalVerdict(data) || !asString(data.submission_id)) return;
      const waiting=await tx.reaction.findUnique({where:{examId_submissionId:{examId:exam.id,submissionId:asString(data.submission_id)}}});
      if(!waiting || waiting.judgementObservedAt || waiting.finalizedAt || waiting.status!=='PENDING') return;
    }
    const checkpointPayload=(event.op==='delete'?{...data,__reactionDeleted:true}:data) as Prisma.InputJsonValue;
    if(!checkpointOnlyReplay) await tx.reactionEvent.upsert({where:{examId_type_remoteId:key},create:{...key,payloadHash:hash,payload:checkpointPayload,observedAt},update:{payloadHash:hash,payload:checkpointPayload,observedAt}});
    if (initialize) return;
    if (event.type==='contests' || event.type==='teams') return;
    if (event.type==='problems') {
      if (event.op!=='delete') await tx.reaction.updateMany({where:{examId:exam.id,problemId:remoteId},data:{problemLabel:asString(data.label)||remoteId}});
      return;
    }
    if (event.type==='submissions') {
      const existing=await tx.reaction.findUnique({where:{examId_submissionId:{examId:exam.id,submissionId:remoteId}}});
      if (event.op==='delete') {
        if(existing) await tx.reaction.update({where:{id:existing.id},data:{status:'DELETED',generationStatus:'CANCELLED',error:'SUBMISSION_DELETED',finalizedAt:observedAt}});
        return;
      }
      const teamId=asString(data.team_id), problemId=asString(data.problem_id), source=new Date(asString(data.time));
      if (existing) {
        if (existing.teamId!==teamId || existing.problemId!==problemId) await tx.reaction.update({where:{id:existing.id},data:{status:'FAILED',error:'SUBMISSION_IDENTITY_CHANGED',finalizedAt:observedAt}});
        return;
      }
      // Unknown historical items after reconnect must never become new recordings.
      if (!Number.isFinite(+source) || (config.initializedAt && source < config.initializedAt)) return;
      const candidate=await tx.candidate.findFirst({where:{examId:exam.id,examNumber:teamId}});
      const teamEvent=await tx.reactionEvent.findUnique({where:{examId_type_remoteId:{examId:exam.id,type:'teams',remoteId:teamId}}});
      const problem=await tx.reactionEvent.findUnique({where:{examId_type_remoteId:{examId:exam.id,type:'problems',remoteId:problemId}}});
      const problemLabel=problem?.payload && typeof problem.payload==='object' && !Array.isArray(problem.payload) ? asString(problem.payload.label) : '';
      const r=await tx.reaction.create({data:{examId:exam.id,contestId:exam.platformContestId,submissionId:remoteId,teamId,
        candidateId:candidate?.id,teamName:resolveReactionTeamName({examId:exam.id,teamId,candidate,teamEvent}),schoolName:candidate?.school,
        problemId,problemLabel:problemLabel||problemId,sourceSubmittedAt:source,submissionObservedAt:observedAt,eventOffsetMs:+observedAt-+source,
        windowStart:new Date(+source-config.beforeSeconds*1000),status:candidate?'PENDING':'UNMAPPED',error:candidate?null:'TEAM_USERNAME_NOT_MAPPED',
        expiresAt:new Date(+observedAt+config.retentionDays*86400000)}});
      await pinReactionSegments(tx,r.id);
    } else {
      const submissionId=asString(data.submission_id);
      const r=submissionId ? await tx.reaction.findUnique({where:{examId_submissionId:{examId:exam.id,submissionId}}}) : await tx.reaction.findFirst({where:{examId:exam.id,judgementId:remoteId}});
      if(!r) return;
      const judgementObservedAt=checkpointOnlyReplay&&previous?previous.observedAt:observedAt;
      const verdict=event.op==='delete'?null:finalVerdict(data);
      const history=Array.isArray(r.verdictHistory)?r.verdictHistory:[];
      const entry={judgementId:remoteId,verdict,op:event.op||'create',observedAt:judgementObservedAt.toISOString()};
      const historyUpdate={verdictHistory:[...history,entry].slice(-100) as Prisma.InputJsonValue};
      if (r.judgementId && r.judgementId !== remoteId && history.some(value => value && typeof value === 'object' && !Array.isArray(value) && value.judgementId === remoteId)) {
        // A delayed event for an already superseded judgement is historical only.
        await tx.reaction.update({where:{id:r.id},data:historyUpdate}); return;
      }
      // Completed recordings remain bound to their original observed verdict.
      // A later rejudge updates history/latest verdict but never relabels the old animation.
      if(r.finalizedAt || (r.originalVerdict && r.judgementObservedAt) || !['PENDING','TAIL'].includes(r.status)) {
        await tx.reaction.update({where:{id:r.id},data:{...historyUpdate,verdict,judgementId:remoteId}}); return;
      }
      if(!verdict) {
        await tx.reaction.update({where:{id:r.id},data:{...historyUpdate,status:'PENDING',verdict:null,originalVerdict:null,judgementObservedAt:null,windowEnd:null,judgementId:remoteId}}); return;
      }
      // Same verdict replay from create/update must not extend the capture end.
      if(r.verdict===verdict && r.judgementObservedAt) return;
      const synthetic=new Date(asString(data.end_time));
      let rankContext=r.rankContext || await observedReactionRankContext(tx,{
        examId:exam.id,contestId:exam.platformContestId,teamId:r.teamId,submissionId:r.submissionId,
        judgementId:remoteId,verdict,observedAt:judgementObservedAt,previous:previous?{type:previous.type,remoteId:previous.remoteId,payload:previous.payload,observedAt:previous.observedAt}:null
      });
      if(checkpointOnlyReplay && !r.rankContext) rankContext={...(rankContext as object),status:'UNAVAILABLE',beforeRank:null,afterRank:null,reason:'FINAL_JUDGEMENT_PRECEDED_SUBMISSION_OBSERVATION'};
      await tx.reaction.update({where:{id:r.id},data:{...historyUpdate,verdict,originalVerdict:verdict,judgementId:remoteId,status:'TAIL',
        rankContext:rankContext as Prisma.InputJsonValue,
        judgementObservedAt,sourceJudgementEndAt:Number.isFinite(+synthetic)?synthetic:null,windowEnd:new Date(+judgementObservedAt+config.afterSeconds*1000)}});
      await pinReactionSegments(tx,r.id);
    }
    await tx.reactionConfig.update({where:{examId:exam.id},data:{lastEventAt:observedAt}});
  },{isolationLevel:'ReadCommitted',timeout:15000});
}
