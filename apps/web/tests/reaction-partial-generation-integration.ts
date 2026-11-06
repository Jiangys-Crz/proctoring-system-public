/** Isolated synthetic media/DB generation test. Never uses a user recording or contest. */
import assert from 'node:assert/strict';
import { randomInt,randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp,mkdir,readFile,writeFile,rm,realpath,stat } from 'node:fs/promises';
import { prisma } from '../src/lib/db';
import sharp from 'sharp';
import { generateStoredReaction,materializeReactionObject,probeReactionVideo,runMedia } from '../src/lib/reaction-media';
import { queueReactionGeneration } from '../src/lib/reaction-admin';
import { reserveReactionOutput } from '../src/lib/reaction-storage-budget';
import { deleteStoredObject,storeBuffer,storedObjectExists } from '../src/lib/storage';
import { eventHash } from '../src/lib/reaction-domain';
const database=new URL(process.env.DATABASE_URL||'mysql://invalid/invalid');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(database.hostname));assert.match(database.pathname,/^\/reaction_e2e(?:_|$)/);
const output=path.resolve(process.env.REACTION_PARTIAL_TEST_OUTPUT||'.local/reaction-partial-generation-test');await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(os.tmpdir(),'reaction-partial-test-'));
const fixture=randomUUID(),keys:string[]=[];let examId:string|undefined;
const results:unknown[]=[];
try {
 const start=new Date('2026-11-04T00:00:00Z'),end=new Date(+start+4000);
 const exam=await prisma.exam.create({data:{examCode:String(randomInt(1_000_000_000,10_000_000_000)),name:`Partial generation module ${fixture}`,startAt:start,latestStartAt:end,endAt:end,durationMinutes:1,platform:'NOVAJUDGE',platformBaseUrl:'http://127.0.0.1:3001',platformContestId:`partial-${fixture}`,contestType:'TEAM',rules:'Synthetic isolated module test',reactionEnabled:false,reactionConfig:{create:{leaseToken:fixture,leaseUntil:new Date(Date.now()+3600000),autoGenerate:false}}}});examId=exam.id;
 await prisma.candidate.create({data:{examId:exam.id,examNumber:'synthetic',name:'Personal Name 123',teamName:null,password:randomUUID(),seatNo:'fixture-only'}});
 const teamPayload={id:'synthetic',name:'可信测试队名'};
 await prisma.reactionEvent.create({data:{examId:exam.id,type:'teams',remoteId:'synthetic',payload:teamPayload,payloadHash:eventHash(teamPayload)}});
 const raw:Record<string,{key:string;bytes:number}>={};
 for(const [kind,duration,color] of [['camera',3,'red'],['desktop',2,'blue']] as const) {
  const input=path.join(temporary,`${kind}.mp4`);
  await runMedia(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=320x180:r=25:d=${duration}`,'-an','-c:v','libx264','-threads','2','-bf','0','-pix_fmt','yuv420p',input]);
  const buffer=await readFile(input);const stored=await storeBuffer(buffer,{prefix:`reaction-partial-tests/${fixture}`,filename:`${kind}.mp4`,stableName:true,contentType:'video/mp4'});keys.push(stored.objectPath);raw[kind]={key:stored.objectPath,bytes:buffer.length};
 }
 const diagnostics={status:'PARTIAL',incompleteReason:'VIDEO_FRAME_CADENCE_INCOMPLETE',channels:{DESKTOP_CAMERA:{complete:false,issues:['FRAME_CADENCE_INCOMPLETE:synthetic'],gaps:[{from:1,to:2}]},DESKTOP_SCREEN:{complete:true,issues:[],gaps:[]}}};
 const originalMetadata=Buffer.from(JSON.stringify(diagnostics));
 const stored=await storeBuffer(originalMetadata,{prefix:`reaction-partial-tests/${fixture}`,filename:'metadata.json',stableName:true,contentType:'application/json'});keys.push(stored.objectPath);
 const base={examId:exam.id,contestId:exam.platformContestId,teamId:'synthetic',teamName:'Old personal-name snapshot 123',problemId:'p',problemLabel:'A',sourceSubmittedAt:start,submissionObservedAt:start,judgementObservedAt:new Date(+start+3000),windowStart:start,windowEnd:end,verdict:'AC',originalVerdict:'AC'};
 const partial=await prisma.reaction.create({data:{...base,submissionId:`partial-${fixture}`,status:'PARTIAL',error:diagnostics.incompleteReason,cameraPath:raw.camera.key,desktopPath:raw.desktop.key,metadataPath:stored.objectPath,outputBytes:BigInt(raw.camera.bytes+raw.desktop.bytes+originalMetadata.length)}});
 const missing=await prisma.reaction.create({data:{...base,submissionId:`missing-${fixture}`,status:'MISSING',cameraPath:raw.camera.key,desktopPath:raw.desktop.key}});
 const oneSide=await prisma.reaction.create({data:{...base,submissionId:`one-side-${fixture}`,status:'PARTIAL',cameraPath:raw.camera.key}});
 const expired=await prisma.reaction.create({data:{...base,submissionId:`expired-${fixture}`,status:'EXPIRED',cameraPath:raw.camera.key,desktopPath:raw.desktop.key}});
 assert.equal((await queueReactionGeneration(exam.id,[partial.id,missing.id,oneSide.id,expired.id])).queued,1);
 await assert.rejects(generateStoredReaction(oneSide.id),/PLAYABLE_INPUTS_REQUIRED/);
 await assert.rejects(generateStoredReaction(missing.id),/PLAYABLE_INPUTS_REQUIRED/);
 await assert.rejects(reserveReactionOutput(expired.id,1n),/JOB_CANCELLED/);
 results.push({test:'PARTIAL two-source gate; MISSING/EXPIRED/one-sided rejected',passed:true});
 await generateStoredReaction(partial.id);
 let saved=await prisma.reaction.findUniqueOrThrow({where:{id:partial.id}});
 assert.equal(saved.status,'PARTIAL');assert.equal(saved.error,diagnostics.incompleteReason);assert.equal(saved.generationStatus,'COMPLETE');assert.equal(saved.reservedBytes,0n);
 assert.ok(saved.reactionPath&&saved.metadataPath);keys.push(saved.reactionPath,saved.metadataPath);
 const video=path.join(output,'synthetic-partial.mp4'),metadataFile=path.join(output,'metadata.json');
 await materializeReactionObject(saved.reactionPath,video);await materializeReactionObject(saved.metadataPath,metadataFile);
 const metadata=JSON.parse(await readFile(metadataFile,'utf8'));assert.deepEqual(metadata.channels,diagnostics.channels);assert.equal(metadata.status,'PARTIAL');assert.equal(metadata.incompleteReason,diagnostics.incompleteReason);
 assert.equal(metadata.generation.degraded,true);assert.equal(metadata.generation.sourceStatus,'PARTIAL');assert.equal(metadata.generation.generationWindow.selectedDurationSeconds,2);assert.equal(metadata.generation.generationWindow.judgementIncluded,false);
 assert.equal(metadata.generation.teamName,'可信测试队名');assert.equal(metadata.generation.teamNameSource,'CCS_TEAM_NAME');
 assert.equal(metadata.teamName,'可信测试队名');assert.equal(metadata.originalTeamNameSnapshot,base.teamName);
 assert.equal(metadata.generation.selectedWindowEnd,new Date(+start+2000).toISOString());
 const probe=await probeReactionVideo(video);assert.equal(probe.duration,2);assert.equal(probe.width,1080);assert.equal(probe.height,1920);
 const av=JSON.parse(await runMedia(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_streams','-of','json',video]));assert.equal(av.streams.filter((s:{codec_type:string})=>s.codec_type==='audio').length,0,'Out-of-range verdict sound omitted');
 const frame=path.join(output,'waiting-frame.png');await runMedia(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-y','-ss','1.5','-i',video,'-frames:v','1',frame]);
 // Uniform card background at this point must remain the official pending yellow.
 const pixel=await sharp(frame).extract({left:100,top:1090,width:2,height:2}).removeAlpha().raw().toBuffer();
 assert.ok(pixel[0]>180&&pixel[1]>100&&pixel[2]<80,`Out-of-window judgement must show pending yellow, not a verdict colour; RGB=${Array.from(pixel.subarray(0,3))}`);
 results.push({test:'Real official CLI trims 3s/2s/4s to2s; keeps PARTIAL and diagnostics; out-of-range result stays waiting yellow without audio; verified CCS team name replaces personal-name snapshot',passed:true,probe});
 const previous=saved.reactionPath;assert.equal((await queueReactionGeneration(exam.id,[partial.id])).queued,1);await generateStoredReaction(partial.id);
 saved=await prisma.reaction.findUniqueOrThrow({where:{id:partial.id}});assert.equal(saved.status,'PARTIAL');assert.equal(saved.generationStatus,'COMPLETE');assert.equal(saved.reservedBytes,0n);assert.notEqual(saved.reactionPath,previous);assert.equal(await storedObjectExists(previous,128),false);
 assert.ok(saved.reactionPath&&saved.metadataPath);keys.push(saved.reactionPath,saved.metadataPath);
 const currentVideo=path.join(temporary,'current.mp4'),currentMeta=path.join(temporary,'current.json');await materializeReactionObject(saved.reactionPath,currentVideo);await materializeReactionObject(saved.metadataPath,currentMeta);
 const regeneratedMetadata=JSON.parse(await readFile(currentMeta,'utf8'));assert.equal(regeneratedMetadata.originalTeamNameSnapshot,base.teamName);assert.equal(regeneratedMetadata.teamName,'可信测试队名');
 assert.equal(saved.outputBytes,BigInt(raw.camera.bytes+raw.desktop.bytes+(await stat(currentVideo)).size+(await stat(currentMeta)).size));
 results.push({test:'PARTIAL regeneration CAS publishes a new result, preserves raw inputs/status, releases budget and deletes replaced result',passed:true});
 await writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,scope:'synthetic media/isolated DB; no user video or contest touched',results},null,2));console.log(JSON.stringify({passed:true,results}));
} finally {
 if(examId){const rows=await prisma.reaction.findMany({where:{examId}});keys.push(...rows.flatMap(r=>[r.cameraPath,r.desktopPath,r.reactionPath,r.metadataPath]).filter((k):k is string=>Boolean(k)));await prisma.reaction.deleteMany({where:{examId}});await prisma.reactionEvent.deleteMany({where:{examId}});await prisma.exam.delete({where:{id:examId}});}
 for(const key of new Set(keys))await deleteStoredObject(key);
 const checked=await realpath(temporary),parent=await realpath(os.tmpdir());assert.equal(path.dirname(checked),parent);assert.ok(path.basename(checked).startsWith('reaction-partial-test-'));await rm(checked,{recursive:true,force:true});await prisma.$disconnect();
}
