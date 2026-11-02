// Build the desktop first. Runs its real main process and renderer with local
// HTTP fixtures and isolated browser storage; does not start media capture.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { _electron as electron } from 'playwright-core';

const desktop = fileURLToPath(new URL('../../desktop/', import.meta.url));
const requireDesktop = createRequire(path.join(desktop, 'package.json'));
const tempBase = path.join(desktop, 'tmp'); await mkdir(tempBase, { recursive: true });
const temp = await mkdtemp(path.join(tempBase, 'novajudge-qa-'));
let externalRequests = 0, loginRequests = 0, loginFailure = false, starts = 0;
let loginGate: Promise<void> | undefined, releaseLogin: (() => void) | undefined;
const headersOnNova: http.IncomingHttpHeaders[] = [];
const listen = async (server: http.Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const trap = http.createServer((_req, res) => { externalRequests++; res.end('external'); });
const external = await listen(trap);
const novaServer = http.createServer((req, res) => {
  headersOnNova.push(req.headers);
  if (req.url === '/api/problems/1/assets/sample.zip') {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="sample.zip"' }); res.end('zip-fixture'); return;
  }
  if (req.url === '/api/problems/1/assets/redirect.zip') { res.writeHead(302, { location: `${external}/redirect.zip` }); res.end(); return; }
  if (req.url === '/api/contests/12/probe') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
  if (req.url?.startsWith('/contest/12')) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.headers.cookie?.includes('user_token=header.payload.signature') && req.headers['x-novajudge-proctor-key'] === 'a'.repeat(43)
      ? `<html><body><h1 id="nova-detail">NovaJudge 比赛详情</h1><a id="next" href="/contest/12/problems">题目</a><a id="file" href="/api/problems/1/assets/sample.zip">样例下载</a><a id="redirect" href="/api/problems/1/assets/redirect.zip">重定向附件</a><a id="other" href="${external}/outside">外部页面</a><img src="${external}/image.png"><script src="${external}/external.js"></script><script>fetch('/api/contests/12/probe')</script></body></html>`
      : '<html><body><input name="password" type="password"></body></html>'); return;
  }
  res.writeHead(404); res.end('unknown');
});
const nova = await listen(novaServer);
const sessionId = 'desktop-nova-fixture';
const backendServer = http.createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  const send = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? { ok: true, data } : { ok: false, message: 'NovaJudge 登录失败，请重试' })); };
  if (req.url === '/api/client/oj-cookie') {
    await loginGate;
    loginRequests++; assert.equal(req.headers['x-proctor-session-token'], 'desktop-token-fixture'); assert.equal(body.sessionId, sessionId);
    return send({ platform: 'NOVAJUDGE', loginUrl: `${nova}/contest/12`, loginSource: 'PROCTORING', proctoringKey: 'a'.repeat(43), cookie: { name: 'user_token', value: 'header.payload.signature' } }, loginFailure ? 502 : 200);
  }
  if (req.url === '/api/client/session/start') { starts++; return send({ id: sessionId, status: 'IN_EXAM', startedAt: new Date().toISOString(), effectiveEndAt: new Date(Date.now() + 3600_000).toISOString() }); }
  if (req.url?.startsWith('/api/client/screen-control')) return send({ active: null });
  send({});
});
const backend = await listen(backendServer);
const wrapper = path.join(temp, 'launch.cjs');
await writeFile(wrapper, `const {app} = require('electron'); app.setPath('userData', ${JSON.stringify(path.join(temp, 'data'))}); require(${JSON.stringify(path.join(desktop, 'dist/main/bootstrap.js'))});`);
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  application = await electron.launch({ executablePath: requireDesktop('electron'), args: [wrapper], cwd: desktop, bypassCSP: true, env: { ...process.env, PROCTOR_DEV: '0' } });
  const page = await application.firstWindow(); await page.waitForFunction('typeof enterApproved === "function"');
  await application.evaluate(({ session }, tempPath) => {
    session.fromPartition('persist:proctor-oj').on('will-download', (_event: unknown, item: { setSavePath(value: string): void; getFilename(): string }) => item.setSavePath(`${tempPath}/${item.getFilename()}`));
  }, temp);
  await page.evaluate(`(async () => {
    state.serverUrl=${JSON.stringify(backend)}; state.sessionToken='desktop-token-fixture'; state.sessionServerOrigin=${JSON.stringify(backend)};
    state.exam={platform:'NOVAJUDGE', platformBaseUrl:${JSON.stringify(nova)}, platformContestId:'12', name:'NovaJudge 监考验证', rules:'请独立答题', startAt:new Date(Date.now()-1000).toISOString(), endAt:new Date(Date.now()+3600000).toISOString(), durationMinutes:60, flexible:false};
    state.candidate={examNumber:'0000123', name:'测试考生'}; state.session={id:${JSON.stringify(sessionId)}, status:'APPROVED'};
    state.requirements={requireFrontCamera:false,requireSecondCamera:false}; window.confirm=()=>true;
    await window.proctorApi.setAllowedHosts(['127.0.0.1']);
    await window.proctorApi.setContestScope(${JSON.stringify(nova)},'12',undefined,'NOVAJUDGE');
    await enterApproved();
  })()`);
  assert.equal(loginRequests, 0); assert.equal(await page.locator('#novaJudgeWaiting').isVisible(), true);
  loginFailure = true; loginGate = new Promise<void>(resolve => { releaseLogin = resolve; });
  await page.locator('#startBtn').click();
  await page.waitForFunction('state.contestPageLoading');
  assert.equal((await page.locator('#novaJudgeWaiting').innerText()).trim(), '正在自动登录NovaJudge 请稍等');
  assert.equal(await page.locator('.novaJudgeSpinner').isVisible(), true);
  assert.equal(await page.locator('.examTopbar').isVisible(), false);
  const viewport=await page.evaluate(() => ({width:window.innerWidth,height:window.innerHeight}));
  const loadingBox=await page.locator('#novaJudgeLoading').boundingBox();assert(loadingBox);
  assert(Math.abs(loadingBox.x+loadingBox.width/2-viewport.width/2)<2);
  assert(Math.abs(loadingBox.y+loadingBox.height/2-viewport.height/2)<2);
  await mkdir(path.resolve(desktop,'../../tmp/novajudge-qa'),{recursive:true});
  await page.screenshot({path:path.resolve(desktop,'../../tmp/novajudge-qa/loading.png')});
  releaseLogin!(); loginGate = undefined;
  await page.waitForFunction('!state.contestPageLoading && !document.getElementById("novaJudgeRetryBtn").classList.contains("hidden")');
  assert.equal((await page.locator('#novaJudgeWaiting').innerText()).trim(), '重新登录');
  assert.equal(await page.locator('.novaJudgeSpinner').isVisible(), false);
  const retryBox=await page.locator('#novaJudgeRetryBtn').boundingBox();assert(retryBox);
  assert(Math.abs(retryBox.x+retryBox.width/2-viewport.width/2)<2);
  assert(Math.abs(retryBox.y+retryBox.height/2-viewport.height/2)<2);
  await page.screenshot({path:path.resolve(desktop,'../../tmp/novajudge-qa/login-failed.png')});
  assert.equal(await page.locator('.examTopbar').isVisible(), false);
  assert.equal(starts, 1); assert.equal(loginRequests, 1, 'failed login leaves a retry button and does not restart the exam clock');
  loginFailure = false; await page.locator('#novaJudgeRetryBtn').click();
  await page.waitForFunction('state.contestPageLoaded');
  const guest = async (script: string) => page.evaluate(script => (document.getElementById('ojView') as any).executeJavaScript(script), script);
  assert.equal(await guest('document.querySelector("#nova-detail").textContent'), 'NovaJudge 比赛详情');
  assert.equal(await guest('document.cookie.includes("user_token")'), false, 'Nova token remains HttpOnly');
  assert.equal(await page.locator('#novaJudgeWaiting').isVisible(), false);
  assert.equal(await guest('typeof window.proctorApi'), 'undefined');
  assert.equal(headersOnNova.filter(headers => headers.cookie?.includes('user_token')).every(headers => headers['x-novajudge-proctor-key'] === 'a'.repeat(43)), true, 'native proof accompanies page, API and download requests');
  assert.equal(headersOnNova.every(headers => !headers['x-proctor-session-token'] && !headers.authorization && !headers['x-api-key']), true);
  await guest('document.querySelector("#next").click()');
  await page.waitForFunction(`document.getElementById('ojView').getURL() === ${JSON.stringify(`${nova}/contest/12/problems`)}`);
  await guest('document.querySelector("#file").click()');
  await page.waitForTimeout(500);
  assert.equal(await readFile(path.join(temp, 'sample.zip'), 'utf8'), 'zip-fixture');
  await guest('document.querySelector("#redirect").click()');
  await guest(`window.open(${JSON.stringify(`${external}/popup`)}); fetch(${JSON.stringify(`${external}/xhr`)}).catch(()=>{});`);
  await page.waitForTimeout(500); assert.equal(externalRequests, 0, 'all external resources and download redirects are blocked before HTTP');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'Nova cannot open an unrestricted window');
  await page.evaluate('(async () => { state.session={...state.session,status:"LOCKED",lockdown:true}; await window.proctorApi.setWindowMode("locked"); state.contestPageLoaded=false; openContestHome(); })()');
  assert.equal(loginRequests, 2, 'locked session does not reauthenticate');
  await page.evaluate('(async () => { state.session={...state.session,status:"IN_EXAM",lockdown:false}; state.contestPageLoaded=true; await window.proctorApi.setWindowMode("floating"); })()');
  await mkdir(path.resolve(desktop, '../../tmp/novajudge-qa'), { recursive: true });
  await page.screenshot({ path: path.resolve(desktop, '../../tmp/novajudge-qa/desktop.png') });
  await page.evaluate('showFinishedScreen("本场考试已结束")');
  assert.equal(await page.locator('#finishedPanel').isVisible(), true);
  assert.equal(await application.evaluate(async ({ session }, origin) => (await session.fromPartition('persist:proctor-oj').cookies.get({ url: origin })).length, nova), 0);
  console.log('NovaJudge Electron integration passed: pre-start gate, start, login failure/retry, HttpOnly cookie, detail page, navigation, real file download, external request/popup/redirect blocks, lock and finish cleanup.');
} catch (error) {
  const page = application?.windows()[0];
  if (page) {
    console.log(await page.evaluate('({platform:state.exam?.platform, panel:document.getElementById("examPanel").className, waiting:document.getElementById("novaJudgeWaiting")?.className, size:document.getElementById("novaJudgeWaiting")?.getBoundingClientRect().toJSON()})'));
    await mkdir(path.resolve(desktop, '../../tmp/novajudge-qa'), { recursive: true });
    await page.screenshot({ path: path.resolve(desktop, '../../tmp/novajudge-qa/desktop-failure.png') });
  }
  throw error;
} finally {
  if (application) { await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); await application.close().catch(() => {}); }
  for (const server of [backendServer, novaServer, trap]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await rm(temp, { recursive: true, force: true });
}
