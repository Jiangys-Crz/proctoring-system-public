// Synthetic screen/room footage only; never captures a real screen or camera.
// RECORDING_QA_DIR=/absolute/temp/path electron scripts/test-recording-quality.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    const output = process.env.RECORDING_QA_DIR;
    assert.ok(output && path.isAbsolute(output), 'Use a disposable absolute output directory');
    await fs.mkdir(output, { recursive: true });
    await win.loadURL('about:blank');
    const controller = await fs.readFile(path.join(__dirname, '../src/renderer/recording-controller.js'), 'utf8');
    await win.webContents.executeJavaScript(controller);
    await win.webContents.executeJavaScript(await fs.readFile(path.join(__dirname, '../../../packages/shared/src/recording-buffer.js'), 'utf8'));
    const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    const profile = renderer.match(/const captureProfile = (\{[\s\S]*?\n\});/)[1];
    const result = await win.webContents.executeJavaScript(`(async () => {
      const profile = ${profile};
      const preferredMime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(mime => MediaRecorder.isTypeSupported(mime));
      const variants = [
        { name: 'screen-before', width: 1920, height: 1080, fps: 30, bitrate: 12000000, mime: 'video/webm;codecs=vp8', screen: true },
        { name: 'screen-after', width: profile.width, height: profile.height, fps: profile.recordingFrameRate, bitrate: profile.screenBitrate, mime: preferredMime, screen: true, scaled: true },
        { name: 'camera-before', width: 1920, height: 1080, fps: 30, bitrate: 8000000, mime: 'video/webm;codecs=vp8' },
        { name: 'camera-after', width: 1280, height: 720, fps: profile.recordingFrameRate, bitrate: profile.cameraBitrate, mime: preferredMime, scaled: true }
      ];
      const results = [];
      for (const variant of variants) {
        const canvas = document.createElement('canvas');
        canvas.width = 1920; canvas.height = 1080;
        const ctx = canvas.getContext('2d');
        let step = 0;
        const paint = () => {
          ctx.fillStyle = variant.screen ? '#f6f7fa' : '#d8d1c5';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.save(); ctx.scale(canvas.width / 1920, canvas.height / 1080);
          if (variant.screen) {
            ctx.fillStyle = '#151c2b'; ctx.fillRect(0, 0, 1920, 50);
            ctx.font = '18px monospace'; ctx.fillStyle = '#ffffff'; ctx.fillText('Contest editor | Recording quality check', 24, 32);
            ctx.font = '14px monospace'; ctx.fillStyle = '#142c41';
            for (let line = 0; line < 55; line++) ctx.fillText(String(line + 1).padStart(2, '0') + '   for (int i = 0; i < n; ++i) { total += values[i]; } // 0123456789', 35, 82 + line * 17);
            ctx.fillStyle = '#1565c0'; ctx.fillRect(1050 + (step % 250), 180, 3, 300);
            ctx.fillStyle = '#172a39'; ctx.font = '24px monospace'; ctx.fillText('Frame ' + step, 1280, 650);
          } else {
            ctx.fillStyle = '#687b87'; ctx.fillRect(150, 100, 550, 600);
            ctx.fillStyle = '#d4e5f2'; ctx.fillRect(170, 120, 230, 560); ctx.fillRect(430, 120, 230, 560);
            ctx.fillStyle = '#765a42'; ctx.fillRect(500, 750, 1150, 50); ctx.fillRect(620, 800, 35, 250); ctx.fillRect(1510, 800, 35, 250);
            ctx.fillStyle = '#315b79'; ctx.fillRect(930, 510, 230, 250);
            ctx.fillStyle = '#dba77e'; ctx.beginPath(); ctx.ellipse(1045, 395, 75, 105, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#202830'; ctx.beginPath(); ctx.arc(1020, 382, 8, 0, Math.PI * 2); ctx.arc(1070, 382, 8, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#dba77e'; ctx.fillRect(1140, 660 + Math.sin(step / 8) * 65, 180, 30);
            ctx.fillStyle = '#202830'; ctx.font = '30px monospace'; ctx.fillText('Candidate / desk / hands ' + step, 750, 970);
          }
          ctx.restore(); step++;
        };
        paint();
        const timer = setInterval(paint, 1000 / 30);
        const stream = canvas.captureStream(30);
        const liveBefore = stream.getVideoTracks()[0].getSettings();
        const clips = [], errors = [];
        const scaled = variant.scaled ? createProctorRecordingStream(stream, { width: variant.width, height: variant.height, frameRate: variant.fps, onError: error => errors.push(String(error)) }) : null;
        const recording = createProctorRecordingController({
          channel: variant.screen ? 'DESKTOP_SCREEN' : 'DESKTOP_CAMERA', sessionId: 'synthetic-quality', stream: scaled?.stream || stream, sourceStream: stream,
          segmentMs: 3000, isActive: () => true, getContext: () => ({}),
          recorderOptions: { mimeType: variant.mime, videoBitsPerSecond: variant.bitrate, audioBitsPerSecond: profile.audioBitrate },
          onSave: async (blob, filename, fields) => {
            const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
            clips.push({ filename, bytes: blob.size, fields, data });
          }, onError: error => errors.push(String(error)), onStopped: () => scaled?.stop()
        });
        await new Promise(resolve => setTimeout(resolve, 10000));
        await recording.stop();
        const liveAfter = stream.getVideoTracks()[0].getSettings();
        const liveStillActive = stream.active;
        clearInterval(timer); stream.getTracks().forEach(track => track.stop());
        results.push({ ...variant, clips, errors, liveBefore, liveAfter, liveStillActive });
      }
      return results;
    })()`);
    const summary = [];
    for (const variant of result) {
      assert.deepEqual(variant.errors, []);
      assert.equal(variant.clips.length, 4);
      assert.equal(new Set(variant.clips.map(clip => clip.fields.uploadId)).size, 4);
      assert.equal(variant.liveStillActive, true);
      assert.deepEqual(variant.liveAfter, variant.liveBefore, 'compressed recording must never constrain its live source');
      assert.equal(variant.liveAfter.width, 1920);
      assert.equal(variant.liveAfter.height, 1080);
      assert.equal(variant.liveAfter.frameRate, 30);
      const directory = path.join(output, variant.name);
      await fs.mkdir(directory, { recursive: true });
      for (let index = 0; index < variant.clips.length; index++) {
        const clip = variant.clips[index];
        await fs.writeFile(path.join(directory, `${index}.webm`), Buffer.from(clip.data, 'base64'));
      }
      summary.push({ name: variant.name, width: variant.width, height: variant.height, fps: variant.fps, mime: variant.mime,
        clips: variant.clips.length, bytes: variant.clips.reduce((sum, clip) => sum + clip.bytes, 0), liveSource: { width: variant.liveAfter.width, height: variant.liveAfter.height, fps: variant.liveAfter.frameRate } });
    }
    await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ ok: true, output, recordings: summary }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
