const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {RendererRecoveryStore}=require('../dist/main/renderer-recovery');
const sample=()=>({serverUrl:'https://proctoring.example.test',sessionServerOrigin:'https://proctoring.example.test',sessionToken:'desktop-token',
 session:{id:'session',examId:'exam',candidateId:'candidate',status:'LOCKED',approvedAt:'2026-10-13T00:00:00Z',startedAt:'2026-10-13T00:00:00Z',lockdown:true,lockdownReason:'外设接入'},
 exam:{id:'exam',endAt:'2026-10-13T02:00:00Z',platformBaseUrl:'https://contest.example'},candidate:{id:'candidate',password:'must-not-retain'},
 requirements:{requireFrontCamera:true},baselineFingerprint:'usb-v4:original',pairCode:'123456',pairPollToken:'poll-token'});
test('recovery retains the original credentials, clock and lockdown only during a real recovery',()=>{
 const store=new RendererRecoveryStore();store.save(sample());assert.equal(store.read(),null);assert.equal(store.begin(true),true);
 const saved=store.read();assert.equal(saved.sessionToken,'desktop-token');assert.equal(saved.session.startedAt,sample().session.startedAt);
 assert.equal(saved.session.lockdown,true);assert.equal(saved.candidate.password,undefined);assert.equal(saved.baselineFingerprint,'usb-v4:original');
 saved.session.startedAt='tampered';assert.equal(store.read().session.startedAt,sample().session.startedAt);
 store.restored();assert.equal(store.read(),null);store.save(null);assert.equal(store.begin(true),false);
});
test('recovery refuses mixed servers, candidates, finished sessions and rapid crash loops',()=>{
 let now=0;const store=new RendererRecoveryStore(()=>now);
 assert.throws(()=>store.save({...sample(),sessionServerOrigin:'https://other.example'}));
 assert.throws(()=>store.save({...sample(),candidate:{id:'other'}}));
 assert.throws(()=>store.save({...sample(),session:{...sample().session,status:'FINISHED'}}));
 store.save(sample());for(let i=0;i<3;i++)assert.equal(store.begin(true),true);assert.equal(store.begin(true),false);
 now=120001;assert.equal(store.begin(true),true,'isolated later failures get a fresh recovery budget');
});
test('a recovered renderer authenticates before reopening the contest and keeps camera policy and clock',async()=>{
 const source=fs.readFileSync(require.resolve('../src/renderer/renderer.js'),'utf8');
 const start=source.indexOf('async function restoreRendererRecovery('),end=source.indexOf('\nfunction apiUrl(',start);
 const calls=[],state={desktopInfo:{os:'win32 6.1.7601'}},nodes=new Map();
 const context=vm.createContext({state,URL,console,$:id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',inert:false});return nodes.get(id);},
 window:{PROCTOR_RELEASE_CHANNEL:'unified',proctorApi:{setAllowedHosts:async()=>calls.push('hosts'),setContestScope:async()=>calls.push('scope'),rendererRecoveryComplete:async()=>calls.push('complete')},setInterval:()=>1},
 setOnly:()=>{},contestWebsiteOrigin:()=>'',sendHeartbeat:async()=>{calls.push('authenticate');state.session={...state.session,status:'IN_EXAM'};state.requirements={...state.requirements,reactionEnabled:true};},
 startSubmittedMonitoring:async()=>calls.push('monitor'),ensureScreenCapture:async()=>calls.push('screen'),ensureCameraCapture:async()=>calls.push('camera'),
 startSegmentRecorders:()=>{assert.equal(state.requirements.reactionEnabled,true,'recovered recording uses authenticated server requirements');calls.push('record');},startRtmpStreams:async()=>calls.push('publish'),enterApproved:async()=>calls.push('contest'),pollPair:()=>{}});
 vm.runInContext(source.slice(start,end),context);await context.restoreRendererRecovery(sample());
 assert.deepEqual(calls,['hosts','scope','authenticate','monitor','screen','camera','record','publish','contest','complete']);
 assert.equal(state.session.startedAt,sample().session.startedAt);assert.equal(state.sessionToken,'desktop-token');assert.equal(nodes.get('app').inert,false);
 calls.length=0;context.sendHeartbeat=async()=>{calls.push('authenticate');throw Error('offline');};
 await assert.rejects(context.restoreRendererRecovery(sample()),/offline/);assert.deepEqual(calls,['hosts','scope','authenticate']);assert.equal(nodes.get('app').inert,true);
});
