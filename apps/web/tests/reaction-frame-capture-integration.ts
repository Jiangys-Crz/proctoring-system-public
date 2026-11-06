/** Local DB/media module integration. Synthetic sources, NOT a CCS submission
 * or physical-client acceptance. Run with node --env-file=.env --import tsx. */
import assert from 'node:assert/strict';
import { randomInt,randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp,mkdir,readFile,writeFile,rm,realpath } from 'node:fs/promises';
import { prisma } from '../src/lib/db';
import { captureReaction,materializeReactionObject,probeReactionVideo,runMedia } from '../src/lib/reaction-media';
import { deleteStoredObject,storeBuffer } from '../src/lib/storage';
import { reactionChannels } from '../src/lib/reaction-domain';
const database=new URL(process.env.DATABASE_URL||'mysql://invalid/invalid');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(database.hostname));assert.match(database.pathname,/^\/reaction_e2e(?:_|$)/);
const output=path.resolve(process.env.REACTION_CAPTURE_TEST_OUTPUT||'.local/reaction-frame-capture-test');await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(os.tmpdir(),'reaction-frame-capture-test-'));
const fixture=randomUUID(),keys:string[]=[];let examId:string|undefined;
const results:unknown[]=[];
try{
 const start=new Date('2026-11-04T00:00:00Z'),end=new Date(+start+3000);
 const exam=await prisma.exam.create({data:{examCode:String(randomInt(1_000_000_000,10_000_000_000)),name:`Frame cadence module ${fixture}`,startAt:start,latestStartAt:end,endAt:end,durationMinutes:1,platform:'NOVAJUDGE',platformBaseUrl:'http://127.0.0.1:3001',platformContestId:`frame-test-${fixture}`,contestType:'TEAM',teamAccountMode:'TEAM_ACCOUNT',contestRule:'ACM',rules:'Isolated synthetic media module test only',saveFullRecording:false,saveIncidentRecording:false,reactionEnabled:false,reactionConfig:{create:{leaseToken:fixture,leaseUntil:new Date(Date.now()+3600000),autoGenerate:false}}}});examId=exam.id;
 for(const [name,rate,expected] of [['dense',20,'COMPLETE'],['sparse',1,'PARTIAL']] as const){
  const input=path.join(temporary,`${name}.mp4`);
  await runMedia(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i',`testsrc2=size=320x180:rate=${rate}:duration=3`,'-an','-c:v','libx264','-threads','2','-bf','0','-pix_fmt','yuv420p',input]);
  const buffer=await readFile(input);const segments=[];
  for(const channel of reactionChannels){
   const stored=await storeBuffer(buffer,{prefix:`reaction-frame-tests/${fixture}`,filename:`${name}-${channel}.mp4`,stableName:true,contentType:'video/mp4'});keys.push(stored.objectPath);
   segments.push(await prisma.mediaSegment.create({data:{examId:exam.id,channel,objectPath:stored.objectPath,startedAt:start,endedAt:end,durationSeconds:3,byteSize:buffer.length,validatedAt:new Date(),clockOffsetMs:0,clockUncertaintyMs:5,reactionCache:true}}));
  }
  const r=await prisma.reaction.create({data:{examId:exam.id,contestId:exam.platformContestId,submissionId:`module-${name}-${fixture}`,teamId:'synthetic-team',teamName:'Synthetic media test',problemId:'p',problemLabel:'A',sourceSubmittedAt:start,submissionObservedAt:start,judgementObservedAt:start,windowStart:start,windowEnd:end,status:'CAPTURING',verdict:'AC',originalVerdict:'AC',segments:{create:segments.map(s=>({segmentId:s.id}))}}});
  await captureReaction(r.id);
  const saved=await prisma.reaction.findUniqueOrThrow({where:{id:r.id}});keys.push(...[saved.cameraPath,saved.desktopPath,saved.metadataPath].filter((k):k is string=>Boolean(k)));
  assert.equal(saved.status,expected);assert.equal(saved.reservedBytes,0n);assert.ok(saved.outputBytes>0n);
  assert.equal(saved.error,name==='sparse'?'VIDEO_FRAME_CADENCE_INCOMPLETE':null);
  const probes:Record<string,unknown>={};
  for(const [kind,key] of [['camera',saved.cameraPath],['desktop',saved.desktopPath]] as const){assert.ok(key);const file=path.join(output,`${name}-${kind}.mp4`);await materializeReactionObject(key,file);probes[kind]=await probeReactionVideo(file);}
  assert.ok(saved.metadataPath);const meta=path.join(output,`${name}-metadata.json`);await materializeReactionObject(saved.metadataPath,meta);const metadata=JSON.parse(await readFile(meta,'utf8'));
  for(const channel of reactionChannels){assert.equal(metadata.channels[channel].complete,name==='dense');assert.ok(Object.keys(metadata.channels[channel].frameTiming).length===1);}
  results.push({case:name,source:'synthetic FFmpeg testsrc2',inputFps:rate,status:saved.status,error:saved.error,expected,passed:true,probes});
 }
 await writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,scope:'media/database module, not real NovaJudge submission',results},null,2));console.log(JSON.stringify({passed:true,results}));
}finally{
 if(examId){
  const rows=await prisma.reaction.findMany({where:{examId}});keys.push(...rows.flatMap(r=>[r.cameraPath,r.desktopPath,r.metadataPath]).filter((k):k is string=>Boolean(k)));
  await prisma.reaction.deleteMany({where:{examId}});await prisma.mediaSegment.deleteMany({where:{examId}});await prisma.exam.delete({where:{id:examId}});
 }
 for(const key of new Set(keys)) await deleteStoredObject(key);
 const checked=await realpath(temporary),parent=await realpath(os.tmpdir());assert.equal(path.dirname(checked),parent);assert.ok(path.basename(checked).startsWith('reaction-frame-capture-test-'));await rm(checked,{recursive:true,force:true});await prisma.$disconnect();
}
