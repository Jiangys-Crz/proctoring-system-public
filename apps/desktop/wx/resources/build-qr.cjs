const { createRequire } = require('node:module');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const entry = require.resolve('qrcode/lib/browser', { paths: [path.join(__dirname, '../..')] });
const modules = new Map();
function visit(filename) {
  if (modules.has(filename)) return modules.get(filename).index;
  const module = { index: modules.size, source: '' };
  modules.set(filename, module);
  const resolve = createRequire(filename).resolve;
  // The existing browser QR dependency graph uses static CommonJS imports.
  // Resolve them at build time so Node is unnecessary inside WebView2.
  module.source = readFileSync(filename, 'utf8').replace(/\brequire\((['"])([^'"]+)\1\)/g, (_all, _quote, name) => {
    return `load(${visit(resolve(name))})`;
  });
  return module.index;
}

const root = visit(entry);
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node build-qr.cjs <qr.js>');
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, `(() => {
  'use strict';
  if (window !== window.top || location.origin !== (window.__proctorShellOrigin || 'https://proctor-client.invalid') ||
      location.pathname !== '/index.html') return;
  const sources = [${[...modules.values()].map(module => `(module, exports, load) => {\n${module.source}\n}`).join(',\n')}];
  const cache = [];
  function load(id) {
    if (cache[id]) return cache[id].exports;
    const module = cache[id] = { exports: {} };
    sources[id](module, module.exports, load);
    return module.exports;
  }
  const QRCode = load(${root});
  Object.defineProperty(window, '__proctorQrDataUrl', {
    value: (text) => QRCode.toDataURL(text, { margin: 4, width: 360, errorCorrectionLevel: 'M' })
  });
})();\n`);
