import assert from 'node:assert/strict';
import { CandidateImportRowSchema } from '@cwnupaa/proctor-shared';
import test from 'node:test';
import { hydroProblemDocId } from '../src/lib/hydro-problem-identity';
import { parseCandidateCsv, mergeTeamCandidateRows } from '../src/lib/candidate-import';
import { digest } from '../src/lib/exam-federation-protocol';
import { comparePlatformVersion } from '../src/lib/platform-sync-protocol';
import { scaledSubmissionScore } from '../src/lib/contest-rules';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Readable } from 'node:stream';
import * as awaitCrypto from 'node:crypto';
import * as asyncHooks from 'node:async_hooks';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as problemAuthoring from '../../../hydro-plugin/cwnupaa-proctor-auth/problem-authoring';

test('Hydro custom pid never replaces its immutable numeric docId',()=>{
 assert.equal(hydroProblemDocId({docId:42,id:'L1-1'}),'42');assert.equal(hydroProblemDocId({id:'42'}),'42');
 assert.throws(()=>hydroProblemDocId({id:'L1-1'}),/docId/);assert.throws(()=>hydroProblemDocId({docId:0,id:'42'}),/docId/);
});
test('member order sorts shared account rosters and only the captain has credentials',()=>{
 const rows=parseCandidateCsv('姓名,学号,学校,考号,密码,座位号,队伍名称,成员次序\n乙,002,学校,,,A02,一队,2\n甲,001,学校,T1,pw,A01,一队,1\n丙,003,学校,,,A03,一队,3');
 const [team]=mergeTeamCandidateRows(rows);assert.equal(team.name,'甲');assert.equal(team.teamMembers,'甲、乙、丙');assert.equal(team.teamMemberStudentIds,'001、002、003');assert.equal(team.teamRoster[1].seatNo,'A02');
 assert.throws(()=>mergeTeamCandidateRows([{...rows[0],examNumber:'wrong',password:'pw'},rows[1]]),/只有 1 号队长/);
 assert.throws(()=>mergeTeamCandidateRows([{...rows[0],memberOrder:1},rows[1]]),/队长|次序/);
 for(const value of ['0','-1','abc']) { const invalid=parseCandidateCsv(`姓名,队伍名称,成员次序\n甲,一队,${value}`)[0];assert.equal(CandidateImportRowSchema.safeParse(invalid).success,false); }
});
test('Lamport versions converge regardless of delivery direction, including offline edits',()=>{
 const a={revision:4,writer:'00000000-0000-4000-8000-000000000001'},b={revision:4,writer:'00000000-0000-4000-8000-000000000002'};
 assert.ok(comparePlatformVersion(a,b)<0);assert.ok(comparePlatformVersion(b,a)>0);assert.ok(comparePlatformVersion({...a,revision:5},b)>0);
});
test('exam maximum is a point value and may exceed 100',()=>{
 assert.equal(scaledSubmissionScore('IOI',100,70,200),35);assert.equal(scaledSubmissionScore('IOI',200,700,200),700);
});
test('Hydro bank operations cannot escape the selected domain and pending transfers never appear as complete problems',async()=>{
 const classes=new Map<string,any>(),docs=new Map<string,any>(),hooks=new Map<string,Function>(),storage=new Map<string,Buffer>();let next=100,authorized=0;
 const put=(domain:string,id:number,pid:string)=>{const p:any={_id:`${domain}-${id}`,domainId:domain,docId:id,pid,title:'原题',content:'题面',config:'{}',data:[],additional_file:[]};docs.set(`${domain}:${id}`,p);return p;};
 const original=put('Problems',42,'L1-1');put('Unrelated',42,'UNTOUCHED');const binary=Buffer.from([0,255,128,10,13]);original.data=[{name:'case.in',size:binary.length,etag:'provider-A'}];storage.set('problem/Problems/42/testdata/case.in',binary);
 class Handler{request:any={body:{}};response:any={};}
 const ProblemModel={PROJECTION_PUBLIC:['docId','pid','title','content','config','data','additional_file'],
  getMulti(domain:string,q:any){let values=[...docs].filter(([key])=>key.startsWith(`${domain}:`)).map(([,v])=>v);if(q.docId)values=values.filter(p=>p.docId>q.docId.$gt);if(q.proctorSyncId)values=values.filter(p=>p.proctorSyncId===q.proctorSyncId);const cursor={sort:()=>cursor,limit:(n:number)=>{values=values.slice(0,n);return cursor;},toArray:async()=>values};return cursor;},
  get:async(domain:string,id:number)=>docs.get(`${domain}:${id}`)||null,
  edit:async(domain:string,id:number,value:object)=>Object.assign(docs.get(`${domain}:${id}`),value),
  // The before-add hook must persist sync identity in the initial insert.
  add:async(domain:string,_pid:string,title:string,content:string)=>{const p=put(domain,++next,'');Object.assign(p,{title,content,hidden:true});hooks.get('problem/before-add')?.(domain,content,1,next,p);return next;},
  del:async(domain:string,id:number)=>docs.delete(`${domain}:${id}`),delTestdata:async(domain:string,id:number,names:string[])=>{const p=docs.get(`${domain}:${id}`);p.data=p.data.filter((f:any)=>!names.includes(f.name));for(const name of names)storage.delete(`problem/${domain}/${id}/testdata/${name}`);},delAdditionalFile:async()=>{},
 };
 const module={exports:{}as any};const source=readFileSync(new URL('../../../hydro-plugin/cwnupaa-proctor-auth/problem-bank.ts',import.meta.url),'utf8');
 const code=ts.transpile(source,{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022});
 const leaseRows=new Map<string,any>();
 const db={collection:(name:string)=>name==='proctor.sync.locks'?{
  findOneAndUpdate:async(q:any,u:any)=>{const v={_id:q._id,...u.$set};leaseRows.set(q._id,v);return v;},
  findOne:async(q:any)=>{const v=leaseRows.get(q._id);return v?.token===q.token?v:null;},
  updateOne:async()=>({matchedCount:1}),deleteOne:async(q:any)=>leaseRows.delete(q._id),
 }:name==='document'?{updateOne:async(q:any,u:any)=>{const p=[...docs.values()].find(p=>p._id===q._id);if(!p||('proctorSyncTransfer'in q&&JSON.stringify(p.proctorSyncTransfer??null)!==JSON.stringify(q.proctorSyncTransfer)))return{matchedCount:0};Object.assign(p,u.$set);return{matchedCount:1};}}:{findOne:async()=>null,updateOne:async()=>({matchedCount:1})}};
 const findStorageObject = async ({ path }: { path: string }) => storage.has(path) ? { link: path } : null;
 const StorageModel={
  coll: { findOne: findStorageObject, findOneAndUpdate: findStorageObject },
  get:async(key:string)=>{const value=storage.get(key);if(!value)throw new Error('missing storage');return Readable.from([value]);},
  getMeta:async(key:string)=>storage.has(key)?{size:storage.get(key)!.length}:null,
  exists:async(key:string)=>storage.has(key),copy:async(src:string,dst:string)=>{storage.set(dst,storage.get(src)!);},signDownloadLink:async()=> 'https://fixture.test/data',
 };
 const dependencies: Record<string, unknown> = {
  'node:crypto': awaitCrypto,
  'node:async_hooks': asyncHooks,
  'node:fs': nodeFs,
  'node:os': nodeOs,
  './problem-authoring': problemAuthoring,
  hydrooj: { Handler, ProblemModel, StorageModel, db, BadRequestError: Error, NotFoundError: Error },
 };
 runInNewContext(code,{exports:module.exports,module,require:(id:string)=>{assert(Object.hasOwn(dependencies,id));return dependencies[id];},Buffer,process,setTimeout,clearTimeout,setInterval,clearInterval});
 module.exports.registerProblemBank({effect:()=>{},parallel:async()=>{},on:(name:string,handler:Function)=>hooks.set(name,handler),Route:(name:string,_url:string,handler:any)=>classes.set(name,handler)},()=>authorized++,()=> 'Problems',async()=>{});
 const Bank=classes.get('cwnupaa_proctor_problem_bank');
 const call=async(body:object)=>{const h=new Bank();h.request.body={domain:'Unrelated',...body};const before=authorized;await h.post();assert.equal(authorized,before+1);return h.response.body.data;};
 const first=await call({action:'catalog'});assert.equal(first.items[0].id,'42');const hash=first.items[0].data[0].sha256;assert.equal(hash,awaitCrypto.createHash('sha256').update(binary).digest('hex'));original.data[0].etag='provider-B';assert.equal((await call({action:'catalog'})).items[0].data[0].sha256,hash);await assert.rejects(call({action:'file',id:42,area:'data',name:'case.in',sha256:'wrong'}),/file revision/);
 const version=(syncId:string,title:string)=>{const value={title,content:'新题面',html:false,hidden:false,tags:[],difficulty:0,config:'{}',data:[],files:[]};return{syncId,value,revision:1,writer:'00000000-0000-4000-8000-000000000001',hash:digest({payload:value,deleted:false})};};
 const update=version('stable-id','已更新');
 const prepared=await call({action:'prepare',id:42,sourceId:original._id,...update});assert.equal(prepared.id,'42');
 await call({action:'apply',id:42,...update});await call({action:'ack',id:42,...update});
 assert.equal(docs.get('Problems:42').title,'已更新');assert.equal(docs.get('Unrelated:42').title,'原题');
 const incoming=version('new-id','新题目');
 const created=await call({action:'prepare',...incoming});
 assert.equal((await call({action:'prepare',...incoming})).id,created.id,'lost prepare responses must not create duplicates');
 assert.equal((await call({action:'catalog'})).items.length,1,'incomplete new problems must be absent from catalog');
 await call({action:'apply',id:created.id,...incoming});
 assert.equal((await call({action:'catalog'})).items.length,1,'a committed Hydro transfer waits for the durable platform acknowledgement');
 await call({action:'ack',id:created.id,...incoming});
 assert.equal((await call({action:'catalog'})).items.length,2);
 await call({action:'delete',id:42,...update,sourceId:original._id});assert.ok(docs.has('Unrelated:42'));await call({action:'delete',id:42,...update,sourceId:original._id});
});
