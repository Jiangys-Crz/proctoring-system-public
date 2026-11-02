// Run using the installed Electron: electron scripts/test-recording-runtime.cjs
// Generates only a synthetic canvas; never captures the user's screen/camera.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadURL('about:blank');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../src/renderer/recording-controller.js'), 'utf8'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d');
      let frame = 0;
      const paint = setInterval(() => {
        context.fillStyle = frame++ % 2 ? '#234' : '#456';
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = 'white'; context.fillText(String(frame), 20, 30);
      }, 100);
      const stream = canvas.captureStream(10);
      const clips = [];
      const errors = [];
      const controller = createProctorRecordingController({
        channel: 'DESKTOP_SCREEN', sessionId: 'synthetic-test', stream,
        isActive: () => true, getContext: () => ({}), recorderOptions: { mimeType: 'video/webm;codecs=vp8' },
        onSave: async (blob, filename, fields) => {
          const head = Array.from(new Uint8Array(await blob.slice(0, 4).arrayBuffer()));
          clips.push({ filename, size: blob.size, head, ...fields });
        }, onError: (error) => errors.push(String(error))
      });
      await new Promise(resolve => setTimeout(resolve, 25000));
      const eventAt = Date.now();
      controller.flush();
      await new Promise(resolve => setTimeout(resolve, 21000));
      await controller.stop();
      stream.getTracks().forEach(track => track.stop());
      clearInterval(paint);
      return { clips, errors, eventAt };
    })()`);
    assert.deepEqual(result.errors, []);
    assert.ok(result.clips.length >= 5);
    assert.equal(new Set(result.clips.map(clip => clip.uploadId)).size, result.clips.length);
    for (const clip of result.clips) {
      assert.ok(clip.size > 0);
      assert.deepEqual(clip.head, [0x1a, 0x45, 0xdf, 0xa3]);
      assert.ok(Date.parse(clip.endedAt) > Date.parse(clip.startedAt));
    }
    assert.ok(Date.parse(result.clips[0].startedAt) <= result.eventAt - 20000);
    assert.ok(Date.parse(result.clips.at(-1).endedAt) >= result.eventAt + 20000);
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, segments: result.clips.length, totalBytes: result.clips.reduce((sum, clip) => sum + clip.size, 0), evidenceWindowSeconds: 40 }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
