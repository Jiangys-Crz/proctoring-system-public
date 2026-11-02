// Real local proctor backend + real local NovaJudge, isolated Electron profile.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {createRequire}from 'node:module';
import {readFile,writeFile,mkdir}from 'node:fs/promises';
import {_electron,chromium}from 'playwright-core';
import sharp from 'sharp';
import {prisma}from '../src/lib/db';
import {mediaApiToken}from '../src/lib/media-api-auth';
import {pushExternalBoard}from '../src/lib/external-board';

assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/proctor_novajudge_qa');
const root=path.resolve('../..'),dir=path.join(root,'tmp/novajudge-live'),desktop=path.join(root,'apps/desktop'),req=createRequire(path.join(desktop,'package.json'));
const access=JSON.parse(await readFile(path.join(dir,'access.json'),'utf8')),base=access.base,nova='http://localhost:3001',cid=access.novaContestId;
const novaAccess=JSON.parse(await readFile(process.env.NOVAJUDGE_ACCESS_FILE || new URL('../../../../NovaJudge/.local/access.json', import.meta.url),'utf8'));
const submissionMarker='live-client-qa-'+Date.now();
const results:any[]=[];let app:any,page:any,sid='',trapRequests=0;
await mkdir(path.join(dir,'reports'),{recursive:true});
async function test(name:string,fn:()=>Promise<any>){const start=Date.now();try{results.push({name,status:'PASS',ms:Date.now()-start,detail:await fn()});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',error:e instanceof Error?e.message:String(e)});console.log('FAIL',name,results.at(-1).error);if(page&&name.includes('Monaco')){console.log(await page.evaluate('({status:state.session?.status,loaded:state.contestPageLoaded,loading:state.contestPageLoading})'));console.log(await guest('({path:location.pathname,text:document.body.innerText.slice(0,1400),monaco:typeof window.monaco})'));await page.screenshot({path:path.join(dir,'reports/monaco-failure.png')});}}await writeFile(path.join(dir,'reports/client-tests.json'),JSON.stringify(results,null,2));}
async function poll(fn:()=>Promise<boolean>,message:string,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,300));}throw new Error(message);}
const guest=(script:string)=>page.evaluate((s:string)=>(document.getElementById('ojView')as any).executeJavaScript(s),script);
const trap=http.createServer((_r,s)=>{trapRequests++;s.end('external');});await new Promise<void>(r=>trap.listen(0,'127.0.0.1',r));const external=`http://127.0.0.1:${(trap.address()as any).port}`;
const auth=await fetch(base+'/api/auth/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:access.adminUsername,password:access.adminPassword})});assert.equal(auth.status,200);const adminCookie=auth.headers.get('set-cookie')!.split(';')[0];
const adminRequest=(route:string,method='GET',data?:any)=>fetch(base+route,{method,headers:{Cookie:adminCookie,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
await prisma.exam.update({where:{id:access.examId},data:{requireFrontCamera:true}});await prisma.examRoom.update({where:{id:access.roomId},data:{requireFrontCamera:true}});
const wrapper=path.join(dir,'launch.cjs');await writeFile(wrapper,`const{app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir,'desktop-data'))});require(${JSON.stringify(path.join(desktop,'dist/main/bootstrap.js'))});`);
try{
 app=await _electron.launch({executablePath:req('electron'),args:[wrapper],cwd:desktop,bypassCSP:true,env:{...process.env,PROCTOR_DEV:'0',NODE_EXTRA_CA_CERTS:path.join(dir,'certs/server.crt')}});page=await app.firstWindow();await page.waitForFunction('typeof enterApproved==="function"');
 await app.evaluate(({session}:any,folder:string)=>{session.fromPartition('persist:proctor-oj').on('will-download',(_event:any,item:any)=>item.setSavePath(folder+'/'+item.getFilename()));},path.join(dir,'reports'));
 await test('真实客户端系统权限与屏幕、摄像头采集',async()=>{const p=await page.evaluate('window.proctorApi.getSystemPermissionStatus()');assert.equal(p.media.screen,'granted');assert.equal(p.media.camera,'granted');const sources=await page.evaluate('window.proctorApi.getDesktopSources()');assert(sources.length);return {screen:p.media.screen,camera:p.media.camera,accessibility:p.accessibility};});
 await test('客户端考号密码登录真实监考后台、管理员审核',async()=>{
  await page.evaluate(`(async()=>{state.serverUrl=${JSON.stringify(base)};await window.proctorApi.setAllowedHosts(['127.0.0.1','localhost']);state.desktopInfo=await window.proctorApi.getDesktopInfo();state.baselineFingerprint=await window.proctorApi.confirmPeripheralBaseline();window.confirm=()=>true;setOnly('loginPanel');selectLoginMethod('credentials');})()`);
  const pair=await page.evaluate(`api('/api/client/pair',{method:'POST',body:JSON.stringify({...state.desktopInfo,screenOk:true,desktopCameraOk:true,peripheralsFingerprint:state.baselineFingerprint})})`);
  await page.locator('#loginExamCode').fill(access.examCode);await page.locator('#loginName').fill(access.name);await page.locator('#loginExamNumber').fill(access.examNumber);await page.locator('#loginPassword').fill(access.password);
  const login=await page.evaluate(`api('/api/client/credential-login',{method:'POST',body:JSON.stringify({pairCode:${JSON.stringify(pair.pairCode)},examCode:document.getElementById('loginExamCode').value,name:document.getElementById('loginName').value,examNumber:document.getElementById('loginExamNumber').value,password:document.getElementById('loginPassword').value})})`);
  sid=login.sessionId;assert(sid);const review=await adminRequest('/api/login-requests/'+login.id+'/review','POST',{approved:true});assert.equal(review.status,200,await review.clone().text());
  await page.evaluate(`(async()=>{state.pairCode=${JSON.stringify(pair.pairCode)};state.pairPollToken=${JSON.stringify(pair.pollToken)};await pollPair();})()`);
  await poll(()=>page.evaluate('state.session?.status==="APPROVED"'),'Client did not receive approval');assert.equal((await prisma.clientSession.findUniqueOrThrow({where:{id:sid}})).status,'APPROVED');
  assert.equal(await page.locator('#novaJudgeWaiting').isVisible(),true);assert.equal(await guest('location.href'),'about:blank');
 });
 assert(sid,'Cannot continue without a real approved session');
 await test('点击开始后自动登录真实 NovaJudge 并进入比赛详情',async()=>{
  await page.locator('#startBtn').click();await poll(()=>page.evaluate('state.contestPageLoaded'),'NovaJudge auto-login did not complete',60000);
  assert.equal(await guest('location.pathname'),`/contest/${cid}`);const body=await guest('document.body.innerText');assert(body.includes('本机功能验收赛'));assert(body.includes('本机测试队')||body.includes(access.examNumber));
  assert.equal(await page.locator('#novaJudgeWaiting').isVisible(),false);const cookie=await app.evaluate(async({session}:any,url:string)=>session.fromPartition('persist:proctor-oj').cookies.get({url}),nova);assert(cookie.some((c:any)=>c.name==='user_token'&&c.httpOnly));assert.equal(await guest('typeof window.proctorApi'),'undefined');
  await new Promise(r=>setTimeout(r,1000));await page.screenshot({path:path.join(dir,'reports/auto-login.png')});return {path:await guest('location.pathname'),platform:'real NovaJudge'};
 });
 await test('真实题面导航与文件下载',async()=>{
  await guest(`location.href='/contest/${cid}/problems/A'`);await poll(async()=>(await guest('document.body.innerText')).includes('A + B'),'Problem did not render');
  await guest(`(()=>{const a=document.createElement('a');a.href='/api/problems/${access.novaProblemId}/assets/'+encodeURIComponent('验收附件.txt');a.textContent='下载验收附件';document.body.append(a);a.click();})()`);
  await poll(async()=>{try{return(await readFile(path.join(dir,'reports/验收附件.txt'),'utf8'))==='NovaJudge download verification\n';}catch{return false;}},'Real NovaJudge attachment was not downloaded');
 });
 await test('外部网页、弹窗、外部资源与其他比赛被阻止',async()=>{
  await guest(`(()=>{fetch(${JSON.stringify(external+'/xhr')}).catch(()=>{});const img=new Image();img.src=${JSON.stringify(external+'/image')};document.body.append(img);window.open(${JSON.stringify(external+'/popup')});const a=document.createElement('a');a.href=${JSON.stringify(external+'/outside')};document.body.append(a);a.click();})()`);await new Promise(r=>setTimeout(r,1000));assert.equal(trapRequests,0);
  assert.equal((await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows().filter((w:any)=>w.webContents.getURL().includes('outside')).length)),0);
  await guest(`location.href='/contest/${cid+99999}'`);await new Promise(r=>setTimeout(r,700));assert([`/contest/${cid}`,`/contest/${cid}/problems/A`].includes(await guest('location.pathname')));
 });
 await test('客户端内 NovaJudge Monaco 提交并真实判题',async()=>{
  await poll(()=>page.evaluate('state.contestPageLoaded && !state.contestPageLoading'),'Client did not finish recovering from the blocked navigation',30000);
  const code='#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}\n// '+submissionMarker;
  await guest(`location.href='/contest/${cid}/submit?problem=A'`);await poll(()=>guest('!!window.monaco?.editor?.getModels().length'),'Monaco editor did not load',45000);
  await guest(`window.monaco.editor.getModels()[0].setValue(${JSON.stringify(code)});`);await new Promise(r=>setTimeout(r,300));await guest('document.querySelector("button[type=submit]").click()');
  await poll(async()=>await guest('location.pathname')===`/contest/${cid}/status`,'Client submission did not redirect');
  await poll(async()=>{const r=await fetch(nova+`/api/contests/${cid}/submissions`,{headers:{'x-api-key':novaAccess.apiKey}});const list=await r.json();return list.some((s:any)=>s.code.includes(submissionMarker)&&s.status==='Accepted');},'This client submission did not receive AC',45000);
  await page.screenshot({path:path.join(dir,'reports/submission.png')});
 });
 await test('屏幕与前置摄像头真实推流、监考端确认收到数据',async()=>{
  await poll(async()=>{const r=await fetch('http://127.0.0.1:49997/v3/paths/list',{headers:{Authorization:'Bearer '+mediaApiToken()}});if(r.status!==200)return false;const b=await r.json();return ['DESKTOP_SCREEN','DESKTOP_CAMERA'].every(ch=>b.items.some((p:any)=>p.name===`live/${sid}_${ch}`&&p.ready&&p.bytesReceived>0));},'Media service did not receive both real client channels',60000);
  const r=await adminRequest(`/api/exams/${access.examId}/state`);assert.equal(r.status,200);const b=await r.json();assert(b.data.liveReadySessionIds.includes(sid));return {screen:true,camera:true};
 });
 await test('后台下发控屏图片、客户端展示与解除',async()=>{
  const image=await sharp({create:{width:800,height:450,channels:3,background:'#1759ad'}}).png().toBuffer(),form=new FormData();form.set('name','NovaJudge 联调控屏');form.append('files',new File([new Uint8Array(image)],'control.png',{type:'image/png'}));
  const group=await fetch(base+`/api/exams/${access.examId}/screen-control/groups`,{method:'POST',headers:{Cookie:adminCookie},body:form});assert.equal(group.status,201,await group.clone().text());const g=(await group.json()).data;
  const display=await adminRequest(`/api/exams/${access.examId}/screen-control`,'POST',{groupId:g.id});assert.equal(display.status,201);const d=(await display.json()).data;
  await poll(()=>page.evaluate('window.proctorApi.isScreenControlDisplaying()'),'Client did not show screen control',15000);await page.screenshot({path:path.join(dir,'reports/screen-control-main.png')});
  const stop=await adminRequest(`/api/exams/${access.examId}/screen-control`,'PATCH',{action:'STOP',displayId:d.id});assert.equal(stop.status,200);await poll(async()=>!await page.evaluate('window.proctorApi.isScreenControlDisplaying()'),'Screen control did not stop',15000);
 });
 await test('客户端异常上报、真实心跳、USB 变化锁定与管理员解锁',async()=>{
  await page.evaluate(`reportAlert('SCREEN_SWITCH',4,'本机真实客户端异常上报验收',true)`);await poll(async()=>await prisma.alert.count({where:{sessionId:sid,type:'SCREEN_SWITCH'}})>0,'Client alert was not persisted');
  const token=await page.evaluate('state.sessionToken'),info=await page.evaluate('state.desktopInfo');
  const r=await fetch(base+'/api/client/heartbeat',{method:'POST',headers:{'Content-Type':'application/json','x-proctor-session-token':token},body:JSON.stringify({sessionId:sid,deviceId:info.deviceId,side:'DESKTOP',capture:{screenOk:true,desktopCameraOk:true},system:{peripheralsFingerprint:'mac-usb-v3:'+('a'.repeat(64))}})});assert.equal(r.status,200);assert.equal((await r.json()).data.session.status,'LOCKED');
  await poll(()=>page.evaluate('state.session?.status==="LOCKED"'),'Client did not show locked status',15000);
  await page.evaluate('heartbeatTick()');
  const unlock=await adminRequest('/api/sessions/'+sid+'/unlock','POST',{reason:'本机功能验收，恢复考试'});assert.equal(unlock.status,200);await poll(()=>page.evaluate('state.session?.status==="IN_EXAM"&&!state.session.lockdown'),'Client did not unlock',15000);
 });
 await test('真实 NovaJudge 外榜数据进入监考推送流程',async()=>{
  const records:any[]=[];const receiver=http.createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const b=JSON.parse(Buffer.concat(chunks).toString());records.push({path:req.url,submissions:b.submissions,problems:b.problems});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:200,data:b.submissions?`成功处理并保存了 ${b.submissions.length} 条提交记录`:'成功更新题目'}));});await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));
  try{await prisma.exam.update({where:{id:access.examId},data:{externalBoardEnabled:true,externalBoardBaseUrl:`http://127.0.0.1:${(receiver.address()as any).port}/api`,externalBoardEventId:'123',externalBoardApiKey:'local-live-receiver'}});await pushExternalBoard(access.examId);assert(records.some(r=>r.problems?.length));assert(records.some(r=>r.submissions?.some((s:any)=>s.username===access.examNumber&&s.status==='Accepted')));return {receivedRecords:records.reduce((n,r)=>n+(r.submissions?.length||0),0)};}finally{await prisma.exam.update({where:{id:access.examId},data:{externalBoardEnabled:false}});receiver.closeAllConnections();await new Promise<void>(r=>receiver.close(()=>r()));}
 });
 await test('NovaJudge 密码错误、客户端重试与重新登录',async()=>{
  await prisma.candidate.update({where:{id:access.candidateId},data:{password:'incorrect-test-password'}});await page.evaluate('state.contestPageLoaded=false;state.contestPageRetryAt=0;openContestHome();');await poll(()=>page.evaluate('!state.contestPageLoading&&!document.getElementById("novaJudgeRetryBtn").classList.contains("hidden")'),'Login failure did not offer retry');
  assert.equal(await page.locator('#monitorPreview').isVisible(),false);
  await prisma.candidate.update({where:{id:access.candidateId},data:{password:access.password}});await page.locator('#novaJudgeRetryBtn').click();await poll(()=>page.evaluate('state.contestPageLoaded'),'Real NovaJudge retry did not succeed',30000);assert.equal(await guest('location.pathname'),`/contest/${cid}`);
 });
 await test('屏幕和摄像头录像片段实际保存',async()=>{
  await poll(async()=>{const records=await prisma.mediaSegment.findMany({where:{sessionId:sid,deletedAt:null},select:{channel:true}});return ['DESKTOP_SCREEN','DESKTOP_CAMERA'].every(ch=>records.some(r=>r.channel===ch));},'Recorded segments were not stored',30000);
  return {segments:await prisma.mediaSegment.count({where:{sessionId:sid,deletedAt:null}})};
 });
 await test('普通 Chrome 网页登录和复制客户端 Cookie 均被阻止',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
   const context=await browser.newContext(),web=await context.newPage();
   await web.goto(`${nova}/contest/${cid}?autoLogin=miss`);await web.locator('input[name=username]').fill(access.examNumber);await web.locator('input[name=password]').fill(access.password);await web.getByRole('button',{name:'Sign In',exact:true}).click();
   await web.waitForURL('**error=proctoring_required');assert((await web.locator('body').innerText()).includes('请通过监考客户端'));
   const cookies=await app.evaluate(async({session}:any,url:string)=>session.fromPartition('persist:proctor-oj').cookies.get({url}),nova);
   await context.addCookies(cookies.filter((c:any)=>c.name==='user_token').map((c:any)=>({name:c.name,value:c.value,url:nova,httpOnly:true,sameSite:'Lax'})));
   const response=await web.goto(`${nova}/contest/${cid}`);assert.equal(response?.status(),403);assert((await web.locator('body').innerText()).includes('请通过监考客户端'));
   const ordinary=await fetch(nova+'/api/cli/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:access.examNumber,password:access.password,contestId:cid})});assert.equal(ordinary.status,403);
   return {browserCredentialsBlocked:true,copiedCookieBlocked:true};
  }finally{await browser.close();}
 });
 await test('结束考试、清理 NovaJudge 登录 Cookie 与拒绝再次登录',async()=>{
  await page.evaluate('finishExam()');const text=await page.locator('#finishConfirmExpected').innerText();await page.locator('#finishConfirmInput').fill(text);await page.locator('#finishConfirmSubmit').click();await poll(()=>page.evaluate('state.finishedScreenVisible'),'Client did not finish');
  assert.equal((await prisma.clientSession.findUniqueOrThrow({where:{id:sid}})).status,'FINISHED');assert.equal((await app.evaluate(async({session}:any,url:string)=>session.fromPartition('persist:proctor-oj').cookies.get({url}),nova)).length,0);
 });
}finally{
 if(sid)await prisma.clientSession.updateMany({where:{id:sid},data:{status:'FINISHED',lockdown:false,endedAt:new Date()}}).catch(()=>{});
 if(app){await app.evaluate(({app}:any)=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}trap.closeAllConnections();await new Promise<void>(r=>trap.close(()=>r()));await prisma.$disconnect();
}
console.log('Completed',results.filter(r=>r.status==='PASS').length,'PASS',results.filter(r=>r.status==='FAIL').length,'FAIL');process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
