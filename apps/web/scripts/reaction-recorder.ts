import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { ccsCredential, readNdjson } from '../src/lib/reaction-domain';
import { acceptReactionEvent } from '../src/lib/reaction-events';
import { maintainReactionCache } from '../src/lib/reaction-retention';
import { captureReaction, generateStoredReaction } from '../src/lib/reaction-media';
import { beginReactionRankingSnapshot, completeReactionRankingSnapshot, rankingEventTypes } from '../src/lib/reaction-ranking';
import type { CcsEvent } from '../src/lib/reaction-domain';
import { createHydroReactionPollState, pollHydroReactions, type HydroReactionPollState } from '../src/lib/reaction-hydro-recorder';
import { consumeHydroCcsFeed } from '../src/lib/reaction-hydro-ccs';
import { reactionSource } from '../src/lib/reaction-source';
import { processFileDeletions } from '../src/lib/file-deletion';

const token=crypto.randomUUID();
const feeds=new Map<string,AbortController>();
const deleting=new Set<string>();
const readyExams=new Set<string>();
let stopped=false, mediaBusy=false;
let mediaWake: ReturnType<typeof setTimeout> | undefined;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const jobError=(error:unknown,fallback:string)=>error instanceof Error && /^REACTION_(STORAGE_LIMIT|JOB_CANCELLED|STORAGE_ACCOUNTING_UNINITIALIZED|GENERATOR_[A-Z_0-9]+)$/.test(error.message)?error.message:fallback;
async function feed(examId:string,controller:AbortController) {
  let backoff=1000;
  let hydroState:HydroReactionPollState|undefined;
  let hydro=false;
  while(!controller.signal.aborted) {
    try {
      const exam=await prisma.exam.findUniqueOrThrow({where:{id:examId},include:{reactionConfig:true}});
      if(!exam.reactionEnabled || !exam.reactionConfig || exam.reactionConfig.leaseToken!==token) break;
      hydro=exam.platform!=='NOVAJUDGE';
      if(hydro) {
        if(!exam.reactionConfig.initializedAt) {
          exam.reactionConfig=await prisma.reactionConfig.update({where:{examId},data:{initializedAt:new Date()}});
        }
        if(reactionSource(exam)==='HYDRO_CONTEST') {
          await prisma.reactionConfig.update({where:{examId},data:{feedStatus:'CONNECTING',lastError:null}});
          await consumeHydroCcsFeed(exam,controller.signal,async()=>{
            await prisma.reactionConfig.updateMany({where:{examId,leaseToken:token},data:{feedStatus:'CONNECTED',lastError:null}});
            backoff=1000;
          });
          continue;
        }
        if(!hydroState || hydroState.cutover!==+exam.reactionConfig.initializedAt!) {
          await prisma.reactionConfig.update({where:{examId},data:{feedStatus:'CONNECTING',lastError:null}});
          hydroState=await createHydroReactionPollState(exam);
        }
        await pollHydroReactions(exam,controller.signal,hydroState);
        await prisma.reactionConfig.updateMany({where:{examId,leaseToken:token},data:{feedStatus:'CONNECTED',lastError:null}});
        backoff=1000;
        await delay(2000);
        continue;
      }
      const credentials=ccsCredential(exam);
      const base=`${credentials.origin}/api/ccs/contests/${encodeURIComponent(exam.platformContestId)}/event-feed?runs=false`;
      await prisma.reactionConfig.update({where:{examId},data:{feedStatus:'CONNECTING',lastError:null}});
      {
        // A fresh complete baseline is required on every connection. Events
        // caught up across a disconnect cannot claim historical live ranks.
        await beginReactionRankingSnapshot(prisma,examId);
        const baselineAt=new Date();
        const snapshot=await fetch(`${base}&stream=false`,{headers:{authorization:credentials.authorization},redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
        if(!snapshot.ok||!snapshot.body) throw new Error(`CCS_HTTP_${snapshot.status}`);
        // Establish the cutover before applying the snapshot: a submission
        // created while the HTTP snapshot is being built is already live.
        // acceptReactionEvent ignores older source times and processes newer
        // ones atomically, so the stream replay cannot permanently swallow it.
        if(!exam.reactionConfig.initializedAt) exam.reactionConfig=await prisma.reactionConfig.update({where:{examId},data:{initializedAt:baselineAt}});
        const rankingSnapshot:CcsEvent[]=[];
        for await(const e of readNdjson(snapshot.body)) {
          await acceptReactionEvent(exam,e,new Date());
          if((rankingEventTypes as readonly string[]).includes(e.type)) rankingSnapshot.push(e);
        }
        await completeReactionRankingSnapshot(prisma,examId,rankingSnapshot);
      }
      const response=await fetch(base,{headers:{authorization:credentials.authorization},redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
      if(!response.ok||!response.body) throw new Error(`CCS_HTTP_${response.status}`);
      await prisma.reactionConfig.update({where:{examId},data:{feedStatus:'CONNECTED',lastError:null}});backoff=1000;
      for await(const e of readNdjson(response.body)) {
        await acceptReactionEvent(exam,e,new Date());
      }
      if(!controller.signal.aborted) throw new Error('CCS_STREAM_CLOSED');
    } catch(error) {
      if(controller.signal.aborted) break;
      if(!hydro) await beginReactionRankingSnapshot(prisma,examId);
      // Never persist remote bodies/URLs/Authorization in diagnostics.
      const message=error instanceof Error && /^(CCS_HTTP_\d+|HYDRO_HTTP_\d+|REACTION_HYDRO_(CCS_)?CONFIGURATION)$/.test(error.message)?error.message:hydro?'HYDRO_DISCONNECTED_OR_INVALID_RECORD':'CCS_DISCONNECTED_OR_INVALID_EVENT';
      await prisma.reactionConfig.updateMany({where:{examId,leaseToken:token},data:{feedStatus:'RECONNECTING',lastError:message}});
      await delay(backoff);backoff=Math.min(30000,backoff*2);
    }
  }
}
async function mediaJob(): Promise<boolean> {
    const examIds = [...readyExams];
    if (!examIds.length) return false;
    const [ready]=await prisma.$queryRaw<{ id: string; submissionId: string; windowEnd: Date }[]>`
      SELECT r.id, r.submissionId, r.windowEnd
      FROM Reaction r JOIN ReactionConfig c ON c.examId = r.examId
      WHERE r.examId IN (${Prisma.join(examIds)})
        AND r.status = 'TAIL' AND c.leaseToken = ${token} AND c.leaseUntil > ${new Date()}
        AND TIMESTAMPADD(SECOND, c.uploadGraceSeconds, r.windowEnd) <= ${new Date()}
      ORDER BY r.createdAt LIMIT 1`;
    if(ready) {
      if((await prisma.reaction.updateMany({where:{id:ready.id,status:'TAIL',windowEnd:ready.windowEnd,exam:{reactionConfig:{leaseToken:token,leaseUntil:{gt:new Date()}}}},data:{status:'CAPTURING'}})).count) {
        try {await captureReaction(ready.id);console.log(`[reaction] saved ${ready.submissionId}`);}
        catch(error) {const code=jobError(error,'CAPTURE_FAILED_CHECK_MEDIA_INPUTS');await prisma.reaction.updateMany({where:{id:ready.id,status:'CAPTURING'},data:{status:'FAILED',error:code,finalizedAt:new Date()}});console.error(`[reaction] capture ${ready.submissionId}: ${code}`);}
      }
      return true;
    }
    const queued=await prisma.reaction.findFirst({where:{examId:{in:examIds},generationStatus:'QUEUED',status:{in:['COMPLETE','PARTIAL']},exam:{reactionConfig:{leaseToken:token,leaseUntil:{gt:new Date()}}}},orderBy:{createdAt:'asc'}});
    if(queued && (await prisma.reaction.updateMany({where:{id:queued.id,status:queued.status,generationStatus:'QUEUED',exam:{reactionConfig:{leaseToken:token,leaseUntil:{gt:new Date()}}}},data:{generationStatus:'RUNNING'}})).count) {
      try {await generateStoredReaction(queued.id);console.log(`[reaction] generated ${queued.submissionId}`);}
      catch(error) {const code=jobError(error,'GENERATOR_FAILED_CHECK_INSTALLATION_OR_INPUTS');await prisma.reaction.updateMany({where:{id:queued.id,status:queued.status,generationStatus:'RUNNING'},data:{generationStatus:'FAILED',generationError:code}});console.error(`[reaction] generation ${queued.submissionId}: ${code}`);}
      return true;
    }
    return false;
}
function scheduleMediaJob(waitMs = 0) {
  if (stopped || mediaBusy || mediaWake) return;
  mediaWake = setTimeout(async () => {
    mediaWake = undefined;
    if (stopped) return;
    mediaBusy = true;
    let processed = false;
    try { processed = await mediaJob(); }
    catch { console.error('[reaction] media queue unavailable'); }
    finally { mediaBusy = false; }
    scheduleMediaJob(processed ? 0 : 2000);
  }, waitMs);
}
async function tick() {
  const exams=await prisma.exam.findMany({where:{reactionConfig:{isNot:null}},include:{reactionConfig:true}});
  for(const exam of exams) {
    const c=exam.reactionConfig!;
    const claimed=await prisma.reactionConfig.updateMany({where:{examId:exam.id,OR:[{leaseToken:token},{leaseUntil:null},{leaseUntil:{lt:new Date()}}]},data:{leaseToken:token,leaseUntil:new Date(Date.now()+60000)}});
    if(!claimed.count) { readyExams.delete(exam.id); continue; }
    if(c.leaseToken!==token || !readyExams.has(exam.id)) {
      readyExams.delete(exam.id);
      // Resume interrupted jobs after a dead worker's lease expires.
      await prisma.reaction.updateMany({where:{examId:exam.id,status:'CAPTURING'},data:{status:'TAIL'}});
      await prisma.reaction.updateMany({where:{examId:exam.id,generationStatus:'RUNNING'},data:{generationStatus:'QUEUED'}});
      await prisma.reaction.updateMany({where:{examId:exam.id,reservedBytes:{gt:0}},data:{reservedBytes:0n}});
    }
    readyExams.add(exam.id);
    if(exam.reactionEnabled&&!feeds.has(exam.id)) {const controller=new AbortController();feeds.set(exam.id,controller);void feed(exam.id,controller).finally(()=>feeds.delete(exam.id));}
    if(!exam.reactionEnabled) {feeds.get(exam.id)?.abort();await prisma.reactionConfig.update({where:{examId:exam.id},data:{feedStatus:'STOPPED'}});}
    await maintainReactionCache(exam.id, false);
    // A backlog of slow storage deletions must not hold up media jobs or leases.
    if (!deleting.has(exam.id)) {
      deleting.add(exam.id);
      void processFileDeletions({ examId: exam.id }, 100)
        .catch(() => console.error('[reaction] file deletion will retry'))
        .finally(() => deleting.delete(exam.id));
    }
  }
}
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{stopped=true;for(const c of feeds.values())c.abort();});
console.log('[reaction] recorder started; single FFmpeg job; credentials stay server-side');
scheduleMediaJob();
while(!stopped) {try{await tick();}catch{console.error('[reaction] maintenance unavailable; will retry');}await delay(2000);}
clearTimeout(mediaWake);
while(mediaBusy) await delay(200);
await prisma.reactionConfig.updateMany({where:{leaseToken:token},data:{leaseUntil:null,leaseToken:null,feedStatus:'STOPPED'}});
await prisma.$disconnect();
