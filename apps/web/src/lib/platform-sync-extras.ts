import { changedCodeReportIds, boundedCodeReportIds, captureCodeReportDeletions, codeReportErrorKey } from './platform-sync-code-report';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { federationTransaction } from './exam-federation-store';
import { captureItem, captureDeletions, acceptItem, itemHash, jsonValue, retainPlatformConflict } from './platform-sync-store';
import { digest, FederationError } from './exam-federation-protocol';
import type { PlatformSyncSettings } from './platform-sync-settings';
import { comparePlatformVersion, type PlatformItem } from './platform-sync-protocol';
import { readScreenControlImage } from './screen-control-images';
import { readPlatformPhoto } from './platform-sync-photo';
import { platformTransaction } from './platform-sync-lock';
import { storeBuffer } from './storage';
import { settleReads } from './request-admission';
import { isSynchronizedPlatformKind } from './platform-sync-policy';

export const EXTRA_KINDS = new Set(['SESSION','PHOTO','SCREEN_GROUP','SCREEN_IMAGE','SCREEN_DISPLAY','CODE_JOB','CODE_SOURCE','CODE_PAIR']);
const fields = {
 PHOTO:['startedAt','endedAt','byteSize','validatedAt','deletedAt'],
 SESSION:['memberStudentId','memberName','status','approvedAt','startedAt','endedAt','revokedAt','lastDesktopSeenAt','lastMiniProgramSeenAt','desktopOfflineAt','miniProgramOfflineAt','lockdown','lockdownReason','unlockNonce','createdAt'],
 SCREEN_GROUP:['name','deletedAt','createdAt'],
 SCREEN_IMAGE:['groupId','name','contentType','byteSize','width','height','order','template','createdAt'],
 SCREEN_DISPLAY:['sequence','groupId','groupName','startsAt','endsAt','stoppedAt','canceledAt','createdAt'],
 CODE_JOB:['status','phase','submissionScope','minTokens','engine','total','read','compared','skipped','groups','completedGroups','resultCount','warnings','startedAt','finishedAt','createdAt'],
 CODE_SOURCE:['jobId','submissionId','actorKey','uid','pid','problemTitle','problemOrder','candidateName','examNumber','lang','code','submittedAt'],
 CODE_PAIR:['jobId','problemTitle','problemOrder','language','firstUid','secondUid','firstSourceId','secondSourceId','firstName','secondName','firstExamNumber','secondExamNumber','similarity','firstSimilarity','secondSimilarity','versions','matches'],
} as const;
type ExtraKind=keyof typeof fields;
// Session history needs no device IDs, token hashes or local alert JSON.
const sessionSelect = {
 id:true,candidateId:true,loginRequestId:true,memberStudentId:true,memberName:true,status:true,
 approvedAt:true,startedAt:true,endedAt:true,revokedAt:true,lastDesktopSeenAt:true,lastMiniProgramSeenAt:true,
 desktopOfflineAt:true,miniProgramOfflineAt:true,lockdown:true,lockdownReason:true,unlockNonce:true,createdAt:true,
} satisfies Prisma.ClientSessionSelect;
const pick=(row:object, names:readonly string[])=>Object.fromEntries(names.map(k=>[k,(row as Record<string,unknown>)[k]]));
type PictureKind='PHOTO'|'SCREEN_IMAGE';
type PictureRow={id:string;objectPath:string;byteSize:number;candidateId?:string|null};
type PictureState={hash?:string;path:string;retryAt?:number;error?:string};
type PreparedPictures=Map<string,{hash:string;path:string;data:string}>;
const pictureKey=(scope:string,kind:string,id:string)=>`platform-image:${digest({scope,kind,id})}`;
const pictureFingerprint=(kind:PictureKind,row:PictureRow)=>digest({metadata:pick(row,fields[kind]),path:row.objectPath});

/** Read at most two images per kind before taking the exam/row locks. */
async function prepareExtraPictures(examId:string,incoming?:PlatformItem):Promise<PreparedPictures>{
 const prepared:PreparedPictures=new Map();
 if(incoming&&(!isSynchronizedPlatformKind(incoming.kind)||(incoming.kind!=='PHOTO'&&incoming.kind!=='SCREEN_IMAGE')))return prepared;
 const exam=await prisma.exam.findUniqueOrThrow({where:{id:examId},select:{examCode:true}});
 const target=incoming?(await prisma.platformSyncItem.findUnique({where:{id:incoming.id},select:{localId:true}}))?.localId||incoming.id.slice(incoming.id.indexOf(':')+1):undefined;
 const [photos,images]=await settleReads([
  isSynchronizedPlatformKind('PHOTO')&&(!incoming||incoming.kind==='PHOTO')?prisma.mediaSegment.findMany({where:{examId,candidateId:{not:null},channel:'IDENTITY_PHOTO',deletedAt:null,validatedAt:{not:null},...(target?{id:target}:{})},orderBy:{id:'asc'}}):[],
  !incoming||incoming.kind==='SCREEN_IMAGE'?prisma.screenControlImage.findMany({where:{group:{examId},...(target?{id:target}:{})},orderBy:{id:'asc'}}):[],
 ]);
 const rows=await prisma.systemSetting.findMany({where:{key:{in:[...photos.map(row=>pictureKey(exam.examCode,'PHOTO',row.id)),...images.map(row=>pictureKey(exam.examCode,'SCREEN_IMAGE',row.id))]}},select:{key:true,value:true}});
 const states=new Map(rows.map(row=>[row.key,row.value as PictureState]));
 for(const [kind,pictures]of [['PHOTO',photos],['SCREEN_IMAGE',images]]as const){
  let count=0,bytes=0;
  for(const row of pictures){
   const key=pictureKey(exam.examCode,kind,row.id),hash=pictureFingerprint(kind,row),state=states.get(key);
   if(state?.hash===hash||(state?.path===row.objectPath&&(state.retryAt||0)>Date.now()))continue;
   if(count&&(count>=2||bytes+row.byteSize>4*1024*1024))break;
   count++;bytes+=row.byteSize;
   let data:string;
   try{
    const cached=await prisma.platformSyncItem.findUnique({where:{scope_kind_localId:{scope:exam.examCode,kind,localId:row.id}},select:{payload:true}});
    const previous=cached?.payload as Record<string,unknown>|undefined;
    if(typeof previous?.data==='string'&&previous.byteSize===row.byteSize&&state?.path===row.objectPath)data=previous.data;
    else{
     const buffer=kind==='PHOTO'?await readPlatformPhoto(row.objectPath,examId,(row as {candidateId:string|null}).candidateId!):await readScreenControlImage(row.objectPath);
     if(buffer.length!==row.byteSize)throw new FederationError('图片大小与元数据不一致');
     data=buffer.toString('base64');
    }
   }catch(error){
    if(typeof(error as {code?:unknown})?.code==='string'&&/^P[0-9]{4}$/.test((error as {code:string}).code))throw error;
    await platformTransaction(async tx=>{
     const value={path:row.objectPath,metadata:jsonValue(pick(row,fields[kind])),retryAt:Date.now()+30_000,error:'图片暂不可读取，已保留元数据等待补传'};
     const errorKey=`platform-image-error:${examId}:${digest(key)}`;
     await tx.systemSetting.upsert({where:{key},create:{key,value},update:{value}});
     await tx.systemSetting.upsert({where:{key:errorKey},create:{key:errorKey,value:{examId,kind,id:row.id}},update:{value:{examId,kind,id:row.id}}});
    });
    continue;
   }
   prepared.set(key,{hash,path:row.objectPath,data});
  }
 }
 return prepared;
}
export async function captureExtras(examId:string,settings:PlatformSyncSettings) {
 const pictures=await prepareExtraPictures(examId);
 return federationTransaction(examId,tx=>captureExtrasInTransaction(tx,examId,settings,undefined,pictures),60_000);
}
export async function captureExtrasInTransaction(tx:Prisma.TransactionClient,examId:string,settings:PlatformSyncSettings,incoming?:PlatformItem,pictures:PreparedPictures=new Map()) {
 const exam=await tx.exam.findUniqueOrThrow({where:{id:examId},include:{federation:true}});
 if(!exam.federation?.managedGlobally||!exam.federation.enabled)return;
 const target=incoming?(await tx.platformSyncItem.findUnique({where:{id:incoming.id},select:{localId:true}}))?.localId||incoming.id.slice(incoming.id.indexOf(':')+1):null;
 const read=<T>(kind:string,load:()=>Promise<T[]>)=>isSynchronizedPlatformKind(kind)&&(!incoming||incoming.kind===kind)?load():Promise.resolve([] as T[]);
 const [sessions,groups,images,displays,jobs,sourceIds,pairIds,candidates,problems,allPhotos]=await Promise.all([
  read('SESSION',()=>tx.clientSession.findMany({where:{examId,...(target?{id:target}:{})},select:sessionSelect})),read('SCREEN_GROUP',()=>tx.screenControlGroup.findMany({where:{examId,deletedAt:null,...(target?{id:target}:{})}})),read('SCREEN_IMAGE',()=>tx.screenControlImage.findMany({where:{group:{examId},...(target?{id:target}:{})},orderBy:{id:'asc'}})),read('SCREEN_DISPLAY',()=>tx.screenControlDisplay.findMany({where:{examId,...(target?{id:target}:{})}})),
  read('CODE_JOB',()=>tx.codeCheckJob.findMany({where:{examId,...(target?{id:target}:{})}})),read('CODE_SOURCE',()=>changedCodeReportIds(tx,examId,exam.examCode,'CODE_SOURCE',target||undefined)),read('CODE_PAIR',()=>changedCodeReportIds(tx,examId,exam.examCode,'CODE_PAIR',target||undefined)),
  tx.candidate.findMany({where:{examId},select:{id:true,syncKey:true}}),tx.examProblem.findMany({where:{examId},select:{id:true,syncKey:true}}),read('PHOTO',()=>tx.mediaSegment.findMany({where:{examId,candidateId:{not:null},channel:'IDENTITY_PHOTO',deletedAt:null,validatedAt:{not:null},...(target?{id:target}:{})},orderBy:{id:'asc'}})),
 ]);
 // Batch journal metadata instead of two or three round trips per session on
 // every poll. Bound SQL parameter lists and preserve rolling-upgrade links.
 const sessionHistory=new Map<string,{payload:Prisma.JsonValue;appliedHash:string|null;deleted:boolean}>();
 for(let offset=0;offset<sessions.length;offset+=256){
  const history=await tx.platformSyncItem.findMany({where:{scope:exam.examCode,kind:'SESSION',localId:{in:sessions.slice(offset,offset+256).map(row=>row.id)}},select:{localId:true,payload:true,appliedHash:true,deleted:true}});
  for(const row of history)if(row.localId)sessionHistory.set(row.localId,row);
 }
 const legacyLogins=new Map<string,string>();
 const loginIds=[...new Set(sessions.flatMap(row=>row.loginRequestId?[row.loginRequestId]:[]))];
 for(let offset=0;offset<loginIds.length;offset+=256){
  const links=await tx.platformSyncItem.findMany({where:{scope:exam.examCode,kind:'LOGIN',localId:{in:loginIds.slice(offset,offset+256)}},select:{localId:true,id:true}});
  for(const row of links)if(row.localId)legacyLogins.set(row.localId,row.id);
 }
 const selectedPairs=await boundedCodeReportIds(tx,exam.examCode,'CODE_PAIR',pairIds,Boolean(incoming));
 const selectedSources=await boundedCodeReportIds(tx,exam.examCode,'CODE_SOURCE',sourceIds,Boolean(incoming));
 const pairs=selectedPairs.length?await tx.codeCheckPair.findMany({where:{job:{examId},id:{in:selectedPairs}}}):[];
 const sources=selectedSources.length?await tx.codeCheckSource.findMany({where:{job:{examId},id:{in:selectedSources}}}):[];
 const candidateKeys=new Map(candidates.map(c=>[c.id,c.syncKey])),problemKeys=new Map(problems.map(p=>[p.id,p.syncKey]));
 const matches=(kind:string,id:string)=>!incoming||(incoming.kind===kind&&id===target);
 const fingerprint=pictureFingerprint;
 const errorPrefix=`platform-image-error:${examId}:`;
 const stateKey=(kind:string,id:string)=>pictureKey(exam.examCode,kind,id);
 const stateRows=await tx.systemSetting.findMany({where:{key:{in:[...allPhotos.map(row=>stateKey('PHOTO',row.id)),...images.map(row=>stateKey('SCREEN_IMAGE',row.id))]}},select:{key:true,value:true}});
 const imageState=new Map(stateRows.map(row=>[row.key,row.value as PictureState]));
 const boundedPictures=<T extends {id:string;objectPath:string;byteSize:number}>(kind:'PHOTO'|'SCREEN_IMAGE',rows:T[])=>{
  let bytes=0;const selected:T[]=[];
  for(const row of rows)if(matches(kind,row.id)&&!(imageState.get(stateKey(kind,row.id))?.path===row.objectPath&&(imageState.get(stateKey(kind,row.id))?.retryAt||0)>Date.now())&&imageState.get(stateKey(kind,row.id))?.hash!==fingerprint(kind,row)){
   if(selected.length&&(selected.length>=2||bytes+row.byteSize>4*1024*1024))break;
   selected.push(row);bytes+=row.byteSize;
  }
  return selected;
 };
 const photos=boundedPictures('PHOTO',allPhotos),selectedImages=boundedPictures('SCREEN_IMAGE',images);
 const pictureData=new Map<string,string>();
 const preparePicture=async(kind:PictureKind,row:PictureRow)=>{
  const key=stateKey(kind,row.id),errorKey=`${errorPrefix}${digest(key)}`;
  const ready=pictures.get(key);
  if(ready&&ready.path===row.objectPath&&ready.hash===fingerprint(kind,row)){
   pictureData.set(key,ready.data);
   await tx.systemSetting.deleteMany({where:{key:errorKey}});
  }else if(incoming&&!incoming.deleted)throw new FederationError('本机图片尚未准备完成或已改变，已保留远端更新等待重试');
 };
 if(incoming&&(incoming.kind==='PHOTO'||incoming.kind==='SCREEN_IMAGE')){
  const entry=imageState.get(stateKey(incoming.kind,target!));
  const current=(incoming.kind==='PHOTO'?allPhotos:images).find(row=>row.id===target);
  if(!incoming.deleted&&entry?.error&&entry.path===current?.objectPath&&(entry.retryAt||0)>Date.now())throw new FederationError('本机图片尚未恢复，等待补传后再比较更新');
 }
 for(const photo of photos)await preparePicture('PHOTO',photo);
 for(const image of selectedImages)await preparePicture('SCREEN_IMAGE',image);
 const staleErrors=await tx.systemSetting.findMany({where:{key:{startsWith:errorPrefix}},select:{key:true,value:true}});
 const photoIds=new Set(allPhotos.map(row=>row.id)),imageIds=new Set(images.map(row=>row.id));
 for(const error of staleErrors){const value=error.value as {kind:string;id:string};if(incoming&&(incoming.kind!==value.kind||value.id!==target))continue;const exists=(value.kind==='PHOTO'?photoIds:imageIds).has(value.id);if(!exists)await tx.systemSetting.deleteMany({where:{key:error.key}});}
 if(incoming?.deleted&&(incoming.kind==='PHOTO'||incoming.kind==='SCREEN_IMAGE')){
  const kind=incoming.kind,row=(kind==='PHOTO'?allPhotos:images).find(row=>row.id===target);
  if(row&&!pictureData.has(stateKey(kind,row.id))){
   // Include rows in read backoff too, not just this batch's prepared pictures.
   const metadata=jsonValue(row),key=`platform-image-history:${digest({examId,kind,id:row.id,metadata})}`;
   await tx.systemSetting.upsert({where:{key},create:{key,value:{examId,kind,id:row.id,metadata,reason:'远端删除前保留的本机图片记录，原文件暂不可读取'}},update:{}});
  }
 }
  for(const[kind,rows]of [['PHOTO',photos],['SESSION',sessions],['SCREEN_GROUP',groups],['SCREEN_IMAGE',selectedImages],['SCREEN_DISPLAY',displays],['CODE_JOB',jobs],['CODE_SOURCE',sources],['CODE_PAIR',pairs]]as const){
   if(!isSynchronizedPlatformKind(kind))continue;
   for(const row of rows){
    if(!matches(kind,row.id))continue;
    if((kind==='PHOTO'||kind==='SCREEN_IMAGE')&&!pictureData.has(stateKey(kind,row.id)))continue;
    const p=pick(row,fields[kind]);
    if(('candidateId'in row&&row.candidateId&&!candidateKeys.get(row.candidateId))||('problemId'in row&&row.problemId&&!problemKeys.get(row.problemId))){
     if(incoming&&!incoming.deleted)throw new FederationError('本机资料的考生或题目映射尚未齐备，已保留远端记录等待重试');
     if(kind==='CODE_SOURCE'||kind==='CODE_PAIR'){
      const key=codeReportErrorKey(exam.examCode,kind,row.id),value={id:row.id,kind,error:'查重资料的考生或题目映射尚未齐备，原始报告已保留'};
      await tx.systemSetting.upsert({where:{key},create:{key,value},update:{value}});
     }
     continue;
    }
    if('candidateId'in row)p.candidateKey=row.candidateId ? candidateKeys.get(row.candidateId) : null;
    if('problemId'in row)p.problemKey=row.problemId?problemKeys.get(row.problemId):null;
    if(kind==='SCREEN_IMAGE'||kind==='PHOTO')p.data=pictureData.get(stateKey(kind,row.id));
    if(kind==='SESSION'){
     // Retain an already journaled opaque link during rolling upgrades so an
     // older peer cannot clear its own approval when receiving its history
     // back. No login request or photograph is captured or sent with it.
     const previous=sessionHistory.get(row.id);
     const legacy=(previous?.payload as {loginKey?:unknown}|undefined)?.loginKey;
     if(typeof legacy==='string')p.loginKey=legacy;
     else if('loginRequestId'in row&&row.loginRequestId)p.loginKey=legacyLogins.get(row.loginRequestId);
    }
    const payload=jsonValue(p);
    if(kind==='SESSION'){
     const previous=sessionHistory.get(row.id);
     if(previous&&(previous.deleted||previous.appliedHash===itemHash(payload)))continue;
    }
    if(kind==='CODE_SOURCE'||kind==='CODE_PAIR'){
     try{
      if(Buffer.byteLength(JSON.stringify(payload))>16*1024*1024-4096)throw new FederationError('单条查重内容超过同步容量');
      itemHash(payload);
     }catch(error){
      if(!(error instanceof FederationError))throw error;
      if(incoming)throw new FederationError('本机查重内容超过同步容量，已保留本机与远端记录等待处理');
      const key=codeReportErrorKey(exam.examCode,kind,row.id),value={id:row.id,kind,error:'单条查重内容超过同步容量，原始报告已保留'};
      await tx.systemSetting.upsert({where:{key},create:{key,value},update:{value}});continue;
     }
    }
    await captureItem(tx,settings.nodeId,exam.examCode,kind,row.id,payload,`${kind.toLowerCase()}:${row.id}`);
    if(kind==='CODE_SOURCE'||kind==='CODE_PAIR')await tx.systemSetting.deleteMany({where:{key:codeReportErrorKey(exam.examCode,kind,row.id)}});
    if((kind==='PHOTO'||kind==='SCREEN_IMAGE')&&'objectPath'in row){const key=stateKey(kind,row.id),value={hash:fingerprint(kind,row),path:row.objectPath};await tx.systemSetting.upsert({where:{key},create:{key,value},update:{value}});}
   }
   if(!incoming||incoming.kind===kind){
    if(incoming)await captureDeletions(tx,settings.nodeId,exam.examCode,kind,new Set((kind==='PHOTO'?allPhotos:kind==='SCREEN_IMAGE'?images:rows).map(r=>r.id)),undefined,target!);
    else if(kind==='CODE_SOURCE'||kind==='CODE_PAIR')await captureCodeReportDeletions(tx,exam.examCode,kind,settings.nodeId);
    else await captureDeletions(tx,settings.nodeId,exam.examCode,kind,new Set((kind==='PHOTO'?allPhotos:kind==='SCREEN_IMAGE'?images:rows).map(r=>r.id)));
   }
  }
}
export async function mergeExtraItem(value:PlatformItem,settings:PlatformSyncSettings,alreadyCaptured=false) {
 if(!isSynchronizedPlatformKind(value.kind))return;
 const exam=await prisma.exam.findUnique({where:{examCode:value.scope},include:{federation:true}});
 if(!exam?.federation?.managedGlobally||!exam.federation.enabled)throw new FederationError('考试同步已暂停，资料将在恢复后补齐');
 if(value.hash!==itemHash(value.payload,value.deleted))throw new FederationError('同步资料校验失败',400);
 const oldItem = await prisma.platformSyncItem.findUnique({ where: { id: value.id } });
 if(oldItem&&(oldItem.scope!==value.scope||oldItem.kind!==value.kind))throw new FederationError('同步资料来源冲突');
 if (oldItem && comparePlatformVersion(oldItem, value) >= 0) { if(comparePlatformVersion(oldItem,value)===0&&oldItem.hash!==value.hash)throw new FederationError('同一版本资料内容不同'); if(oldItem.writer!==value.writer&&oldItem.hash!==value.hash)await platformTransaction(tx=>retainPlatformConflict(tx,value)); return; }
 const kind=value.kind as ExtraKind;
 if(!EXTRA_KINDS.has(kind))throw new FederationError('未知同步资料',400);
 let imagePath:string|undefined;
 if((kind==='SCREEN_IMAGE'||kind==='PHOTO')&&!value.deleted){
  const data=Buffer.from(String(value.payload.data||''),'base64');
  if(data.length!==value.payload.byteSize||data.length>10*1024*1024)throw new FederationError('控屏图片无效',400);
  const object=await storeBuffer(data,{filename:`${value.id.replaceAll(':','-')}-${value.hash}.webp`,contentType:'image/webp',prefix:kind==='PHOTO'?`${exam.id}/${(await prisma.candidate.findFirstOrThrow({where:{examId:exam.id,syncKey:String(value.payload.candidateKey)}})).id}`:`screen-control/${exam.id}/sync`,stableName:true,immutable:true});imagePath=object.objectPath;
 }
 const pictures=await prepareExtraPictures(exam.id,value);
 await federationTransaction(exam.id,async tx=>{
  const current=await tx.examFederation.findUnique({where:{examId:exam.id}});
  if(!current?.managedGlobally||!current.enabled)throw new FederationError('考试同步已暂停，资料将在恢复后补齐');
  const target=(await tx.platformSyncItem.findUnique({where:{id:value.id},select:{localId:true}}))?.localId||value.id.slice(value.id.indexOf(':')+1);
  const tables:Record<string,string>={SESSION:'ClientSession',PHOTO:'MediaSegment',SCREEN_GROUP:'ScreenControlGroup',SCREEN_DISPLAY:'ScreenControlDisplay',CODE_JOB:'CodeCheckJob'};
  const table=tables[kind];
  if(table)await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(table)} WHERE examId = ${exam.id} AND id = ${target} FOR UPDATE`);
  if(kind==='SCREEN_IMAGE')await tx.$queryRaw`SELECT image.id FROM ScreenControlImage image JOIN ScreenControlGroup screen_group ON screen_group.id = image.groupId WHERE screen_group.examId = ${exam.id} AND image.id = ${target} FOR UPDATE`;
  if(kind==='CODE_PAIR'||kind==='CODE_SOURCE'){
   const reportTable=Prisma.raw(kind==='CODE_PAIR'?'CodeCheckPair':'CodeCheckSource');
   // Analysis writes these rows outside the exam lock. Capture the exact local
   // preimage under a row lock, even when it is beyond the next delta page.
   await tx.$queryRaw(Prisma.sql`SELECT entry.id FROM ${reportTable} entry JOIN CodeCheckJob job ON job.id = entry.jobId WHERE job.examId = ${exam.id} AND entry.id = ${target} FOR UPDATE`);
  }
  await captureExtrasInTransaction(tx,exam.id,settings,value,pictures);
  await acceptItem(tx,value,async localId=>{
   const id=localId||value.id.slice(value.id.indexOf(':')+1),p=value.payload;
   const data=pick(p,fields[kind]);for(const[k,v]of Object.entries(data))if(k.endsWith('At')&&typeof v==='string')data[k]=new Date(v);
   const candidate= p.candidateKey ? await tx.candidate.findFirst({where:{examId:exam.id,syncKey:String(p.candidateKey)}}):null;
   const problem= p.problemKey ? await tx.examProblem.findFirst({where:{examId:exam.id,syncKey:String(p.problemKey)}}):null;
   if(!value.deleted&&p.candidateKey&&!candidate)throw new FederationError('考生资料尚未同步');
   if(!value.deleted&&p.problemKey&&!problem)throw new FederationError('题目资料尚未同步');
   if(kind==='PHOTO'){
    const old=await tx.mediaSegment.findUnique({where:{id}});if(old&&(old.examId!==exam.id||old.channel!=='IDENTITY_PHOTO'))throw new FederationError('身份照片来源或媒体类型冲突');
    if(value.deleted){if(old)await tx.mediaSegment.update({where:{id},data:{deletedAt:new Date()}});return{localId:id};}
    const body={...data,examId:exam.id,candidateId:candidate!.id,channel:'IDENTITY_PHOTO',objectPath:imagePath!}as Prisma.MediaSegmentUncheckedCreateInput;
    if(old)await tx.mediaSegment.update({where:{id},data:body});else await tx.mediaSegment.create({data:{...body,id}});return{localId:id};
   }
   if(kind==='SESSION'){
    const old=await tx.clientSession.findUnique({where:{id}});if(old&&old.examId!==exam.id)throw new FederationError('会话来源冲突');
    if(value.deleted){if(old)await tx.clientSession.delete({where:{id}});return{localId:id};}
    if(old&&candidate&&old.candidateId!==candidate.id)throw new FederationError('会话考生身份不允许改写');
    // Older peers may still send loginKey. Imported history must not depend
    // on a remote approval, or replace a local session's own approval link.
    const body={...data,examId:exam.id,candidateId:candidate!.id}as Prisma.ClientSessionUncheckedCreateInput;
    if(old)await tx.clientSession.update({where:{id},data:body});else await tx.clientSession.create({data:{...body,id,syncImported:true}});return{localId:id};
   }
   if(kind==='SCREEN_GROUP'){
    const old=await tx.screenControlGroup.findUnique({where:{id}});if(old&&old.examId!==exam.id)throw new FederationError('控屏分组来源冲突');
    if(value.deleted){if(old)await tx.screenControlGroup.update({where:{id},data:{deletedAt:new Date()}});return{localId:id};}
    const body={...data,examId:exam.id}as Prisma.ScreenControlGroupUncheckedCreateInput;
    await tx.screenControlGroup.upsert({where:{id},create:{...body,id},update:body});return{localId:id};
   }
   if(kind==='SCREEN_IMAGE'||kind==='SCREEN_DISPLAY'){
    if(!value.deleted&&!await tx.screenControlGroup.findFirst({where:{id:String(p.groupId),examId:exam.id}}))throw new FederationError('控屏分组尚未同步');
    if(kind==='SCREEN_IMAGE'){
     if(value.deleted){await tx.screenControlImage.deleteMany({where:{id,group:{examId:exam.id}}});return{localId:id};}
     const old=await tx.screenControlImage.findFirst({where:{id,group:{examId:exam.id}}});const body={...data,objectPath:imagePath!}as Prisma.ScreenControlImageUncheckedCreateInput;
     if(old)await tx.screenControlImage.update({where:{id},data:body});else await tx.screenControlImage.create({data:{...body,id}});return{localId:id};
    }
    if(value.deleted){await tx.screenControlDisplay.deleteMany({where:{id,examId:exam.id}});return{localId:id};}
    const body={...data,examId:exam.id}as Prisma.ScreenControlDisplayUncheckedCreateInput;
    const old=await tx.screenControlDisplay.findFirst({where:{id,examId:exam.id}});if(old)await tx.screenControlDisplay.update({where:{id},data:body});else await tx.screenControlDisplay.create({data:{...body,id}});return{localId:id};
   }
   if(kind==='CODE_JOB'){
    const old=await tx.codeCheckJob.findUnique({where:{id}});if(old&&old.examId!==exam.id)throw new FederationError('查重报告来源冲突');
    if(value.deleted){if(old)await tx.codeCheckJob.delete({where:{id}});return{localId:id};}
    const body={...data,examId:exam.id,problemId:problem?.id||null}as Prisma.CodeCheckJobUncheckedCreateInput;
    if(old)await tx.codeCheckJob.update({where:{id},data:body});else await tx.codeCheckJob.create({data:{...body,id,createdById:exam.createdById||'',syncImported:true}});return{localId:id};
   }
   if(!value.deleted&&!await tx.codeCheckJob.findFirst({where:{id:String(p.jobId),examId:exam.id}}))throw new FederationError('查重报告尚未同步');
   if(kind==='CODE_SOURCE'){
    if(value.deleted){await tx.codeCheckSource.deleteMany({where:{id,job:{examId:exam.id}}});return{localId:id};}
    const body={...data,candidateId:candidate!.id,problemId:problem!.id}as Prisma.CodeCheckSourceUncheckedCreateInput;
    const old=await tx.codeCheckSource.findFirst({where:{id,job:{examId:exam.id}}});if(old)await tx.codeCheckSource.update({where:{id},data:body});else await tx.codeCheckSource.create({data:{...body,id}});return{localId:id};
   }
   if(value.deleted){await tx.codeCheckPair.deleteMany({where:{id,job:{examId:exam.id}}});return{localId:id};}
   const body={...data,problemId:problem!.id}as Prisma.CodeCheckPairUncheckedCreateInput;
   const old=await tx.codeCheckPair.findFirst({where:{id,job:{examId:exam.id}}});if(old)await tx.codeCheckPair.update({where:{id},data:body});else await tx.codeCheckPair.create({data:{...body,id}});return{localId:id};
  });
 },60_000);
}
