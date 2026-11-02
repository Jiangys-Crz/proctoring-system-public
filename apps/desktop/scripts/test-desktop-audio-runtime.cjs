// Electron 22 + real MediaMTX; generated canvas/tone tracks only, no hardware.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const fixtureFile = process.env.VOICE_NATIVE_FIXTURE || '';
assert.match(fixtureFile, /^\/tmp\/proctor-voice-qa\.[A-Za-z0-9]+\/native-fixture\.json$/);
const fixture = JSON.parse(fs.readFileSync(fixtureFile)), directory = path.dirname(fixtureFile);
assert.equal(new URL(fixture.base).hostname, '127.0.0.1');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await window.loadURL('about:blank');
    const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    const snippets = renderer.slice(renderer.indexOf('const captureProfile ='), renderer.indexOf('function apiUrl('))
      + renderer.slice(renderer.indexOf('function waitForWhipIce('), renderer.indexOf('function clearWhipReconnect('));
    await window.webContents.executeJavaScript(`const QA_BASE=${JSON.stringify(fixture.base)};function apiUrl(path){return QA_BASE+path;}` + snippets);
    for (const file of ['../../../packages/shared/src/webrtc-codecs.js', '../../../packages/shared/src/recording-buffer.js', '../../../packages/shared/src/realtime-voice.js', '../src/renderer/desktop-audio.js']) {
      await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    }
    const ready = await window.webContents.executeJavaScript(`(async () => {
      const fixtures=${JSON.stringify(fixture.sessions)}, tones=[], publishers=[], microphones=[], screens=[], paints=[];
      let nextFrequency=330;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async constraints => {
        if (constraints.video !== false) throw new Error('Runtime QA must never request a camera');
        const context=new AudioContext(), oscillator=context.createOscillator(), gain=context.createGain(), output=context.createMediaStreamDestination();
        oscillator.frequency.value=nextFrequency; gain.gain.value=.08; oscillator.connect(gain);gain.connect(output);oscillator.start();await context.resume();
        tones.push({context,oscillator});return output.stream;
      } } });
      for(let index=0;index<fixtures.length;index++) {
        nextFrequency=index?660:330;
        const microphone=createProctorMicrophoneCapture();await microphone.acquire();microphones.push(microphone);
        const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const context=canvas.getContext('2d');let frame=0;
        const paint=()=>{context.fillStyle=index?'#eef7f1':'#edf3fc';context.fillRect(0,0,1280,720);context.fillStyle='#18304b';context.font='32px sans-serif';context.fillText('Synthetic screen '+(index+1)+' / '+frame++,40,80);};paint();paints.push(setInterval(paint,200));
        const stream=canvas.captureStream(5);microphone.attach(stream);screens.push(stream);
        const item=fixtures[index],attempt={sessionId:item.id,sessionToken:item.token,abort:new AbortController()};
        publishers.push(await publishDesktopWhip('DESKTOP_SCREEN',stream,attempt));
      }
      const audio=document.createElement('audio');audio.volume=0;document.body.appendChild(audio);
      const item=fixtures[0];let phone;window.qaPhoneState={phase:'idle'};
      phone=createProctorVoiceCall({side:'DESKTOP',sessionId:item.id,audio,getMicrophone:()=>microphones[0].clone(),
        request:async body=>{const response=await fetch(QA_BASE+'/api/client/voice/calls',{method:'POST',headers:{'content-type':'application/json','x-proctor-session-token':item.token},body:JSON.stringify(body)});const result=await response.json();if(!result.ok)throw new Error(result.message);return result.data;},
        onState:state=>{window.qaPhoneState=state;if(state.phase==='incoming')queueMicrotask(()=>phone.accept());}});phone.listen();
      const recording=createProctorRecordingStream(screens[0],{width:1280,height:720,frameRate:5,onError:error=>{throw error;}});
      const chunks=[],recorder=new MediaRecorder(recording.stream,{mimeType:'video/webm;codecs=vp8,opus'});
      const recorded=new Promise(resolve=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=resolve;});recorder.start();await new Promise(resolve=>setTimeout(resolve,2200));recorder.stop();await recorded;recording.stop();
      const blob=new Blob(chunks,{type:'video/webm'}),bytes=new Uint8Array(await blob.arrayBuffer());
      let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.slice(offset,offset+8192));
      const decoder=new AudioContext(),decoded=await decoder.decodeAudioData(await blob.arrayBuffer()),samples=decoded.getChannelData(0);
      const rms=Math.sqrt(samples.reduce((sum,sample)=>sum+sample*sample,0)/samples.length);await decoder.close();
      window.qaAudioNative={phone,microphones,publishers,screens,async stop(){phone.dispose();for(const pub of publishers)await pub.stop();for(const mic of microphones)mic.stop();for(const screen of screens)screen.getTracks().forEach(track=>track.stop());paints.forEach(clearInterval);for(const tone of tones){tone.oscillator.stop();await tone.context.close();}}};
      return {peers:publishers.map(p=>p.peer.connectionState),screenAudioTracks:screens.map(s=>s.getAudioTracks().length),recordedBytes:bytes.length,recordedSeconds:decoded.duration,recordedAudioRms:rms,base64:btoa(binary)};
    })()`, true);
    assert.ok(ready.peers.every(state => state === 'connected'));
    assert.deepEqual(ready.screenAudioTracks, [1, 1]); assert.ok(ready.recordedAudioRms > .01); assert.ok(ready.recordedSeconds > 1.5);
    fs.writeFileSync(path.join(directory, 'synthetic-screen-audio.webm'), Buffer.from(ready.base64, 'base64')); delete ready.base64;
    const proof = { ...ready, runId: fixture.runId, electron: process.versions.electron, chromium: process.versions.chrome };
    fs.writeFileSync(path.join(directory, 'native-ready.json'), JSON.stringify(proof));
    console.log(JSON.stringify(proof));
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        if (fs.existsSync(path.join(directory, 'native-stop')) && fs.readFileSync(path.join(directory, 'native-stop'), 'utf8').trim() === fixture.runId) {
          clearInterval(timer); await window.webContents.executeJavaScript('qaAudioNative.stop()'); app.exit(0); return;
        }
        const state = await window.webContents.executeJavaScript('({phase:qaPhoneState?.phase,microphoneAvailable:qaAudioNative.microphones[0].available})');
        fs.writeFileSync(path.join(directory, 'native-state.json'), JSON.stringify(state));
      } catch (error) { console.error(error); clearInterval(timer); app.exit(1); }
      finally { busy = false; }
    }, 300);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
