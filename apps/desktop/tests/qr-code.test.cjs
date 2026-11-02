const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const QRCode = require('qrcode');
const { PNG } = createRequire(require.resolve('qrcode'))('pngjs');
const jsQR = require('../../client-web/node_modules/jsqr');

test('actual preload QR images retain a quiet border and decode at the displayed size for login and recovery URLs', async () => {
  let api;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/preload/preload.js'), 'utf8'), {
    exports: {}, process: { isMainFrame: true },
    require: name => name === 'electron' ? { ipcRenderer: {}, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } } } : QRCode,
  });
  for (const recovery of [false, true]) {
    const url = new URL('https://proctorstu.example.org/candidate');
    url.searchParams.set('apiBase', 'https://proctoring.example.org'); url.searchParams.set('pairCode', '123456');
    if (recovery) url.searchParams.set('reconnect', '1');
    url.hash = `${recovery ? 'recoverySecret' : 'testSecret'}=${'x'.repeat(43)}`;
    const png = PNG.sync.read(Buffer.from((await api.createQrDataUrl(url.toString())).split(',')[1], 'base64'));
    // The quiet area stays white even at the edge of the displayed QR.
    for (let pixel = 0; pixel < png.width * 8; pixel++) assert.equal(png.data[pixel * 4], 255);
    const size = 240, pixels = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const source = (Math.floor(y * png.height / size) * png.width + Math.floor(x * png.width / size)) * 4;
      pixels.set(png.data.subarray(source, source + 4), (y * size + x) * 4);
    }
    assert.equal(jsQR(pixels, size, size, { inversionAttempts: 'attemptBoth' })?.data, url.toString());
  }
});
