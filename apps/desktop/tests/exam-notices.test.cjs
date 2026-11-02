const {test}=require('node:test'),assert=require('node:assert/strict');
require('../src/renderer/exam-notices');
const identity={serverUrl:'https://monitor.example',sessionId:'session'};
const item=(id,candidateId=null)=>({id,content:'通知 '+id,candidateId,createdAt:'2026-10-16T10:00:00.000Z',acknowledged:false});

test('targeted and public announcements are queued once and confirmed using the announcement receipt API',async()=>{
 let state;const acknowledgements=[];
 const inbox=createProctorNoticeInbox({read:async()=>({announcements:[item('private','candidate'),item('public')]}),acknowledge:async(scope,id)=>acknowledgements.push({scope,id}),render:next=>state=next});
 await inbox.poll(identity);await inbox.poll(identity);assert.equal(state.current.id,'private');await inbox.confirm();assert.equal(state.current.id,'public');await inbox.poll(identity);await inbox.confirm();assert.equal(state.current,null);assert.deepEqual(acknowledgements.map(x=>x.id),['private','public']);
});

test('failed confirmations keep the notice open and switching sessions rejects late private notices',async()=>{
 let state,finish;const inbox=createProctorNoticeInbox({read:scope=>scope.sessionId==='old'?new Promise(resolve=>{finish=resolve;}):Promise.resolve({announcements:[item('new')]}),acknowledge:async()=>{throw Error('offline');},render:next=>state=next});
 const old=inbox.poll({...identity,sessionId:'old'});await inbox.poll(identity);finish({announcements:[item('old-private')]});await old;assert.equal(state.current.id,'new');await inbox.confirm();assert.equal(state.current.id,'new');assert.match(state.error,/重试/);inbox.clear();assert.equal(state.current,null);
});
