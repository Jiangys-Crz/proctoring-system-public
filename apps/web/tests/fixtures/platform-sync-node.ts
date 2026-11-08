import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { prisma } from '../../src/lib/db';
import { saveHydroSettings } from '../../src/lib/settings';
import { savePlatformSyncSettings, getPlatformSyncSettings } from '../../src/lib/platform-sync-settings';
import { setExamPlatformSync } from '../../src/lib/platform-sync-exams';
import { capturePlatform, runPlatformSync, importPublicExam } from '../../src/lib/platform-sync';
import { runBankFilePushes } from '../../src/lib/platform-sync-file-outbox';
import { startExamFederationWorker } from '../../src/lib/exam-federation';
import { POST as exchange } from '../../src/app/api/platform-sync/route';
import { POST as filePost, PUT as filePut } from '../../src/app/api/platform-sync/file/route';
import { POST as examExchange } from '../../src/app/api/exam-sync/[examCode]/route';
import { queueContestRejudge } from '../../src/lib/contest-rejudge';
import { itemHash } from '../../src/lib/platform-sync-store';
import { storeBuffer } from '../../src/lib/storage';
import { prepareCodeExport } from '../../src/lib/code-export';
import sharp from 'sharp';
import { verifyCandidateIdentity } from '../../src/lib/candidate-verify';
const role=process.env.QA_ROLE as 'PUBLIC'|'LOCAL',port=Number(process.env.QA_PORT),other=Number(process.env.QA_OTHER);
process.env.APP_BASE_URL=`http://127.0.0.1:${port}`;
if(!/^\/proctor_sync_(public|local)_qa$/.test(new URL(process.env.DATABASE_URL!).pathname))throw new Error('Isolated QA database required');
const publicKey='public-sync-qa-key-12345678901234567890123456';
const sample=Buffer.from([0,255,13,10,128,90]);
type Doc={id:string;sourceId:string;syncId?:string;title:string;content:string;html:boolean;config:string;tags:string[];difficulty:number;hidden:boolean;data:{name:string;size:number;sha256:string}[];files:{name:string;size:number;sha256:string}[];pid?:string;pending?:boolean;snapshot?:unknown;transfer?:{hash:string;revision:number;writer:string;value:Record<string,any>;applied:boolean};staged?:Record<string,Buffer>;bytes:Record<string,Buffer>};
const docs=new Map<string,Doc>();let next=role==='PUBLIC'?500:900;
function fresh(id:string,title='原题'){const d:Doc={id,sourceId:randomUUID(),title,content:'题面',html:false,config:JSON.stringify({type:'default',subtasks:[{score:200}]}),tags:[],difficulty:1,hidden:false,data:[{name:'1.in',size:sample.length,sha256:createHash('sha256').update(sample).digest('hex')}],files:[],bytes:{'data:1.in':sample},pid:'CUSTOM-1'};docs.set(id,d);return d;}
fresh(role==='PUBLIC'?'41':'991',role==='PUBLIC'?'公网原题':'内网独有题');
function metadata(d:Doc){const{bytes,pid,pending,snapshot,transfer,staged,...p}=d;return p;}
async function handle(request:Request):Promise<Response>{
 const url=new URL(request.url);
 if(url.pathname==='/api/platform-sync')return exchange(request);
 if(url.pathname==='/api/platform-sync/file')return request.method==='PUT'?filePut(request):filePost(request);
 if(url.pathname.startsWith('/api/exam-sync/'))return examExchange(request,{params:Promise.resolve({examCode:url.pathname.split('/').at(-1)!})});
 if(url.pathname==='/api/proctor/problem-bank/upload'){
  const f=await request.formData(),d=docs.get(String(f.get('id')))!;const area=String(f.get('area')),name=String(f.get('name')),blob=f.get('file') as File;
  if(d.transfer?.hash!==f.get('hash'))return Response.json({ok:false},{status:409});
  const bytes=Buffer.from(await blob.arrayBuffer());(d.staged??={})[`${area}:${name}`]=bytes;
  return Response.json({ok:true,data:{uploaded:true}});
 }
 if(url.pathname.startsWith('/download/')){const[id,area,...parts]=url.pathname.slice(10).split('/'),b=docs.get(id)?.bytes[`${area}:${decodeURIComponent(parts.join('/'))}`];return b?new Response(new Uint8Array(b)):new Response(null,{status:404});}
 if(url.pathname==='/api/proctor/problem-bank'){
  const b=await request.json();
  if(b.action==='catalog')return Response.json({ok:true,data:{domain:'Problems',items:[...docs.values()].flatMap(d=>d.pending?d.snapshot?[d.snapshot]:[]:[metadata(d)]),pending:[...docs.values()].filter(d=>d.pending).map(d=>{const transfer=d.transfer;return{id:d.id,sourceId:d.sourceId,syncId:d.syncId,hash:transfer?.hash,applied:transfer?.applied,item:transfer?.applied?{id:d.syncId,scope:'bank',kind:'BANK',deleted:false,revision:transfer.revision,writer:transfer.writer,hash:transfer.hash,payload:transfer.value}:undefined};}),after:null}});
  if(b.action==='prepare'){
   let d=[...docs.values()].find(d=>d.syncId===b.syncId)||docs.get(String(b.id));
   if(d&&b.id&&b.sourceId&&d.sourceId!==b.sourceId)return Response.json({ok:false},{status:409});
   if(!d){d=fresh(String(++next),b.value.title);d.data=[];d.bytes={};d.pending=true;}
   if(!d.pending){if(b.expectedHash&&itemHash(metadata(d) as never)!==b.expectedHash){const {id,sourceId,syncId,...p}=metadata(d);if(itemHash(p)!==b.expectedHash)return Response.json({ok:false},{status:409});}d.snapshot=metadata(d);}
   d.pending=true;d.syncId=b.syncId;
   if(!d.transfer||d.transfer.hash!==b.hash)d.transfer={hash:b.hash,revision:b.revision,writer:b.writer,value:b.value,applied:false};else{d.transfer.revision=b.revision;d.transfer.writer=b.writer;}
   const missing=[];for(const area of ['data','files'])for(const f of b.value[area]){const key=`${area}:${f.name}`,bytes=d.staged?.[key]||d.bytes[key];if(bytes&&createHash('sha256').update(bytes).digest('hex')===f.sha256)(d.staged??={})[key]=bytes;else missing.push({area,name:f.name});}
   return Response.json({ok:true,data:{id:d.id,sourceId:d.sourceId,missing,applied:d.transfer.applied}});
  }
  const d=docs.get(String(b.id));if(!d&&b.action==='delete')return Response.json({ok:true,data:{deleted:true}});if(!d)return Response.json({ok:false},{status:404});
  if(b.action==='delete'){if(b.sourceId!==d.sourceId)return Response.json({ok:false},{status:409});docs.delete(d.id);return Response.json({ok:true,data:{deleted:true}});}
  if(b.action==='file')return Response.json({ok:true,data:{url:`http://127.0.0.1:${port}/download/${d.id}/${b.area}/${encodeURIComponent(b.name)}`}});
  if(b.action==='ack'){if(d.transfer&&d.transfer.hash===b.hash&&d.transfer.revision===b.revision&&d.transfer.writer===b.writer&&d.transfer.applied){d.pending=false;d.snapshot=undefined;}return Response.json({ok:true,data:{acknowledged:!d.pending}});}
  if(b.action==='apply'){
   if(!d.transfer||d.transfer.hash!==b.hash||d.transfer.revision!==b.revision||d.transfer.writer!==b.writer)return Response.json({ok:false},{status:409});
   const value=d.transfer.value;for(const area of ['data','files'])for(const f of value[area]){const bytes=d.staged?.[`${area}:${f.name}`];if(!bytes||createHash('sha256').update(bytes).digest('hex')!==f.sha256)return Response.json({ok:false},{status:409});d.bytes[`${area}:${f.name}`]=bytes;}
   Object.assign(d,value);d.transfer.applied=true;return Response.json({ok:true,data:metadata(d)});
  }
 }
 if(/^\/api\/proctor\/problem\/\d+$/.test(url.pathname)){const d=docs.get(url.pathname.split('/').at(-1)!);return d?Response.json({ok:true,data:{...metadata(d),id:d.id,docId:d.id,pid:d.pid,config:JSON.parse(d.config),score:200}}):Response.json({ok:false},{status:404});}
 if(url.pathname!=='/qa')return new Response('missing',{status:404});
 if(request.headers.get('x-qa')!=='isolated-test')return new Response(null,{status:403});
 const b=await request.json();
 if(b.op==='setup'){
  const admin=await prisma.user.create({data:{username:`qa-${randomUUID()}`,role:'SUPER_ADMIN'}});
  await prisma.systemSetting.upsert({where:{key:'qaAdmin'},create:{key:'qaAdmin',value:{id:admin.id}},update:{value:{id:admin.id}}});
  await saveHydroSettings({baseUrl:`http://127.0.0.1:${port}`,apiKey:'hydro-test',problemDomainId:'Problems'});
  await savePlatformSyncSettings({enabled:true,role,publicBaseUrl:`http://127.0.0.1:${role==='PUBLIC'?port:other}`,localBaseUrl:'',publicApiKey:publicKey,localApiKey:''},{allowPublicKeyChange:role==='PUBLIC'});
  if(role==='PUBLIC'){
   const exam=await prisma.exam.create({data:{examCode:'2026110601',name:'跨网考试',startAt:new Date(Date.now()-60000),latestStartAt:new Date(Date.now()+3600000),endAt:new Date(Date.now()+7200000),durationMinutes:120,platform:'HYDRO',platformBaseUrl:`http://127.0.0.1:${port}`,platformContestId:'local',contestType:'INDIVIDUAL',published:true,rules:'规则',createdById:admin.id,administrators:{create:{userId:admin.id}}}});
   const candidate=await prisma.candidate.create({data:{examId:exam.id,name:'张三',studentId:'0001',examNumber:'1001',password:'pass',school:'学校',seatNo:'A01'}});
   await prisma.examRoom.create({data:{examId:exam.id,name:'第一考室',requireSecondCamera:false,requireFrontCamera:false,candidates:{create:{candidateId:candidate.id}}}});
   await prisma.examProblem.create({data:{examId:exam.id,order:0,hydroDomain:'Problems',hydroProblemId:'41',title:'公网原题',content:'题面',hydroScore:200,score:70,scorePercent:70,label:'L1-1'}});
   await setExamPlatformSync(exam.id,true);
  }return Response.json({ok:true});
 }
 if(b.op==='capture'){await capturePlatform(await getPlatformSyncSettings());return Response.json({ok:true});}
 if(b.op==='sync'){await runPlatformSync();await runBankFilePushes();await runPlatformSync();return Response.json({ok:true});}
 if(b.op==='import'){const admin=(await prisma.systemSetting.findUniqueOrThrow({where:{key:'qaAdmin'}})).value as{id:string};return Response.json(await importPublicExam(`http://127.0.0.1:${other}/dashboard/exams/2026110601`,admin.id));}
 const exam=await prisma.exam.findUnique({where:{examCode:'2026110601'},include:{candidates:true,rooms:true,problems:true,federation:true,submissions:true,questions:{include:{messages:true}},announcements:true,loginRequests:true,sessions:true,mediaSegments:true,printJobs:true,cheatingRecords:true,codeCheckJobs:{include:{sources:true,pairs:true}},screenControlGroups:{include:{images:true,displays:true}}}});
 if(b.op==='state')return Response.json(JSON.parse(JSON.stringify({exam,docs:[...docs.values()].map(metadata)},(_,v)=>typeof v==='bigint'?v.toString():v)));
 if(!exam)throw new Error('exam missing');
 if(b.op==='legacy'){await prisma.examFederation.update({where:{examId:exam.id},data:{managedGlobally:false,enabled:false}});await prisma.platformSyncItem.deleteMany({where:{scope:exam.examCode}});await prisma.candidate.updateMany({where:{examId:exam.id},data:{syncKey:null}});await prisma.examProblem.updateMany({where:{examId:exam.id},data:{syncKey:null}});return Response.json({ok:true});}
 if(b.op==='toggle'){await setExamPlatformSync(exam.id,b.enabled);return Response.json({ok:true});}
 if(b.op==='codePaths')return Response.json((await prepareCodeExport(exam.id,AbortSignal.timeout(10000))).entries);
 if(b.op==='edit'){
  if(b.name)await prisma.exam.update({where:{id:exam.id},data:{name:b.name}});
  if(b.number)await prisma.candidate.update({where:{id:exam.candidates[0].id},data:{examNumber:b.number}});
  if(b.score!==undefined)await prisma.examProblem.update({where:{id:exam.problems[0].id},data:{score:b.score,scorePercent:b.score,label:b.label||'L2-2'}});
  if(b.bankTitle){const d=docs.get(exam.problems[0].hydroProblemId)!;d.title=b.bankTitle;d.pid='CUSTOM-CHANGED';}
  if(b.deleteBank)docs.delete(exam.problems[0].hydroProblemId);
  if(b.recreateBank)fresh(exam.problems[0].hydroProblemId,'重新创建的新题');
  if(b.ip!==undefined)await prisma.exam.update({where:{id:exam.id},data:{ipLoginRestrictionEnabled:b.ip}});
  if(b.loginIp!==undefined)await prisma.candidate.update({where:{id:exam.candidates[0].id},data:{loginIp:b.loginIp,loginIpBoundAt:new Date(),loginIpReleasedAt:null}});
  if(b.end)await prisma.exam.update({where:{id:exam.id},data:{endAt:new Date(Date.now()-1000)}});
  return Response.json({ok:true});
 }
 if(b.op==='extras'){
  const candidateId=exam.candidates[0].id,problemId=exam.problems[0].id;
  const photo=await sharp({create:{width:2,height:2,channels:3,background:'#2277cc'}}).webp().toBuffer();
  const image=await storeBuffer(photo,{filename:'qa-photo.webp',prefix:`${exam.id}/${candidateId}`});
  const video='qa-video-never-synced.webm';
  await prisma.mediaSegment.create({data:{examId:exam.id,candidateId,channel:'IDENTITY_PHOTO',objectPath:image.objectPath,byteSize:photo.length,validatedAt:new Date()}});
  await prisma.mediaSegment.create({data:{examId:exam.id,candidateId,channel:'ROOM_VIDEO',objectPath:video,byteSize:10,durationSeconds:5,validatedAt:new Date()}});
  const login=await prisma.loginRequest.create({data:{examId:exam.id,candidateId,status:'REQUESTING',identityPhotoPath:image.objectPath,roomVideoPath:video}});
  await prisma.clientSession.create({data:{examId:exam.id,candidateId,loginRequestId:login.id,status:'WAITING_REVIEW',desktopTokenHash:'source-only-token'}});
  await prisma.printJob.create({data:{examId:exam.id,candidateId,mode:'VIRTUAL',status:'SAVED',title:'打印',content:'代码',examNumber:exam.candidates[0].examNumber}});
  await prisma.cheatingRecord.create({data:{examId:exam.id,candidateId,reason:'测试标记'}});
  const group=await prisma.screenControlGroup.create({data:{examId:exam.id,name:'控屏'}});
  const picture=await storeBuffer(photo,{filename:'qa-screen.webp',prefix:`screen-control/${exam.id}/${group.id}`});
  await prisma.screenControlImage.create({data:{groupId:group.id,name:'图片',objectPath:picture.objectPath,byteSize:photo.length,width:2,height:2,order:0}});
  await prisma.screenControlDisplay.create({data:{examId:exam.id,groupId:group.id,groupName:'控屏',startsAt:new Date()}});
  const job=await prisma.codeCheckJob.create({data:{examId:exam.id,createdById:exam.createdById!,status:'completed',phase:'完成',warnings:[],problemId,finishedAt:new Date()}});
  await prisma.codeCheckSource.create({data:{jobId:job.id,submissionId:exam.submissions[0].id,candidateId,actorKey:'qa',uid:1,pid:1,problemId,problemTitle:'题目',problemOrder:0,candidateName:'张三',examNumber:exam.candidates[0].examNumber,lang:'cpp',code:'int main() {}',submittedAt:new Date()}});
  return Response.json({ok:true});
 }
 if(b.op==='submit'){
  await prisma.contestSubmission.create({data:{examId:exam.id,candidateId:exam.candidates[0].id,problemId:exam.problems[0].id,candidateExamNumber:exam.candidates[0].examNumber,actorKey:`${exam.examCode}:${exam.candidates[0].examNumber}`,lang:'cpp',code:'int main() {}',status:1,statusText:'Accepted',score:200,judgeAt:new Date()}});
  await prisma.examQuestion.create({data:{examId:exam.id,candidateId:exam.candidates[0].id,content:'题目咨询',problemPid:exam.problems[0].hydroProblemId,problemIndex:'L1-1'}});
  await prisma.examAnnouncement.create({data:{examId:exam.id,content:'公告'}});return Response.json({ok:true});
 }
 if(b.op==='rejudge')return Response.json({count:await queueContestRejudge(exam.id)});
 if(b.op==='verify')return Response.json(await verifyCandidateIdentity({examCode:exam.examCode,examNumber:exam.candidates[0].examNumber,password:'pass'}));
 return new Response('missing op',{status:400});
}
const server=http.createServer(async(req,res)=>{try{const body=req.method==='GET'||req.method==='HEAD'?undefined:Readable.toWeb(req);const request=new Request(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers:req.headers as HeadersInit,body,duplex:'half'} as RequestInit);const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)await pipeline(Readable.fromWeb(response.body as never),res);else res.end();}catch(e){console.error(role,e);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}));}});
server.listen(port,'127.0.0.1',()=>{console.log(`READY ${role}`);startExamFederationWorker();});
