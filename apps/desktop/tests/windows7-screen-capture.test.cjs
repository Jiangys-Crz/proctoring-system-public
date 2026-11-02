const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const vm=require('node:vm'),fs=require('node:fs');
const {Windows7ScreenCapture,JpegFrameReader,windows7ScreenArgs}=require('../dist/main/windows7-screen-capture');
const bounds={x:-1280,y:0,width:1280,height:1024};
const jpeg=value=>Buffer.from([0xff,0xd8,0x01,value,0xff,0xd9]);
function harness(){const children=[],calls=[];return {children,calls,capture:new Windows7ScreenCapture(()=>'/trusted/ffmpeg.exe',(...args)=>{calls.push(args);const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.killed=0;c.kill=()=>{c.killed++;return true;};children.push(c);return c;})};}

test('Windows 7 captures physical display bounds including taskbars without a window or work-area crop',()=>{
 const args=windows7ScreenArgs(bounds),value=flag=>args[args.indexOf(flag)+1];
 assert.equal(value('-i'),'desktop');assert.equal(value('-f'),'gdigrab');assert.equal(value('-video_size'),'1280x1024');assert.equal(value('-offset_x'),'-1280');assert.equal(value('-offset_y'),'0');
 assert.equal(value('-framerate'),'15');assert.match(value('-vf'),/force_original_aspect_ratio=decrease/);assert(!args.some(x=>/crop|hwnd=|title=/.test(x)));
 for(const b of [{...bounds,width:0},{...bounds,x:NaN},{...bounds,height:50000},{...bounds,width:1.5}])assert.throws(()=>windows7ScreenArgs(b));
});

test('MJPEG framing accepts chunked markers, discards noise and separates consecutive frames',()=>{
 const reader=new JpegFrameReader(),first=jpeg(7),second=jpeg(8);
 assert.deepEqual(reader.push(Buffer.from([1,2,0xff])),[]);
 assert.deepEqual(reader.push(Buffer.concat([first.subarray(1),second.subarray(0,3)])),[first]);
 assert.deepEqual(reader.push(second.subarray(3)),[second]);
 assert.throws(()=>new JpegFrameReader().push(Buffer.alloc(9*1024*1024)),/过大/);
 const incomplete=new JpegFrameReader();assert.throws(()=>incomplete.push(Buffer.concat([Buffer.from([0xff,0xd8]),Buffer.alloc(4*1024*1024)])),/不完整/);
});

test('a slow reader receives only the newest frame, without queueing or launching multiple producers',async()=>{
 const {capture,children,calls}=harness();const id=capture.start(bounds);const first=capture.read(id,0);
 children[0].stdout.write(jpeg(1));assert.equal((await first).sequence,1);
 children[0].stdout.write(Buffer.concat([jpeg(2),jpeg(3),jpeg(4)]));const latest=await capture.read(id,1);assert.equal(latest.sequence,4);assert.deepEqual(Buffer.from(latest.jpeg),jpeg(4));assert.equal(calls.length,1);assert.equal(calls[0][2].windowsHide,true);
 capture.stop(id);assert.equal(children[0].killed,1);await assert.rejects(capture.read(id,4),/已结束/);
});

test('capture recovery shares one producer until both old and replacement tracks have stopped',async()=>{
 const {capture,children}=harness();const old=capture.start(bounds),next=capture.start(bounds);assert.equal(children.length,1);assert.throws(()=>capture.start(bounds),/正在切换/);
 const a=capture.read(old,0),b=capture.read(next,0);children[0].stdout.write(jpeg(1));assert.equal((await a).sequence,(await b).sequence);
 capture.stop(old);assert.equal(children[0].killed,0);const pending=capture.read(next,1);capture.stop(old);assert.equal(children[0].killed,0);
 capture.stop(next);await assert.rejects(pending,/已结束/);assert.equal(children[0].killed,1);
});

test('capture failures reject waiting readers and late old-child events cannot affect a new capture',async()=>{
 const {capture,children}=harness();const old=capture.start(bounds),pending=capture.read(old,0);children[0].emit('error',new Error('device unavailable'));await assert.rejects(pending,/device unavailable/);
 const next=capture.start(bounds),ready=capture.read(next,0);children[0].emit('exit',1);children[0].stdout.write(jpeg(9));children[1].stdout.write(jpeg(2));assert.deepEqual(Buffer.from((await ready).jpeg),jpeg(2));
 const waiting=capture.read(next,1);capture.stopAll();await assert.rejects(waiting,/已结束/);assert.equal(children[1].killed,1);
});

test('changed display bounds invalidate old leases; stale stop cannot kill the replacement',async()=>{
 const {capture,children,calls}=harness();const old=capture.start(bounds),waiting=capture.read(old,0);const next=capture.start({...bounds,width:1920,height:1080});await assert.rejects(waiting,/已结束/);assert.equal(children[0].killed,1);
 capture.stop(old);assert.equal(children[1].killed,0);assert(calls[1][1].includes('1920x1080'));capture.stop(next);
});

test('only Windows 7 uses the compatible source, and a failed capture cannot silently revert to an incomplete source',async()=>{
 const source=fs.readFileSync(require.resolve('../src/renderer/renderer.js'),'utf8');let nativeCalls=0,electronCalls=0;
 const c=vm.createContext({window:{proctorApi:{},proctorCaptureWindows7Screen:async()=>{nativeCalls++;throw Error('native unavailable');}},tryScreenCapture:async(_label,fn)=>fn(),captureElectronScreen:async()=>{electronCalls++;return 'screen';}});
 vm.runInContext(source.slice(source.indexOf('const captureProfile ='),source.indexOf('async function saveRendererRecovery(')),c);
 vm.runInContext(source.slice(source.indexOf('async function captureScreen()'),source.indexOf('async function probeScreenCaptureFrame(')),c);
 c.configureCaptureProfile('win32 6.1.7601');await assert.rejects(c.captureScreen(),/native unavailable/);assert.equal(nativeCalls,1);assert.equal(electronCalls,0);
 c.configureCaptureProfile('win32 10.0.19045');assert.equal(await c.captureScreen(),'screen');assert.equal(electronCalls,1);
 c.configureCaptureProfile('darwin 25.0.0');assert.equal(await c.captureScreen(),'screen');assert.equal(nativeCalls,1);
});

function rendererHarness(){
 let reads=0,draws=0,bitmapsClosed=0,stops=0,tracksStopped=0,finishRead;
 const pending=new Promise(resolve=>{finishRead=resolve;});const track=new EventTarget();track.stop=()=>{tracksStopped++;};
 const canvas={width:0,height:0,getContext:()=>({drawImage(){draws++;}}),captureStream:()=>({getVideoTracks:()=>[track]})};
 const api={startWindows7ScreenCapture:async()=> 'lease',readWindows7ScreenFrame:async()=>++reads===1?{sequence:1,jpeg:jpeg(1)}:pending,stopWindows7ScreenCapture:async()=>{stops++;}};
 const ctx={Blob,Event,document:{createElement:()=>canvas},console,createImageBitmap:async()=>({width:1280,height:1024,close(){bitmapsClosed++;}})};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/renderer/windows7-screen-capture.js'),'utf8'),ctx);
 return {ctx,api,track,canvas,finishRead,get result(){return {reads,draws,bitmapsClosed,stops,tracksStopped};}};
}

test('the native canvas keeps the whole 5:4 frame and releases capture and bitmaps when a track stops',async()=>{
 const h=rendererHarness(),stream=await h.ctx.proctorCaptureWindows7Screen(h.api);assert.equal(h.canvas.width,1280);assert.equal(h.canvas.height,1024);assert.equal(h.result.draws,1);assert.equal(h.result.bitmapsClosed,1);
 stream.getVideoTracks()[0].stop();h.finishRead({sequence:2,jpeg:jpeg(2)});await new Promise(resolve=>setImmediate(resolve));assert.equal(h.result.draws,1);assert.equal(h.result.stops,1);assert.equal(h.result.tracksStopped,1);
});

test('failed first-frame and decode probes release the native producer rather than leaving a capture behind',async()=>{
 for(const decode of [false,true]){
  const h=rendererHarness();if(decode)h.ctx.createImageBitmap=async()=>{throw Error('decode failed');};else h.api.readWindows7ScreenFrame=async()=>{throw Error('no frame');};
  await assert.rejects(h.ctx.proctorCaptureWindows7Screen(h.api),decode?/decode failed/:/no frame/);assert.equal(h.result.stops,1);
 }
});
