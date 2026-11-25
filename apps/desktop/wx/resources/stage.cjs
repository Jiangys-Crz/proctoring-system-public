const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const stage = path.resolve(process.argv[2]);
const mac = process.argv[3] === 'mac';
const desktop = path.resolve(__dirname, '../..');
const renderer = path.join(stage, 'renderer');
for (const helper of mac ? [] : ['token', 'launcher', 'screen-control', 'inventory']) {
  execFileSync(process.execPath, [`scripts/prepare-windows-${helper}.mjs`], { cwd: desktop, stdio: 'inherit' });
}
execFileSync(process.execPath, ['scripts/copy-assets.mjs', renderer], { cwd: desktop, stdio: 'inherit' });

fs.copyFileSync(path.join(desktop, 'src/renderer/process-policy.json'), path.join(renderer, 'process-policy.json'));
const index = path.join(renderer, 'index.html');
const html = fs.readFileSync(index, 'utf8');
const guest = /<webview id="ojView" class="browser"[^>]*><\/webview>/;
if (!guest.test(html)) throw new Error('找不到原有考试页面容器');
fs.writeFileSync(index, html.replace(
  guest,
  '<div id="ojView" class="browser" tabindex="0"></div>'
));

if (mac) {
  for (const [page, scripts] of [
    ['index.html', ['qr.js', 'bridge.js', 'mac-media.js', 'guest.js']],
    ['screen-control.html', ['overlay.js']]
  ]) {
    const filename = path.join(renderer, page);
    let html = fs.readFileSync(filename, 'utf8');
    if (page === 'screen-control.html') html = html.replace('img-src data:;', 'img-src data: proctor-display:;');
    fs.writeFileSync(filename, html.replace('<script ', scripts.map(script => `<script src="./${script}"></script>\n    `).join('') + '<script '));
  }
  for (const script of ['bridge.js', 'mac-media.js', 'guest.js', 'overlay.js', 'mac-migration.html', 'mac-migration.js']) {
    fs.copyFileSync(path.join(__dirname, script), path.join(renderer, script));
  }
} else {
  fs.rmSync(path.join(stage, 'intranet'), { recursive: true, force: true });
  // Only the native Windows shell uses the WebView2 startup handshake. This
  // sentinel is reached after every renderer statement and event binding.
  fs.appendFileSync(path.join(renderer, 'renderer.js'), '\nwindow.__proctorRendererReady = true;\n');
  const overlay = path.join(renderer, 'screen-control.html');
  const html = fs.readFileSync(overlay, 'utf8');
  fs.writeFileSync(overlay, html.replace('img-src data:;', 'img-src data: https://proctor-display.invalid;'));
  for (const script of ['shell-health.js', 'bridge.js', 'media.js', 'guest.js', 'overlay.js', 'migration-source.js', 'migration-client.js', 'migration.html']) {
    fs.copyFileSync(path.join(__dirname, script), path.join(stage, script));
  }
}
execFileSync(process.execPath, [path.join(__dirname, 'build-qr.cjs'), path.join(mac ? renderer : stage, 'qr.js')], { stdio: 'inherit' });
