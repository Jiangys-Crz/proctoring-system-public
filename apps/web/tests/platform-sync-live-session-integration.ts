import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const publicPort=4087,localPort=4088;
if(!process.env.PROCTOR_SYNC_QA_DATABASE_PREFIX?.endsWith('/proctor_sync_'))throw new Error('Set an isolated mysql URL prefix ending /proctor_sync_');
const children:ReturnType<typeof spawn>[]=[];
async function start(role:'PUBLIC'|'LOCAL',port:number,other:number){
 const child=spawn(process.execPath,['--import','tsx','tests/fixtures/platform-sync-node.ts'],{env:{...process.env,DATABASE_URL:`${process.env.PROCTOR_SYNC_QA_DATABASE_PREFIX}${role.toLowerCase()}_qa`,SESSION_SECRET:'isolated-sync-qa-secret-at-least-32-characters',QA_ROLE:role,QA_PORT:String(port),QA_OTHER:String(other)},stdio:['ignore','pipe','pipe']});children.push(child);
 let output='';child.stderr?.on('data',b=>{output+=b;});
 await new Promise<void>((resolve,reject)=>{child.stdout?.on('data',b=>{if(String(b).includes('READY'))resolve();});child.once('exit',()=>reject(new Error(output)));setTimeout(()=>reject(new Error('fixture startup timeout')),10000).unref();});
}
async function qa(port:number,op:string,input:object={}){const response=await fetch(`http://127.0.0.1:${port}/qa`,{method:'POST',headers:{'content-type':'application/json','x-qa':'isolated-test'},body:JSON.stringify({op,...input})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
try{
 await start('PUBLIC',publicPort,localPort);await start('LOCAL',localPort,publicPort);
 await qa(publicPort,'setup');await qa(localPort,'setup');await qa(localPort,'import');
 const count=320;await qa(publicPort,'volatile-sessions',{count});
 // Every exchange changes all heartbeat timestamps. More than 8 x 32 entries
 // must eventually drain across runs without repeatedly resampling the head.
 let runs=0;
 for(;runs<8;){await qa(localPort,'sync-once');runs++;if((await qa(localPort,'volatile-stats')).count===count)break;}
 const source=await qa(publicPort,'volatile-stats'),received=await qa(localPort,'volatile-stats');
 assert.ok(source.ticks>=10&&runs>1,'must cross a bounded run as well as a page boundary');
 assert.equal(received.count,count,'continuously changing first-page sessions cannot starve later identities');
 console.log(`PASS all ${count} changing live sessions synchronize in ${runs} bounded runs (${source.ticks} exchanges)`);
}finally{for(const child of children)child.kill('SIGTERM');}
