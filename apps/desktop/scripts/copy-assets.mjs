import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const destination = process.argv[2] || 'dist/renderer';

await mkdir(destination, { recursive: true });
await mkdir(path.join(destination, 'vendor'), { recursive: true });
await cp('src/renderer/index.html', path.join(destination, 'index.html'));
await cp('src/renderer/styles.css', path.join(destination, 'styles.css'));
await cp('src/renderer/config.js', path.join(destination, 'config.js'));
if (process.env.PROCTOR_BUILD_CHANNEL) {
  const channel = process.env.PROCTOR_BUILD_CHANNEL;
  const origins = { public: 'https://proctoring.example.org', intranet: 'https://proctoring.example.test', unified: 'https://proctoring.example.test' };
  if (!(channel in origins)) throw new Error('PROCTOR_BUILD_CHANNEL 必须是 unified、public 或 intranet');
  const origin = origins[channel];
  // A blank student override follows the selected backend: the public backend
  // uses proctorstu.example.org, while intranet uses proctorstu.example.test.
  let config = await readFile(path.join(destination, 'config.js'), 'utf8');
  const values = { PROCTOR_DEFAULT_SERVER_URL: origin, PROCTOR_UPDATE_SERVER_URL: origin, PROCTOR_RELEASE_CHANNEL: channel,
    PROCTOR_PUBLIC_API_URL: channel === 'unified' ? '' : origin, PROCTOR_CLIENT_WEB_URL: process.env.PROCTOR_CLIENT_WEB_URL || '', PROCTOR_MOBILE_WEB_URL: process.env.PROCTOR_CLIENT_WEB_URL || '' };
  for (const [key, value] of Object.entries(values)) {
    if (key.endsWith('WEB_URL') && value) { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('正式考试网页地址必须是 HTTPS 主地址'); }
    config = config.replace(new RegExp(`window\\.${key}\\s*=.*?;`), `window.${key} = ${JSON.stringify(value)};`);
  }
  await writeFile(path.join(destination, 'config.js'), config);
}
await cp('src/renderer/renderer.js', path.join(destination, 'renderer.js'));
await cp('src/renderer/window-policy.js', path.join(destination, 'window-policy.js'));
await cp('src/renderer/permission-actions.js', path.join(destination, 'permission-actions.js'));
await cp('src/renderer/permission-state.js', path.join(destination, 'permission-state.js'));
await cp('src/renderer/connection-monitor.js', path.join(destination, 'connection-monitor.js'));
await cp('src/renderer/user-messages.js', path.join(destination, 'user-messages.js'));
await cp('src/renderer/capture-policy.js', path.join(destination, 'capture-policy.js'));
await cp('src/renderer/windows7-screen-capture.js', path.join(destination, 'windows7-screen-capture.js'));
await cp('src/renderer/exam-notices.js', path.join(destination, 'exam-notices.js'));
await cp('../../packages/shared/src/realtime-voice.js', path.join(destination, 'realtime-voice.js'));
await cp('src/renderer/desktop-audio.js', path.join(destination, 'desktop-audio.js'));
await cp('src/renderer/desktop-voice.js', path.join(destination, 'desktop-voice.js'));
await cp('src/renderer/recording-controller.js', path.join(destination, 'recording-controller.js'));
await cp('../../packages/shared/src/recording-buffer.js', path.join(destination, 'recording-buffer.js'));
await cp('../../packages/shared/src/webrtc-codecs.js', path.join(destination, 'webrtc-codecs.js'));
await cp('src/renderer/screen-control.html', path.join(destination, 'screen-control.html'));
await cp('src/renderer/screen-control.css', path.join(destination, 'screen-control.css'));
await cp('src/renderer/screen-control-display.js', path.join(destination, 'screen-control-display.js'));
await cp('src/renderer/assets', path.join(destination, 'assets'), { recursive: true });
await cp('node_modules/hls.js/dist/hls.min.js', path.join(destination, 'vendor/hls.min.js'));
