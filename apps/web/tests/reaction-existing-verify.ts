/** Verify explicit submissions in an existing local exam; never seeds or changes its source. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
const run=promisify(execFile);
const [examId,idsText,outputArg]=process.argv.slice(2);
assert(examId&&idsText&&outputArg,'Usage: reaction-existing-verify.ts examId submissionIdsCommaSeparated outputDirectory');
const ids=idsText.split(','),output=path.resolve(outputArg);
const base=process.env.REACTION_E2E_URL||'http://localhost:4031';
assert(['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname),'Local test only');
const report:any={startedAt:new Date().toISOString(),examId,submissionIds:ids,mediaKind:'SIMULATED_CANVAS_VIA_AUTHENTICATED_MEDIAMTX',physicalClient:'NOT_TESTED_BY_THIS_SCRIPT',checks:[],artifacts:[]};
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
function pass(name:string,evidence:unknown){report.checks.push({name,result:'PASS',evidence});console.log('PASS '+name);}
async function waitFor<T>(read:()=>Promise<T|false>,timeout:number,label:string):Promise<T>{const end=Date.now()+timeout;while(Date.now()<end){const r=await read();if(r)return r;await delay(1000);}throw new Error('Timed out: '+label);}
try{
 await fs.mkdir(output,{recursive:true});
 const admin=JSON.parse(await fs.readFile(process.env.REACTION_ADMIN_FIXTURE||'.local/reaction-e2e/fixture.private.json','utf8'));
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({account:admin.adminUsername,password:admin.adminPassword})});
 assert.equal(login.status,200,'Administrator authentication');
 const cookie=login.headers.get('set-cookie')!.split(';')[0];
 const endpoint=base+'/api/exams/'+examId+'/reactions';
 const headers={cookie,origin:base,'content-type':'application/json'};
 async function api(url:string,method='GET',body?:unknown){const r=await fetch(url,{method,headers,body:body?JSON.stringify(body):undefined});assert(r.ok,'Reaction API status '+r.status);return (await r.json()).data;}
 const exam=await prisma.exam.findUniqueOrThrow({where:{id:examId}});
 report.exam={examCode:exam.examCode,contestId:exam.platformContestId,baseUrl:exam.platformBaseUrl};
 assert(exam.platform==='NOVAJUDGE'&&exam.reactionEnabled);
 const rows=await waitFor(async()=>{
  const r=await prisma.reaction.findMany({where:{examId,submissionId:{in:ids}}});
  const bad=r.find(x=>['MISSING','PARTIAL','FAILED','TIMEOUT','UNMAPPED'].includes(x.status));
  if(bad)throw new Error('Incomplete Reaction: '+bad.submissionId+' '+bad.status+' '+bad.error);
  return r.length===ids.length&&r.every(x=>x.status==='COMPLETE')?r:false;
 },240000,'raw camera and desktop clips');
 for(const r of rows){
  assert(r.cameraPath&&r.desktopPath&&r.metadataPath&&r.judgementObservedAt&&r.windowEnd);
  const config=await prisma.reactionConfig.findUniqueOrThrow({where:{examId}});
  assert.equal(+r.windowStart,+r.sourceSubmittedAt-config.beforeSeconds*1000);
  assert.equal(+r.windowEnd,+r.judgementObservedAt+config.afterSeconds*1000);
  const events=await prisma.reactionEvent.findMany({where:{examId,OR:[{type:'submissions',remoteId:r.submissionId},{type:'judgements',remoteId:r.judgementId||''}]}});
  assert(events.some(e=>e.type==='submissions')&&events.some(e=>e.type==='judgements'));
  await fs.writeFile(path.join(output,r.submissionId+'-ccs.json'),JSON.stringify(events,null,2));
  pass('Real CCS and exact capture window',{submissionId:r.submissionId,verdict:r.verdict,sourceSubmittedAt:r.sourceSubmittedAt,submissionObservedAt:r.submissionObservedAt,judgementObservedAt:r.judgementObservedAt,windowStart:r.windowStart,windowEnd:r.windowEnd});
 }
 const pendingGeneration=rows.filter(r=>!r.reactionPath && !['QUEUED','RUNNING'].includes(r.generationStatus));
 if(pendingGeneration.length) await api(endpoint+'/generate','POST',{reactionIds:pendingGeneration.map(r=>r.id)});
 const generated=await waitFor(async()=>{
  const r=await prisma.reaction.findMany({where:{examId,submissionId:{in:ids}}});
  assert(!r.some(x=>x.generationStatus==='FAILED'),'Official generator failed');
  return r.every(x=>x.reactionPath&&x.generationStatus==='COMPLETE')?r:false;
 },1200000,'official 1080x1920 generator');
 for(const r of generated){
  const dir=path.join(output,r.submissionId);await fs.mkdir(dir,{recursive:true});const probes:any={};
  for(const kind of ['camera','desktop','reaction','metadata']){
   const response=await fetch(endpoint+'/'+r.id+'/files/'+kind,{headers});assert.equal(response.status,200);
   const data=Buffer.from(await response.arrayBuffer());assert(data.length>0);
   const file=path.join(dir,kind+(kind==='metadata'?'.json':'.mp4'));await fs.writeFile(file,data);
   if(kind!=='metadata'){
    const {stdout}=await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{windowsHide:true});
    probes[kind]=JSON.parse(stdout);assert(Number(probes[kind].format.duration)>0);
    await run(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-xerror','-threads','1','-i',file,'-f','null','-'],{windowsHide:true,timeout:120000});
   }
  }
  const video=probes.reaction.streams.find((x:any)=>x.codec_type==='video');assert.equal(video.width,1080);assert.equal(video.height,1920);
  assert(Math.abs(Number(probes.camera.format.duration)-Number(probes.desktop.format.duration))<0.1);
  assert(Math.abs(Number(probes.camera.format.duration)-Number(r.durationSeconds))<0.25);
  await fs.writeFile(path.join(dir,'ffprobe.json'),JSON.stringify(probes,null,2));
  report.artifacts.push({submissionId:r.submissionId,verdict:r.verdict,directory:dir,duration:probes.camera.format.duration});
 }
 pass('MP4 full decode, official dimensions and synchronized durations',report.artifacts);
 assert.equal((await fetch(endpoint+'/'+generated[0].id+'/files/camera')).status,401);pass('Private file authorization',401);
 browser=await chromium.launch({executablePath:process.env.REACTION_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const index=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,index),value:cookie.slice(index+1),url:base,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();await page.goto(base+'/dashboard/exams/'+examId+'/reactions');
 for(const kind of ['Camera','Desktop','Reaction']){
  await page.getByRole('button',{name:kind+' 预览',exact:true}).first().click();
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());
  await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.currentTime>0&&v.videoWidth>16;});
  pass('Management '+kind+' actual playback',await page.locator('video').evaluate((v:HTMLVideoElement)=>({width:v.videoWidth,height:v.videoHeight,currentTime:v.currentTime})));
  await page.screenshot({path:path.join(output,'admin-'+kind.toLowerCase()+'.png'),fullPage:true});
 }
 report.passed=true;
}catch(error){report.passed=false;report.error=error instanceof Error?error.message:String(error);console.error(report.error);process.exitCode=1;}
finally{await browser?.close();await prisma.$disconnect();report.finishedAt=new Date().toISOString();await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2));}
