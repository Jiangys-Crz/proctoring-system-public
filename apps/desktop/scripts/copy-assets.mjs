import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/renderer', { recursive: true });
await mkdir('dist/renderer/vendor', { recursive: true });
await cp('src/renderer/index.html', 'dist/renderer/index.html');
await cp('src/renderer/styles.css', 'dist/renderer/styles.css');
await cp('src/renderer/config.js', 'dist/renderer/config.js');
if (process.env.PROCTOR_BUILD_CHANNEL) {
  const channel = process.env.PROCTOR_BUILD_CHANNEL;
  const origins = { public: 'https://proctoring.example.org', intranet: 'https://proctoring.example.test', unified: 'https://proctoring.example.test' };
  if (!(channel in origins)) throw new Error('PROCTOR_BUILD_CHANNEL 必须是 unified、public 或 intranet');
  const origin = origins[channel];
  // A blank student override follows the selected backend: the public backend
  // uses proctorstu.example.org, while intranet uses proctorstu.example.test.
  let config = await readFile('dist/renderer/config.js', 'utf8');
  const values = { PROCTOR_DEFAULT_SERVER_URL: origin, PROCTOR_UPDATE_SERVER_URL: origin, PROCTOR_RELEASE_CHANNEL: channel,
    PROCTOR_PUBLIC_API_URL: channel === 'unified' ? '' : origin, PROCTOR_CLIENT_WEB_URL: process.env.PROCTOR_CLIENT_WEB_URL || '', PROCTOR_MOBILE_WEB_URL: process.env.PROCTOR_CLIENT_WEB_URL || '' };
  for (const [key, value] of Object.entries(values)) {
    if (key.endsWith('WEB_URL') && value) { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('正式考试网页地址必须是 HTTPS 主地址'); }
    config = config.replace(new RegExp(`window\\.${key}\\s*=.*?;`), `window.${key} = ${JSON.stringify(value)};`);
  }
  await writeFile('dist/renderer/config.js', config);
}
await cp('src/renderer/renderer.js', 'dist/renderer/renderer.js');
await cp('src/renderer/window-policy.js', 'dist/renderer/window-policy.js');
await cp('src/renderer/permission-actions.js', 'dist/renderer/permission-actions.js');
await cp('src/renderer/permission-state.js', 'dist/renderer/permission-state.js');
await cp('src/renderer/connection-monitor.js', 'dist/renderer/connection-monitor.js');
await cp('src/renderer/user-messages.js', 'dist/renderer/user-messages.js');
await cp('src/renderer/capture-policy.js', 'dist/renderer/capture-policy.js');
await cp('src/renderer/windows7-screen-capture.js', 'dist/renderer/windows7-screen-capture.js');
await cp('src/renderer/exam-notices.js', 'dist/renderer/exam-notices.js');
await cp('../../packages/shared/src/realtime-voice.js', 'dist/renderer/realtime-voice.js');
await cp('src/renderer/desktop-audio.js', 'dist/renderer/desktop-audio.js');
await cp('src/renderer/desktop-voice.js', 'dist/renderer/desktop-voice.js');
await cp('src/renderer/recording-controller.js', 'dist/renderer/recording-controller.js');
await cp('../../packages/shared/src/recording-buffer.js', 'dist/renderer/recording-buffer.js');
await cp('../../packages/shared/src/webrtc-codecs.js', 'dist/renderer/webrtc-codecs.js');
await cp('src/renderer/screen-control.html', 'dist/renderer/screen-control.html');
await cp('src/renderer/screen-control.css', 'dist/renderer/screen-control.css');
await cp('src/renderer/screen-control-display.js', 'dist/renderer/screen-control-display.js');
await cp('src/renderer/assets', 'dist/renderer/assets', { recursive: true });
await cp('node_modules/hls.js/dist/hls.min.js', 'dist/renderer/vendor/hls.min.js');
