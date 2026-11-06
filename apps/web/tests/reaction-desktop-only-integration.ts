/** Actual official renderer + isolated local DB, using synthetic footage only. */
import assert from 'node:assert/strict';
import { randomInt,randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp,mkdir,readFile,writeFile,rm,realpath,stat } from 'node:fs/promises';
import { prisma } from '../src/lib/db';
import { generateStoredReaction,materializeReactionObject,probeReactionVideo,runMedia } from '../src/lib/reaction-media';
import { queueReactionGeneration } from '../src/lib/reaction-admin';
import { deleteStoredObject,storeBuffer } from '../src/lib/storage';
const database=new URL(process.env.DATABASE_URL||'mysql://invalid/invalid');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(database.hostname));assert.match(database.pathname,/^\/reaction_e2e(?:_|$)/);
const output=path.resolve(process.env.REACTION_DESKTOP_ONLY_TEST_OUTPUT||'.local/reaction-desktop-only-test');await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(os.tmpdir(),'reaction-desktop-only-test-'));
const fixture=randomUUID(),keys:string[]=[];let examId:string|undefined;
const results:unknown[]=[];
async function stored(name:string,buffer:Buffer){const saved=await storeBuffer(buffer,{prefix:`reaction-desktop-only-tests/${fixture}`,filename:name,stableName:true,contentType:name.endsWith('.json')?'application/json':'video/mp4'});keys.push(saved.objectPath);return {key:saved.objectPath,bytes:buffer.length};}
try {
 const start=new Date('2026-11-04T00:00:00Z'),end=new Date(+start+4000);
 const exam=await prisma.exam.create({data:{examCode:String(randomInt(1_000_000_000,10_000_000_000)),name:`Desktop-only module ${fixture}`,startAt:start,latestStartAt:end,endAt:end,durationMinutes:1,platform:'NOVAJUDGE',platformBaseUrl:'http://127.0.0.1:3001',platformContestId:`desktop-only-${fixture}`,contestType:'TEAM',rules:'Synthetic isolated module test',reactionEnabled:false,reactionConfig:{create:{leaseToken:fixture,leaseUntil:new Date(Date.now()+3600000),autoGenerate:false}}}});examId=exam.id;
 const raw:Record<string,{key:string;bytes:number}>={};
 for(const [kind,duration,color] of [['camera',.52,'black'],['desktop',2,'blue']] as const) {
  const input=path.join(temporary,`${kind}.mp4`);
  await runMedia(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=320x180:r=25:d=${duration}`,'-an','-c:v','libx264','-threads','2','-bf','0','-pix_fmt','yuv420p',input]);
  raw[kind]=await stored(`${kind}.mp4`,await readFile(input));
 }
 const diagnostics={status:'PARTIAL',incompleteReason:'VIDEO_FRAME_TIMING_UNVERIFIED',channels:{DESKTOP_CAMERA:{complete:false,slices:[{id:'empty-source'}],frameTiming:{'empty-source':{selectedFrames:0,timestampsVerified:true}},issues:['FRAME_TIMING_UNVERIFIED:empty-source'],gaps:[{from:0,to:4}]},DESKTOP_SCREEN:{complete:true,issues:[],gaps:[]}}};
 const meta=await stored('metadata.json',Buffer.from(JSON.stringify(diagnostics)));
 const base={examId:exam.id,contestId:exam.platformContestId,teamId:'synthetic',teamName:'Synthetic only',problemId:'p',problemLabel:'A',sourceSubmittedAt:start,submissionObservedAt:start,judgementObservedAt:new Date(+start+1000),windowStart:start,windowEnd:end,verdict:'AC',originalVerdict:'AC'};
 for(const kind of ['missing','empty'] as const) {
  const camera=kind==='empty'?raw.camera:null;
  const record=await prisma.reaction.create({data:{...base,submissionId:`${kind}-${fixture}`,status:'PARTIAL',error:diagnostics.incompleteReason,cameraPath:camera?.key??null,desktopPath:raw.desktop.key,metadataPath:meta.key,outputBytes:BigInt((camera?.bytes??0)+raw.desktop.bytes+meta.bytes)}});
  // Each fixture needs a private metadata object: generation replaces its own.
  const ownMeta=await stored(`${kind}-metadata.json`,Buffer.from(JSON.stringify(diagnostics)));
  await prisma.reaction.update({where:{id:record.id},data:{metadataPath:ownMeta.key}});
  assert.equal((await queueReactionGeneration(exam.id,[record.id])).queued,1);
  await generateStoredReaction(record.id);
  const saved=await prisma.reaction.findUniqueOrThrow({where:{id:record.id}});
  assert.equal(saved.status,'PARTIAL');assert.equal(saved.error,diagnostics.incompleteReason);assert.equal(saved.generationStatus,'COMPLETE');assert.equal(saved.reservedBytes,0n);assert.equal(saved.cameraPath,camera?.key??null);
  assert.ok(saved.reactionPath&&saved.metadataPath);keys.push(saved.reactionPath,saved.metadataPath);
  const video=path.join(output,`${kind}-camera-reaction.mp4`),metadataFile=path.join(output,`${kind}-camera-metadata.json`);
  await materializeReactionObject(saved.reactionPath,video);await materializeReactionObject(saved.metadataPath,metadataFile);
  const metadata=JSON.parse(await readFile(metadataFile,'utf8'));
  assert.deepEqual(metadata.channels,diagnostics.channels);assert.equal(metadata.status,'PARTIAL');assert.equal(metadata.incompleteReason,diagnostics.incompleteReason);
  assert.equal(metadata.generation.cameraSource,'placeholder');assert.equal(metadata.generation.cameraTemplateBasis,'built-in:reaction-camera-placeholder-v1');
  assert.equal(metadata.generation.cameraPlaceholderReason,kind==='missing'?'MISSING_CAMERA_RECORDING':'NO_CAPTURED_CAMERA_FRAMES');
  assert.equal(metadata.generation.generationWindow.cameraDurationSeconds,null);assert.equal(metadata.generation.generationWindow.selectedDurationSeconds,2);
  assert.equal(metadata.generation.generationWindow.policy,'DESKTOP_START_MIN_DURATION');
  const probe=await probeReactionVideo(video);assert.equal(probe.duration,2);assert.equal(probe.width,1080);assert.equal(probe.height,1920);assert.equal(probe.codec,'h264');
  assert.equal(saved.outputBytes,BigInt((camera?.bytes??0)+raw.desktop.bytes+(await stat(video)).size+(await stat(metadataFile)).size));
  const frame=path.join(output,`${kind}-camera-template.png`);await runMedia(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-y','-ss','0.5','-i',video,'-frames:v','1','-vf','crop=1000:562:40:194',frame]);
  results.push({test:`${kind} camera renders explicit template with full desktop duration, keeps PARTIAL/diagnostics/cameraPath and settles storage`,passed:true,probe});
 }
 const corrupt=await stored('corrupt-camera.mp4',Buffer.alloc(1024,65));
 const corruptRecord=await prisma.reaction.create({data:{...base,submissionId:`corrupt-${fixture}`,status:'PARTIAL',cameraPath:corrupt.key,desktopPath:raw.desktop.key,metadataPath:meta.key}});
 await assert.rejects(generateStoredReaction(corruptRecord.id),/REACTION_GENERATOR_CAMERA_INVALID/);
 const absentRecord=await prisma.reaction.create({data:{...base,submissionId:`absent-object-${fixture}`,status:'PARTIAL',cameraPath:`reaction-desktop-only-tests/${fixture}/not-uploaded.mp4`,desktopPath:raw.desktop.key,metadataPath:meta.key}});
 await assert.rejects(generateStoredReaction(absentRecord.id),/REACTION_GENERATOR_CAMERA_READ_FAILED/);
 for(const [suffix,status,cameraPath,desktopPath] of [['missing-status','MISSING',null,raw.desktop.key],['complete-no-camera','COMPLETE',null,raw.desktop.key],['no-desktop','PARTIAL',raw.camera.key,null]] as const) {
  const rejected=await prisma.reaction.create({data:{...base,submissionId:`${suffix}-${fixture}`,status,cameraPath,desktopPath}});
  assert.equal((await queueReactionGeneration(exam.id,[rejected.id])).queued,0);
  await assert.rejects(generateStoredReaction(rejected.id),/PLAYABLE_INPUTS_REQUIRED/);
 }
 results.push({test:'Existing corrupt/unreadable camera is never silently substituted; MISSING/COMPLETE without camera/absent desktop rejected',passed:true});
 await writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,scope:'synthetic video and isolated local DB only; no user contest/video touched',results},null,2));console.log(JSON.stringify({passed:true,results}));
} finally {
 if(examId){const rows=await prisma.reaction.findMany({where:{examId}});keys.push(...rows.flatMap(r=>[r.cameraPath,r.desktopPath,r.reactionPath,r.metadataPath]).filter((k):k is string=>Boolean(k)));await prisma.reaction.deleteMany({where:{examId}});await prisma.exam.delete({where:{id:examId}});}
 for(const key of new Set(keys))await deleteStoredObject(key);
 const checked=await realpath(temporary),parent=await realpath(os.tmpdir());assert.equal(path.dirname(checked),parent);assert.ok(path.basename(checked).startsWith('reaction-desktop-only-test-'));await rm(checked,{recursive:true,force:true});await prisma.$disconnect();
}
