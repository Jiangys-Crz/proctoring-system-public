// Only run against the disposable local QA database and local HTTP server.
import assert from 'node:assert/strict';
import {randomInt,randomUUID} from 'node:crypto';
import {prisma} from '../src/lib/db';
import {createSessionToken} from '../src/lib/auth';
import {createClientSessionToken} from '../src/lib/client-auth';
const db=new URL(process.env.DATABASE_URL||'');assert.equal(db.hostname,'127.0.0.1');assert.equal(db.pathname,'/proctor_submission_sharing_qa');
const base='http://127.0.0.1:43319',marker='delivery-'+randomUUID();let examId='',ownerId='',outsiderId='';
try{
 const owner=await prisma.user.create({data:{username:marker,role:'ADMIN'}});ownerId=owner.id;
 const outsider=await prisma.user.create({data:{username:marker+'-other',role:'ADMIN'}});outsiderId=outsider.id;
 const now=Date.now();const exam=await prisma.exam.create({data:{name:marker,examCode:String(randomInt(1_000_000_000,10_000_000_000)),createdById:owner.id,platform:'NOVAJUDGE',platformBaseUrl:'https://judge.invalid',platformContestId:'local',contestType:'INDIVIDUAL',contestRule:'XCPC',published:true,rules:'',startAt:new Date(now-60000),endAt:new Date(now+3600000),latestStartAt:new Date(now+60000),durationMinutes:60,requireMiniProgram:false,requireFrontCamera:false}});examId=exam.id;
 const identities=[];
 for(let i=0;i<2;i++){
  const candidate=await prisma.candidate.create({data:{examId,examNumber:String(i+1),seatNo:String(i+1),name:'隔离测试考生'+i,password:'isolated-only',status:'ONLINE_NORMAL',startedAt:new Date(now-1000)}});
  const desktop=createClientSessionToken(),phone=createClientSessionToken();
  const session=await prisma.clientSession.create({data:{examId,candidateId:candidate.id,status:'IN_EXAM',startedAt:new Date(now-1000),desktopDeviceId:'qa-device-'+i,desktopTokenHash:desktop.tokenHash,miniProgramTokenHash:phone.tokenHash,lastDesktopSeenAt:new Date(now+600000),peripheralsBaselineFingerprint:'baseline',lastPeripheralsFingerprint:'baseline'}});
  identities.push({candidate,session,desktop,phone});
 }
 const adminHeaders={cookie:'cwnupaa_proctor_session='+createSessionToken(owner),origin:base,'content-type':'application/json'};
 const request=async(path:string,body?:unknown,headers:Record<string,string>=adminHeaders)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});return {response,body:await response.json()};};
 const a=identities[0],b=identities[1];
 const warning=await request('/api/alerts/warning',{candidateId:a.candidate.id,sessionId:a.session.id,content:'给第一位考生的单发警告'});assert.equal(warning.response.status,201);assert.equal(warning.body.data.candidateId,a.candidate.id);assert.equal(await prisma.alert.count({where:{examId,type:'MANUAL_NOTE'}}),0);
 const getQA=async(identity:typeof a)=>(await request('/api/client/qa?sessionId='+identity.session.id,undefined,{'x-proctor-session-token':identity.desktop.token})).body.data;
 assert.equal((await getQA(a)).announcements.length,1);assert.equal((await getQA(b)).announcements.length,0);
 const denied=await request('/api/alerts/warning',{candidateId:a.candidate.id,content:'unauthorized'},{...adminHeaders,cookie:'cwnupaa_proctor_session='+createSessionToken(outsider)});assert.equal(denied.response.status,403);
 const question=await prisma.examQuestion.create({data:{examId,candidateId:a.candidate.id,sessionId:a.session.id,content:'公开问题内容',answer:'公开回复',problemIndex:'A',problemTitle:'测试题目'}});
 const published=await Promise.all([request(`/api/exams/${examId}/qa`,{action:'publish',questionId:question.id,published:true}),request(`/api/exams/${examId}/qa`,{action:'publish',questionId:question.id,published:true})]);assert(published.every(x=>x.response.status===200));assert.equal(await prisma.examAnnouncement.count({where:{examId,candidateId:null}}),1);
 for(const identity of identities){const qa=await getQA(identity);assert(qa.announcements.some((n:{content:string;candidateId:string|null})=>n.candidateId===null&&n.content.includes('公开问题内容')));const notice=qa.announcements.find((n:{candidateId:string|null})=>n.candidateId===null);const ack=await request('/api/client/qa',{action:'ack-announcement',sessionId:identity.session.id,announcementId:notice.id},{'content-type':'application/json','x-proctor-session-token':identity.desktop.token});assert.equal(ack.response.status,200);assert((await getQA(identity)).announcements.find((n:{id:string})=>n.id===notice.id).acknowledged);}
 // The same final fingerprint must not hide a brief physical insert/removal.
 const events=[{id:randomUUID(),action:'INSERT',deviceId:'USB\\VID_1234&PID_5678\\SERIAL'},{id:randomUUID(),action:'REMOVE',deviceId:'USB\\VID_1234&PID_5678\\SERIAL'}];
 const heartbeat=()=>request('/api/client/heartbeat',{sessionId:a.session.id,deviceId:a.session.desktopDeviceId,side:'DESKTOP',system:{peripheralsFingerprint:'baseline',peripheralScanOk:true,peripheralEvents:events}},{'content-type':'application/json','x-proctor-session-token':a.desktop.token});
 const first=await heartbeat();assert.equal(first.response.status,200);assert.equal(first.body.data.session.lockdown,true);assert.equal(first.body.data.alertsCreated,2);assert.equal(first.body.data.acceptedPeripheralEventIds.length,2);
 await prisma.clientSession.update({where:{id:a.session.id},data:{lockdown:false,lockdownReason:null,status:'IN_EXAM'}});const retry=await heartbeat();assert.equal(retry.body.data.session.lockdown,false);assert.equal(retry.body.data.alertsCreated,0);
 await prisma.clientSession.update({where:{id:a.session.id},data:{lockdown:true,lockdownReason:'被监考老师标记为作弊',status:'LOCKED'}});
 const appeal=await request('/api/client/cheating/appeal',{sessionId:a.session.id,message:'对标记提出申诉，请核查'},{'content-type':'application/json','x-proctor-session-token':a.desktop.token});assert.equal(appeal.response.status,201);assert.match(appeal.body.data.message,/作弊申诉/);
 console.log(JSON.stringify({privateWarningUsesAnnouncement:true,unauthorizedWarningRejected:true,publicQuestionNotifiesBothCandidates:true,concurrentPublishCreatesOneNotice:true,perCandidateReadReceipts:true,briefUsbInsertAndRemovalLock:true,replayAfterUnlockDoesNotRelock:true,realCheatingAppealStored:true}));
}finally{if(examId)await prisma.exam.deleteMany({where:{id:examId}});await prisma.user.deleteMany({where:{id:{in:[ownerId,outsiderId].filter(Boolean)}}});await prisma.$disconnect();}
