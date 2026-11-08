import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const publicPort=4077,localPort=4078;
if(!process.env.PROCTOR_SYNC_QA_DATABASE_PREFIX?.endsWith('/proctor_sync_'))throw new Error('Set isolated mysql URL prefix ending /proctor_sync_');
const children:ReturnType<typeof spawn>[]=[];
async function start(role:'PUBLIC'|'LOCAL',port:number,other:number){
 const child=spawn(process.execPath,['--import','tsx','tests/fixtures/platform-sync-node.ts'],{env:{...process.env,DATABASE_URL:`${process.env.PROCTOR_SYNC_QA_DATABASE_PREFIX}${role.toLowerCase()}_qa`,SESSION_SECRET:'isolated-sync-qa-secret-at-least-32-characters',QA_ROLE:role,QA_PORT:String(port),QA_OTHER:String(other)},stdio:['ignore','pipe','pipe']});children.push(child);
 let output='';child.stderr?.on('data',b=>{output+=b;process.stderr.write(b);});
 await new Promise<void>((resolve,reject)=>{child.stdout?.on('data',b=>{if(String(b).includes('READY'))resolve();});child.once('exit',()=>reject(new Error(output)));setTimeout(()=>reject(new Error('fixture startup timeout')),10000).unref();});
}
async function qa(port:number,op:string,data:object={}){const response=await fetch(`http://127.0.0.1:${port}/qa`,{method:'POST',headers:{'content-type':'application/json','x-qa':'isolated-test'},body:JSON.stringify({op,...data})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;}
async function converge(check:()=>Promise<boolean>,label:string){for(let i=0;i<15;i++){await qa(publicPort,'capture');await qa(localPort,'sync');if(await check()){console.log(`PASS ${label}`);return;}await sleep(800);}throw new Error(`Did not converge: ${label}`);}
try{
 await start('PUBLIC',publicPort,localPort);await start('LOCAL',localPort,publicPort);await qa(publicPort,'setup');await qa(localPort,'setup');await qa(publicPort,'capture');await qa(localPort,'sync');
 assert.equal((await qa(localPort,'import')).examCode,'2026110601');
 let pub=await qa(publicPort,'state'),local=await qa(localPort,'state');
 assert.equal(local.exam.problems[0].label,'L1-1');assert.equal(local.exam.problems[0].score,70);assert.notEqual(local.exam.problems[0].hydroProblemId,pub.exam.problems[0].hydroProblemId);assert.equal(local.exam.candidates[0].password,'pass');assert.equal(local.exam.rooms[0].requireSecondCamera,false);assert.equal((await qa(localPort,'verify')).ok,true);console.log('PASS import, docId mapping, labels, credentials and room cameras');
 await qa(publicPort,'edit',{loginIp:'203.0.113.10'});
 await qa(localPort,'edit',{name:'内网修改',score:80,label:'Z-1',number:'LAN1001',ip:false,loginIp:'192.0.2.20'});
 await converge(async()=>{const s=await qa(publicPort,'state');return s.exam.name==='内网修改'&&s.exam.problems[0].score===80&&s.exam.candidates[0].examNumber==='LAN1001';},'LAN edits leave public login IP policy and binding local');
 pub=await qa(publicPort,'state');
 assert.equal(pub.exam.ipLoginRestrictionEnabled,true);
 assert.equal(pub.exam.candidates[0].loginIp,'203.0.113.10');
 await qa(localPort,'edit',{ip:true});
 await qa(publicPort,'edit',{ip:false,number:'IPCHECK1001'});
 await converge(async()=>(await qa(localPort,'state')).exam.candidates[0].examNumber==='IPCHECK1001','public edits leave LAN login IP policy and binding local');
 local=await qa(localPort,'state');
 assert.equal(local.exam.ipLoginRestrictionEnabled,true);
 assert.equal(local.exam.candidates[0].loginIp,'192.0.2.20');
 await qa(publicPort,'edit',{bankTitle:'修改后原题'});
 await converge(async()=>{const s=await qa(localPort,'state');return s.exam.problems[0].title==='修改后原题';},'bank edits retain mapping despite custom pid change');assert.equal((await qa(localPort,'state')).exam.problems[0].hydroProblemId,local.exam.problems[0].hydroProblemId);
 await qa(localPort,'submit');
 await converge(async()=>{const s=await qa(publicPort,'state');return s.exam.submissions.length===1&&s.exam.questions.length===1&&s.exam.announcements.length===1;},'code, judge results, questions and announcements');
 await qa(localPort,'extras');
 await converge(async()=>{const s=await qa(publicPort,'state');return s.exam.sessions.length===1&&s.exam.printJobs.length===1&&s.exam.cheatingRecords.length===1&&s.exam.screenControlGroups[0]?.images.length===1&&s.exam.codeCheckJobs[0]?.sources.length===1&&s.exam.loginRequests[0]?.identityPhotoPath;},'sessions, photos, print, cheating, screen schedules and code reports');
 const expanded=await qa(publicPort,'state');assert.equal(expanded.exam.sessions[0].desktopTokenHash,null);assert.equal(expanded.exam.sessions[0].loginRequestId,expanded.exam.loginRequests[0].id);assert.equal(expanded.exam.mediaSegments.some((m:any)=>m.channel==='ROOM_VIDEO'),false);assert.equal(expanded.exam.codeCheckJobs[0].sources[0].problemId,expanded.exam.problems[0].id);assert.equal(expanded.exam.loginRequests[0].syncMaterialsVerified,true);
 await qa(localPort,'toggle',{enabled:false});await qa(publicPort,'edit',{name:'暂停期间更新'});await qa(publicPort,'capture');await qa(localPort,'sync');assert.notEqual((await qa(localPort,'state')).exam.name,'暂停期间更新');await qa(localPort,'toggle',{enabled:true});
 await converge(async()=>(await qa(localPort,'state')).exam.name==='暂停期间更新','paused updates drain after resume');
 await qa(publicPort,'legacy');await qa(localPort,'legacy');await qa(publicPort,'toggle',{enabled:true});await qa(publicPort,'capture');await qa(localPort,'import');
 await converge(async()=>{const s=await qa(publicPort,'state'),l=await qa(localPort,'state');return s.exam.submissions.length===1&&l.exam.submissions.length===1&&s.exam.candidates[0].syncKey===l.exam.candidates[0].syncKey;},'legacy connection migration retains history and remaps existing rows');
 await qa(publicPort,'edit',{number:'NEW1001'});
 await converge(async()=>(await qa(localPort,'state')).exam.candidates[0].examNumber==='NEW1001','account edits preserve submission identity');
 await qa(localPort,'edit',{end:true});await converge(async()=>new Date((await qa(publicPort,'state')).exam.endAt).getTime()<Date.now(),'end time sync');
 await qa(publicPort,'edit',{deleteBank:true});
 await converge(async()=>{const s=await qa(localPort,'state');return s.exam.problems[0].sourceDeleted&&s.exam.submissions.length===1;},'deleted source retains completed exam and submissions');assert.equal((await qa(localPort,'rejudge')).count,0);
 local=await qa(localPort,'state');assert.equal(local.exam.problems[0].title,'修改后原题');assert.equal(local.exam.submissions[0].code,'int main() {}');
 const paths=await qa(localPort,'codePaths');assert.match(paths[0].path,/^0001-张三\/Z-1-修改后原题-[^.]+\.cpp$/);console.log('PASS no rejudge after deletion; statement and code retained');
 await qa(publicPort,'edit',{recreateBank:true});await converge(async()=>{const s=await qa(localPort,'state');return s.docs.some((d:any)=>d.title==='重新创建的新题');},'reused Hydro docId is a new problem after deletion');assert.equal((await qa(localPort,'state')).exam.problems[0].title,'修改后原题');
}finally{for(const child of children)child.kill('SIGTERM');}
