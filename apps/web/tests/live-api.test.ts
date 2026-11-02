import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateLiveApiKey, liveApiKeyHash, validLiveApiKey } from '../src/lib/live-api-key';
import { createLiveApiReadToken, verifyLiveApiReadToken } from '../src/lib/live-api-token';
import { createMediaReadToken, verifyMediaReadToken } from '../src/lib/media-read-token';
import { parseLiveStreamRequest, serveLiveStream } from '../src/lib/live-stream';
import { POST as mediaAuth } from '../src/app/api/media/auth/route';
import { prisma } from '../src/lib/db';
import { copyHlsQuery, fetchHlsAsset } from '../src/lib/media-hls-proxy';

test('live keys are independently generated, path safe, and persisted by hash only', () => {
  const keys = Array.from({ length: 100 }, generateLiveApiKey);
  assert.equal(new Set(keys).size, 100);
  for (const key of keys) { assert(validLiveApiKey(key)); assert.equal(key.length, 48); assert.equal(liveApiKeyHash(key).length, 64); assert.notEqual(liveApiKeyHash(key), key); }
  for (const key of ['', 'hydro_' + 'a'.repeat(43), 'live_' + 'a'.repeat(42), 'live_' + '/'.repeat(43)]) assert.equal(validLiveApiKey(key), false);
});

test('exact requested paths and query aliases map only 1/2/3 and reject resource traversal', () => {
  const key = generateLiveApiKey(), request = new Request('https://example.test/api/2026101301/1001/1?apikey=' + key);
  for (const [camera, channel] of [['1', 'DESKTOP_SCREEN'], ['2', 'DESKTOP_CAMERA'], ['3', 'MOBILE_CAMERA']]) {
    assert.equal(parseLiveStreamRequest(request, { examCode: '2026101301', examNumber: '1001', camera, stream: ['apikey=' + key] }).channel, channel);
  }
  assert.equal(parseLiveStreamRequest(request, { examCode: '2026101301', examNumber: '1001', camera: '1' }).key, key);
  for (const changes of [{camera:'4'}, {camera:'toString'}, {examCode:'../api'}, {examNumber:'../1001'}, {stream:['apikey='+key,'session','..']}, {stream:['apikey='+key,'session','%2f']}, {stream:['apikey='+key,'session']}, {stream:['not-a-key']}]) {
    assert.throws(() => parseLiveStreamRequest(request, { examCode: '2026101301', examNumber: '1001', camera: '1', ...changes }));
  }
});

test('upstream live credentials cannot grant another session, channel, normal viewer access or expired access', () => {
  const now = Date.now(), token = createLiveApiReadToken('key-a', 'session-a', 'DESKTOP_SCREEN', now);
  assert.equal(verifyLiveApiReadToken(token, 'session-a', 'DESKTOP_SCREEN', now)?.keyId, 'key-a');
  assert.equal(verifyLiveApiReadToken(token, 'session-b', 'DESKTOP_SCREEN', now), null);
  assert.equal(verifyLiveApiReadToken(token, 'session-a', 'DESKTOP_CAMERA', now), null);
  assert.equal(verifyLiveApiReadToken(token, 'session-a', 'DESKTOP_SCREEN', now + 60000), null);
  assert.equal(verifyMediaReadToken(token, 'session-a', 'DESKTOP_SCREEN', now), null);
  assert.equal(verifyLiveApiReadToken(createMediaReadToken('admin', 'session-a', 'DESKTOP_SCREEN', now), 'session-a', 'DESKTOP_SCREEN', now), null);
  assert.equal(verifyLiveApiReadToken(token + '.extra', 'session-a', 'DESKTOP_SCREEN', now), null);
});

test('all three WebRTC streams retain fresh key checks and scoped resources', async () => {
  const originals={key:prisma.liveApiKey.findUnique,session:prisma.clientSession.findFirst,fresh:prisma.clientSession.findUnique,room:prisma.examRoom.findFirst,fetch:globalThis.fetch,transaction:prisma.$transaction,query:prisma.$queryRaw,create:prisma.liveWebRtcConnection.create,read:prisma.liveWebRtcConnection.findUnique,remove:prisma.liveWebRtcConnection.deleteMany};
  const key=generateLiveApiKey();let enabled=true,calls=0,cameraRequired=true;const connections=new Map<string,any>();
  prisma.liveApiKey.findUnique=(async(args:any)=>args.where.keyHash===liveApiKeyHash(key)||args.where.id==='key-a'?{id:'key-a',enabled}:null)as any;
  prisma.clientSession.findFirst=(async(args:any)=>{assert.equal(args.where.candidate.examNumber,'1001');return{id:'session-a',examId:'exam-a',candidateId:'candidate-a',status:'IN_EXAM',revokedAt:null};})as any;
  prisma.clientSession.findUnique=(async()=>({status:'IN_EXAM',revokedAt:null}))as any;
  prisma.examRoom.findFirst=(async()=>({requireFrontCamera:cameraRequired,requireSecondCamera:cameraRequired}))as any;
  prisma.$transaction=(async(callback:any)=>callback(prisma))as any;prisma.$queryRaw=(async()=>[])as any;
  prisma.liveWebRtcConnection.create=(async({data}:any)=>{connections.set(data.id,data);return data;})as any;
  prisma.liveWebRtcConnection.findUnique=(async({where}:any)=>connections.get(where.id)||null)as any;
  prisma.liveWebRtcConnection.deleteMany=(async({where}:any)=>({count:connections.delete(where.id)?1:0}))as any;
  globalThis.fetch=(async(value,init)=>{calls++;const url=new URL(String(value));const channel=url.pathname.includes('DESKTOP_SCREEN')?'DESKTOP_SCREEN':url.pathname.includes('DESKTOP_CAMERA')?'DESKTOP_CAMERA':'MOBILE_CAMERA';assert.equal(verifyLiveApiReadToken(new Headers(init?.headers).get('authorization')!.slice(7),'session-a',channel)?.keyId,'key-a');assert(!url.href.includes(key));return init?.method==='POST'?new Response('v=0\r\n',{status:201,headers:{location:url.pathname+'/01234567-1234-1234-1234-123456789012','content-type':'application/sdp'}}):new Response(null,{status:204});})as typeof fetch;
  const params={examCode:'2026101301',examNumber:'1001',camera:'1',stream:['apikey='+key]},base='https://example.test/api/2026101301/1001/1/apikey='+key;
  try{
    for(const camera of ['1','2','3']){const page=await serveLiveStream(new Request(base),{...params,camera});assert.equal(page.status,200);assert.match(page.headers.get('content-type')!,/text\/html/);assert((await page.text()).includes('createProctorWebRtcReader'));assert.equal(calls,(Number(camera)-1)*3);
      const opened=await serveLiveStream(new Request(base,{method:'POST',headers:{'content-type':'application/sdp'},body:'v=0\r\n'}),{...params,camera});assert.equal(opened.status,201);const resource=opened.headers.get('location')!;assert(resource.includes('resource='));
      assert.equal((await serveLiveStream(new Request(new URL(resource,base),{method:'PATCH',headers:{'content-type':'application/trickle-ice-sdpfrag'},body:'a=ice-ufrag:test\r\n'}),{...params,camera})).status,204);
      assert.equal((await serveLiveStream(new Request(new URL(resource,base),{method:'DELETE'}),{...params,camera})).status,204);
    }
    assert.equal(connections.size,0);const count=calls;enabled=false;assert.equal((await serveLiveStream(new Request(base),params)).status,401);assert.equal(calls,count);enabled=true;
    cameraRequired=false;assert.equal((await serveLiveStream(new Request(base),{...params,camera:'2'})).status,404);
    assert.equal((await serveLiveStream(new Request(base+'?resource=01234567-1234-1234-1234-123456789012',{method:'DELETE'}),params)).status,403);
    assert.equal((await serveLiveStream(new Request(base),{...params,stream:['apikey='+generateLiveApiKey()]})).status,401);
  }finally{prisma.liveApiKey.findUnique=originals.key;prisma.clientSession.findFirst=originals.session;prisma.clientSession.findUnique=originals.fresh;prisma.examRoom.findFirst=originals.room;prisma.$transaction=originals.transaction;prisma.$queryRaw=originals.query;prisma.liveWebRtcConnection.create=originals.create;prisma.liveWebRtcConnection.findUnique=originals.read;prisma.liveWebRtcConnection.deleteMany=originals.remove;globalThis.fetch=originals.fetch;}
});

test('MediaMTX accepts live credentials for enabled read connections, never publishing', async () => {
  const originals={key:prisma.liveApiKey.findUnique,session:prisma.clientSession.findUnique,room:prisma.examRoom.findFirst};let enabled=true,status='IN_EXAM';
  prisma.liveApiKey.findUnique=(async()=>({enabled}))as any;
  prisma.clientSession.findUnique=(async()=>({examId:'exam',candidateId:'candidate',status,revokedAt:null}))as any;
  prisma.examRoom.findFirst=(async()=>({requireFrontCamera:true,requireSecondCamera:true}))as any;
  const token=createLiveApiReadToken('key-a','session-a','DESKTOP_SCREEN');
  const request=(action='read',protocol='hls',path='live/session-a_DESKTOP_SCREEN')=>new Request('http://localhost/api/media/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,protocol,path,token})});
  try {
    assert.equal((await mediaAuth(request())).status,204);
    status='OFFLINE';assert.equal((await mediaAuth(request())).status,204);
    status='FINISHED';assert.equal((await mediaAuth(request())).status,401);status='IN_EXAM';
    assert.equal((await mediaAuth(request('read','webrtc'))).status,204);
    assert.equal((await mediaAuth(request('publish','rtmp'))).status,401);
    assert.equal((await mediaAuth(request('api','hls'))).status,401);
    enabled=false;assert.equal((await mediaAuth(request())).status,401);
  } finally {prisma.liveApiKey.findUnique=originals.key;prisma.clientSession.findUnique=originals.session;prisma.examRoom.findFirst=originals.room;}
});

test('HLS session negotiation follows only this upstream and stream, with bounded redirects', async () => {
  const original=globalThis.fetch;let count=0;
  const target=new URL('http://media:8080/live/session-a_DESKTOP_SCREEN/index.m3u8');
  const headers=new Headers({authorization:'Bearer private-token'}),signal=AbortSignal.timeout(1000);
  globalThis.fetch=(async(url,init)=>{count++;assert.equal(new Headers(init?.headers).get('authorization'),'Bearer private-token');return count===1?new Response(null,{status:302,headers:{location:'index.m3u8?session=01234567-abcd'}}):new Response('#EXTM3U');})as typeof fetch;
  try{
    const r=await fetchHlsAsset(target,'/live/session-a_DESKTOP_SCREEN',headers,signal);assert.equal(r.response.status,200);assert.equal(r.url.searchParams.get('session'),'01234567-abcd');assert.equal(count,2);
    for(const location of ['http://other.example/live/session-a_DESKTOP_SCREEN/x','/live/session-b_DESKTOP_SCREEN/x']){
      count=0;globalThis.fetch=(async()=>{count++;return new Response(null,{status:302,headers:{location}})})as typeof fetch;
      await assert.rejects(fetchHlsAsset(target,'/live/session-a_DESKTOP_SCREEN',headers,signal));assert.equal(count,1,'the bearer is never sent to a redirected host or another stream');
    }
    count=0;globalThis.fetch=(async()=>{count++;return new Response(null,{status:302,headers:{location:'index.m3u8'}})})as typeof fetch;
    await assert.rejects(fetchHlsAsset(target,'/live/session-a_DESKTOP_SCREEN',headers,signal));assert.equal(count,4);
    const to=new URL(target);copyHlsQuery(new URL('https://example.test/a?session=0123-abcd&_HLS_msn=10&token=must-not-forward&apikey=must-not-forward'),to);assert.equal(to.searchParams.get('session'),'0123-abcd');assert.equal(to.searchParams.has('token'),false);assert.equal(to.searchParams.has('apikey'),false);
  }finally{globalThis.fetch=original;}
});
