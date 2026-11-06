import crypto from 'node:crypto';
import { prisma } from '../src/lib/db';
import { ccsCredential, readNdjson } from '../src/lib/reaction-domain';
import { acceptReactionEvent } from '../src/lib/reaction-events';
import { maintainReactionCache } from '../src/lib/reaction-retention';
import { captureReaction, generateStoredReaction } from '../src/lib/reaction-media';
import { beginReactionRankingSnapshot, completeReactionRankingSnapshot, rankingEventTypes } from '../src/lib/reaction-ranking';
import type { CcsEvent } from '../src/lib/reaction-domain';

const token=crypto.randomUUID();
const feeds=new Map<string,AbortController>();
let stopped=false, mediaBusy=false;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const jobError=(error:unknown,fallback:string)=>error instanceof Error && /^REACTION_(STORAGE_LIMIT|JOB_CANCELLED|STORAGE_ACCOUNTING_UNINITIALIZED|GENERATOR_[A-Z_0-9]+)$/.test(error.message)?error.message:fallback;
async function feed(examId:string,controller:AbortController) {
  let backoff=1000;
  while(!controller.signal.aborted) {
    try {
      const exam=await prisma.exam.findUniqueOrThrow({where:{id:examId},include:{reactionConfig:true}});
      if(!exam.reactionEnabled || !exam.reactionConfig || exam.reactionConfig.leaseToken!==token) break;
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
        if(!exam.reactionConfig.initializedAt) await prisma.reactionConfig.update({where:{examId},data:{initializedAt:baselineAt}});
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
      await beginReactionRankingSnapshot(prisma,examId);
      // Never persist remote bodies/URLs/Authorization in diagnostics.
      const message=error instanceof Error && /^CCS_HTTP_\d+$/.test(error.message)?error.message:'CCS_DISCONNECTED_OR_INVALID_EVENT';
      await prisma.reactionConfig.updateMany({where:{examId,leaseToken:token},data:{feedStatus:'RECONNECTING',lastError:message}});
      await delay(backoff);backoff=Math.min(30000,backoff*2);
    }
  }
}
async function mediaJob() {
  if(mediaBusy) return;mediaBusy=true;
  try {
    const ready=await prisma.reaction.findFirst({where:{status:'TAIL',windowEnd:{lt:new Date()},exam:{reactionConfig:{leaseToken:token}}},include:{exam:{include:{reactionConfig:true}}},orderBy:{createdAt:'asc'}});
    if(ready && ready.windowEnd && Date.now()>+ready.windowEnd+(ready.exam.reactionConfig?.uploadGraceSeconds||30)*1000) {
      if((await prisma.reaction.updateMany({where:{id:ready.id,status:'TAIL'},data:{status:'CAPTURING'}})).count) {
        try {await captureReaction(ready.id);console.log(`[reaction] saved ${ready.submissionId}`);}
        catch(error) {const code=jobError(error,'CAPTURE_FAILED_CHECK_MEDIA_INPUTS');await prisma.reaction.updateMany({where:{id:ready.id,status:'CAPTURING'},data:{status:'FAILED',error:code,finalizedAt:new Date()}});console.error(`[reaction] capture ${ready.submissionId}: ${code}`);}
      }
      return;
    }
    const queued=await prisma.reaction.findFirst({where:{generationStatus:'QUEUED',status:{in:['COMPLETE','PARTIAL']},exam:{reactionConfig:{leaseToken:token}}},orderBy:{createdAt:'asc'}});
    if(queued && (await prisma.reaction.updateMany({where:{id:queued.id,status:queued.status,generationStatus:'QUEUED'},data:{generationStatus:'RUNNING'}})).count) {
      try {await generateStoredReaction(queued.id);console.log(`[reaction] generated ${queued.submissionId}`);}
      catch(error) {const code=jobError(error,'GENERATOR_FAILED_CHECK_INSTALLATION_OR_INPUTS');await prisma.reaction.updateMany({where:{id:queued.id,status:queued.status,generationStatus:'RUNNING'},data:{generationStatus:'FAILED',generationError:code}});console.error(`[reaction] generation ${queued.submissionId}: ${code}`);}
    }
  } finally {mediaBusy=false;}
}
async function tick() {
  const exams=await prisma.exam.findMany({where:{reactionConfig:{isNot:null}},include:{reactionConfig:true}});
  for(const exam of exams) {
    const c=exam.reactionConfig!;
    const claimed=await prisma.reactionConfig.updateMany({where:{examId:exam.id,OR:[{leaseToken:token},{leaseUntil:null},{leaseUntil:{lt:new Date()}}]},data:{leaseToken:token,leaseUntil:new Date(Date.now()+60000)}});
    if(!claimed.count) continue;
    if(c.leaseToken!==token) {
      // Resume interrupted jobs after a dead worker's lease expires.
      await prisma.reaction.updateMany({where:{examId:exam.id,status:'CAPTURING'},data:{status:'TAIL'}});
      await prisma.reaction.updateMany({where:{examId:exam.id,generationStatus:'RUNNING'},data:{generationStatus:'QUEUED'}});
      await prisma.reaction.updateMany({where:{examId:exam.id,reservedBytes:{gt:0}},data:{reservedBytes:0n}});
    }
    if(exam.reactionEnabled&&!feeds.has(exam.id)) {const controller=new AbortController();feeds.set(exam.id,controller);void feed(exam.id,controller).finally(()=>feeds.delete(exam.id));}
    if(!exam.reactionEnabled) {feeds.get(exam.id)?.abort();await prisma.reactionConfig.update({where:{examId:exam.id},data:{feedStatus:'STOPPED'}});}
    await maintainReactionCache(exam.id);
  }
  void mediaJob().catch(()=>console.error('[reaction] media queue unavailable'));
}
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{stopped=true;for(const c of feeds.values())c.abort();});
console.log('[reaction] recorder started; single FFmpeg job; credentials stay server-side');
while(!stopped) {try{await tick();}catch{console.error('[reaction] maintenance unavailable; will retry');}await delay(2000);}
while(mediaBusy) await delay(200);
await prisma.reactionConfig.updateMany({where:{leaseToken:token},data:{leaseUntil:null,leaseToken:null,feedStatus:'STOPPED'}});
await prisma.$disconnect();
