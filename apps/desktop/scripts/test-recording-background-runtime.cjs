// Isolated Electron test: generated motion only, no devices, accounts or network.
// From apps/desktop: node node_modules/electron/cli.js scripts/test-recording-background-runtime.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const bundledFfmpeg = require('ffmpeg-static');
const ffmpeg = process.env.FFMPEG_PATH || (fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');
const ffprobe = process.env.FFPROBE_PATH || require('../../web/node_modules/ffprobe-static').path;

const outputArg = process.argv.indexOf('--output');
const throttledControl = process.argv.includes('--throttled-control');
const output = path.resolve(outputArg >= 0 ? process.argv[outputArg + 1] : path.join(__dirname, '../.local/recording-background-test', String(Date.now())));
fs.mkdirSync(output, { recursive: true });
const profile = path.resolve(__dirname, '../.local/recording-background-test', `profile-${process.pid}`);
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
// Match the Windows desktop's existing software-rendering startup policy.
if (process.platform === 'win32') app.disableHardwareAcceleration();
const timeout = setTimeout(() => { console.error('BACKGROUND_RECORDING_TEST_TIMEOUT'); app.exit(1); }, 45_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, paintWhenInitiallyHidden: false, webPreferences: {
    backgroundThrottling: throttledControl, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  } });
  const report = { ok: false, mode: throttledControl ? 'THROTTLED_CONTROL_REPRODUCTION' : 'FIXED_BACKGROUND_CAPTURE', media: 'SIMULATED_LOCAL_CANVAS', electron: process.versions.electron, chromium: process.versions.chrome, hidden: false, focused: false, channels: [] };
  try {
    await window.loadURL('about:blank');
    assert.equal(window.isVisible(), false);
    assert.equal(window.isFocused(), false);
    // Electron 22 does not echo backgroundThrottling in getLastWebPreferences;
    // verify the actual hidden-window decoded cadence below instead.
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../../../packages/shared/src/recording-buffer.js'), 'utf8'));
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../src/renderer/recording-controller.js'), 'utf8'));
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../src/renderer/capture-policy.js'), 'utf8'));
    const captured = await window.webContents.executeJavaScript(`(async () => {
      const clips = [], errors = [], inputs = [], controllers = [];
      const mimeType = proctorRecordingMimeTypes('win32').find(type => MediaRecorder.isTypeSupported(type));
      for (const channel of ['DESKTOP_SCREEN', 'DESKTOP_CAMERA']) {
        const canvas = document.createElement('canvas');
        canvas.width = channel === 'DESKTOP_SCREEN' ? 1920 : 1280;
        canvas.height = channel === 'DESKTOP_SCREEN' ? 1080 : 720;
        const context = canvas.getContext('2d');
        let frame = 0;
        const paint = () => {
          frame++;
          context.fillStyle = 'hsl(' + ((frame * 7) % 360) + ' 65% 35%)';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#ffffff'; context.font = '48px monospace';
          context.fillText('SIMULATED ' + channel, 40, 90);
          context.fillText(String(Date.now()) + ' / frame ' + frame, 40, 160);
          context.fillRect((frame * 25) % (canvas.width - 100), 250, 100, 100);
        };
        paint();
        const timer = setInterval(paint, 1000 / 30);
        const source = canvas.captureStream(30);
        inputs.push({ source, timer });
        const derived = createProctorRecordingStream(source, {
          width: canvas.width, height: canvas.height, frameRate: 20,
          onError: error => errors.push(String(error)),
        });
        controllers.push(createProctorRecordingController({
          stream: derived.stream, sourceStream: source, channel, sessionId: 'isolated-background-test',
          segmentMs: 3000, recorderOptions: { mimeType, videoBitsPerSecond: channel === 'DESKTOP_SCREEN' ? 3000000 : 600000 },
          isActive: () => true, getContext: () => ({ clockOffsetMs: 0, clockUncertaintyMs: 0 }),
          onSave: async (blob, filename, fields) => clips.push({ filename, fields, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) }),
          onError: error => errors.push(String(error)), onStopped: derived.stop,
        }));
      }
      await new Promise(resolve => setTimeout(resolve, 6500));
      await Promise.all(controllers.map(controller => controller.stop()));
      inputs.forEach(({ source, timer }) => { clearInterval(timer); source.getTracks().forEach(track => track.stop()); });
      if (errors.length) throw new Error(errors.join('; '));
      return { clips, visibilityState: document.visibilityState };
    })()`);
    report.hidden = !window.isVisible();
    report.focused = window.isFocused();
    report.documentVisibilityState = captured.visibilityState;
    assert.equal(report.hidden, true);
    assert.equal(report.focused, false);
    for (const clip of captured.clips) {
      const filename = path.join(output, clip.filename);
      fs.writeFileSync(filename, Buffer.from(clip.bytes));
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', filename], { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
      const times = probe.frames.map(frame => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite);
      const deltas = times.slice(1).map((time, index) => time - times[index]);
      const seconds = times.at(-1) - times[0];
      const hashes = execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-f', 'framemd5', '-'], { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }).toString().split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
      const item = { channel: clip.fields.channel, filename: path.basename(filename), frames: times.length, seconds, effectiveFps: (times.length - 1) / seconds,
        maximumFrameGapMs: Math.max(...deltas) * 1000, distinctDecodedFrames: new Set(hashes).size,
        startedAt: clip.fields.startedAt, endedAt: clip.fields.endedAt, wallSeconds: (Date.parse(clip.fields.endedAt) - Date.parse(clip.fields.startedAt)) / 1000 };
      report.channels.push(item);
      // Short shutdown tails are retained for inspection; require both full
      // segments to sustain actual decoded, changing frames while hidden.
      if (!throttledControl && item.wallSeconds >= 2.5) {
        assert.ok(item.effectiveFps >= 15, `${item.channel} hidden capture below 15fps`);
        assert.ok(item.maximumFrameGapMs <= 250, `${item.channel} hidden capture has a frame gap`);
        assert.ok(item.distinctDecodedFrames >= times.length * 0.8, `${item.channel} decoded footage is mostly repeated frames`);
        assert.ok(Math.abs(item.wallSeconds - seconds) < 0.25, `${item.channel} capture timestamps include encoder finalization delay`);
      }
    }
    for (const channel of ['DESKTOP_SCREEN', 'DESKTOP_CAMERA']) {
      assert.ok(report.channels.filter(clip => clip.channel === channel && clip.wallSeconds >= 2.5).length >= 2, `${channel} did not complete two full segments`);
      if (throttledControl) assert.ok(report.channels.some(clip => clip.channel === channel && clip.wallSeconds >= 2.5 && clip.effectiveFps < 5 && clip.maximumFrameGapMs > 500), `${channel} did not reproduce hidden-page throttling`);
    }
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(report));
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    clearTimeout(timeout);
    window.destroy();
    app.exit(report.ok ? 0 : 1);
  }
}).catch(error => { console.error(error.message); app.exit(1); });
