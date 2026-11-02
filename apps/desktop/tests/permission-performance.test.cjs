const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const renderer=fs.readFileSync(require.resolve('../src/renderer/renderer.js'),'utf8');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('permission refresh starts independent screen, network and system probes together and uses fresh domain status', async()=>{
 const jobs=Object.fromEntries(['permissions','capabilities','network','screen','domain'].map(k=>[k,deferred()]));const started=[];
 const state={serverUrl:'https://proctor.example'};
 const ctx={state,URL,window:{proctorApi:{getSystemPermissionStatus:()=>{started.push('permissions');return jobs.permissions.promise;},getSecurityCapabilities:()=>{started.push('capabilities');return jobs.capabilities.promise;},testScreenCapture:()=>{started.push('screen');return jobs.screen.promise;},startNetworkDomainMonitor:()=>{started.push('domain');return jobs.domain.promise;}}},probeServerAccess:()=>{started.push('network');return jobs.network.promise;},errorMessage:String,setCheck(){},networkAccessOk:()=>true,networkAccessDetail:()=>'',setActionVisibility(){},renderCapabilityPanel(){},setPermissionHint(){}};
 vm.runInNewContext(renderer.slice(renderer.indexOf('async function refreshPermissionStatus('),renderer.indexOf('function formatDuration(')),ctx);
 const pending=ctx.refreshPermissionStatus();assert.deepEqual(started.sort(),['capabilities','domain','network','permissions','screen']);
 jobs.permissions.resolve({platform:'win32'});jobs.capabilities.resolve({processScan:true,networkScan:false,networkDomainStatus:{state:'idle'}});jobs.network.resolve([{ok:true}]);jobs.screen.resolve({ok:true});jobs.domain.resolve({state:'limited'});
 const result=await pending;assert.equal(result.capabilities.networkScan,true);assert.equal(result.capabilities.networkDomainStatus.state,'limited');assert.equal(state.screenCaptureProbe.ok,true);
});
test('preflight reuses validated hardware results without waiting for an unused full process signature scan', async()=>{
 const caps={elevated:true,processScan:true,networkScan:true,hardwareScan:true,vmScan:true,activeWindow:true,vmSignals:[],peripheralsFingerprint:'usb-v5:'+('a'.repeat(64))};
 const state={allPermissionsGranted:true,serverUrl:'https://proctor.example'};
 const ctx={state,URL,configureCaptureProfile(){},window:{proctorApi:{getDesktopInfo:async()=>({deviceId:'device'}),getSecuritySnapshot:()=>{throw new Error('expensive unused scan must not run');}}},refreshPermissionStatus:async()=>({permissions:{platform:'win32'},capabilities:caps}),updateSetupButtons(){},setCheck(){},renderCapabilityPanel(){},networkAccessOk:()=>true,networkAccessDetail:()=>'',showError(){},showToast(){}};
 vm.runInNewContext(renderer.slice(renderer.indexOf('async function detectSystemPermissions('),renderer.indexOf('async function detectMedia(')),ctx);
 assert.equal(await ctx.detectSystemPermissions(),true);assert.equal(state.baselineFingerprint,caps.peripheralsFingerprint);
 caps.vmSignals=['vmware'];assert.equal(await ctx.detectSystemPermissions(),false);assert.equal(state.systemReady,false);
 delete caps.vmSignals;assert.equal(await ctx.detectSystemPermissions(),false);assert.equal(state.systemReady,false);
});
test('concurrent signer checks for the same unchanged executable start one signature process and retry failed checks',async()=>{
 const module={exports:{}};let stamp=1,calls=0,fail=false;
 vm.runInNewContext(fs.readFileSync(require.resolve('../dist/main/process-policy'),'utf8'),{module,exports:module.exports,process:{platform:'win32',env:{}},require:id=>{
  if(id==='./windows-system-command')return require('../dist/main/windows-system-command');
  if(id==='node:fs')return {readFileSync:()=>'{"version":1,"executables":{}}',statSync:()=>({ino:1,size:12,mtimeMs:stamp,ctimeMs:stamp}),realpathSync:x=>x};
  if(id==='node:child_process')return {execFile:(_file,_args,_options,callback)=>{calls++;setImmediate(()=>callback(fail?new Error('signature unavailable'):null,'CN=Microsoft Corporation, O=Microsoft Corporation',''));}};
  return require(id);
 }});
 const policy=module.exports.installedProcessPolicy('manifest');const file='C:\\Windows\\System32\\svchost.exe';
 const result=await Promise.all(Array.from({length:32},()=>policy.signer(file,'win32')));assert.equal(calls,1);assert(result.every(x=>x===result[0]));
 await policy.signer(file,'win32');assert.equal(calls,1);
 stamp++;fail=true;await assert.rejects(policy.signer(file,'win32'));assert.equal(calls,2);
 fail=false;await policy.signer(file,'win32');assert.equal(calls,3);
});
