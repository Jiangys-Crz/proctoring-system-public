// Run with Electron 22. Uses generated canvas tracks and local loopback only;
// never requests screen/camera/microphone access or sends media to a server.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await window.loadURL('about:blank');
    const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    await window.webContents.executeJavaScript(renderer.slice(renderer.indexOf('const captureProfile ='), renderer.indexOf('function apiUrl('))
      + renderer.slice(renderer.indexOf('function whipEncoding('), renderer.indexOf('function whipEndpoint(')));
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../../../packages/shared/src/webrtc-codecs.js'), 'utf8'));
    const results = await window.webContents.executeJavaScript(`(async () => {
      const results = [];
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const gather = async peer => {
        for (let index = 0; index < 50 && peer.iceGatheringState !== 'complete'; index++) await delay(100);
      };
      for (const channel of ['DESKTOP_SCREEN', 'DESKTOP_CAMERA']) {
        const isScreen = channel === 'DESKTOP_SCREEN';
        const canvas = document.createElement('canvas');
        canvas.width = isScreen ? captureProfile.width : captureProfile.cameraWidth;
        canvas.height = isScreen ? captureProfile.height : captureProfile.cameraHeight;
        const fps = isScreen ? captureProfile.frameRate : captureProfile.cameraFrameRate;
        const context = canvas.getContext('2d');
        let frame = 0;
        const paint = () => {
          context.fillStyle = '#f5f5f5'; context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#17202c'; context.font = '14px monospace';
          for (let row = 0; row < 45; row++) context.fillText('for (int i = 0; i < n; ++i) { result += values[i]; }', 20, 25 + row * 18);
          context.fillStyle = '#0088dd'; context.fillRect(1100 + (frame++ % 100), 10, 40, 500);
        };
        paint(); const timer = setInterval(paint, 1000 / fps);
        const stream = canvas.captureStream(fps), track = stream.getVideoTracks()[0];
        track.contentHint = isScreen ? 'text' : 'motion';
        const sender = new RTCPeerConnection({ iceServers: [] });
        const receiver = new RTCPeerConnection({ iceServers: [] });
        try {
          const transceiver = sender.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [whipEncoding(channel)] });
          window.proctorPreferH264(transceiver);
          await configureWhipSender(transceiver.sender, channel);
          const beforeOffer = transceiver.sender.getParameters();
          await sender.setLocalDescription(await sender.createOffer()); await gather(sender);
          await receiver.setRemoteDescription(sender.localDescription);
          await receiver.setLocalDescription(await receiver.createAnswer()); await gather(receiver);
          await sender.setRemoteDescription(receiver.localDescription);
          for (let attempt = 0; attempt < 80 && sender.connectionState !== 'connected'; attempt++) await delay(100);
          await delay(2500);
          const stats = [...(await transceiver.sender.getStats()).values()];
          const outbound = stats.find(item => item.type === 'outbound-rtp' && item.kind === 'video');
          const codec = stats.find(item => item.id === outbound?.codecId);
          results.push({ channel, settings: track.getSettings(), beforeOffer, afterAnswer: transceiver.sender.getParameters(),
            connectionState: sender.connectionState, codec: codec?.mimeType,
            encoded: outbound?.framesEncoded, width: outbound?.frameWidth, height: outbound?.frameHeight });
        } finally { clearInterval(timer); sender.close(); receiver.close(); track.stop(); }
      }
      return results;
    })()`);
    for (const result of results) {
      const screen = result.channel === 'DESKTOP_SCREEN';
      const preference = screen ? 'maintain-resolution' : 'maintain-framerate';
      assert.equal(result.connectionState, 'connected');
      assert.equal(result.beforeOffer.degradationPreference, preference);
      assert.equal(result.afterAnswer.degradationPreference, preference);
      assert.equal(result.afterAnswer.encodings[0].maxBitrate, screen ? 3_000_000 : 450_000);
      assert.equal(result.afterAnswer.encodings[0].maxFramerate, screen ? 30 : 20);
      assert.ok(result.encoded > 0);
      assert.equal(result.codec?.toLowerCase(), 'video/h264');
      if (screen) { assert.equal(result.width, 1920); assert.equal(result.height, 1080); }
    }
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, chromium: process.versions.chrome,
      results: results.map(result => ({ channel: result.channel, codec: result.codec, encoded: result.encoded,
        width: result.width, height: result.height, preference: result.afterAnswer.degradationPreference,
        maxBitrate: result.afterAnswer.encodings[0].maxBitrate, maxFramerate: result.afterAnswer.encodings[0].maxFramerate })) }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
