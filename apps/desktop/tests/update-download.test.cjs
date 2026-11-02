const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { mkdtemp, writeFile, readdir, rm } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

function fixture(payload, options = {}) {
  const sessions = []; let downloads = 0, cancellations = 0;
  const electron = { session: { fromPartition: name => {
    const instance = new EventEmitter(); sessions.push(name);
    instance.webRequest = { onBeforeRequest: callback => { instance.filter = callback; } };
    instance.downloadURL = url => {
      downloads++;
      queueMicrotask(async () => {
        const candidate = new EventEmitter(); let filename;
        candidate.getURLChain = () => options.redirect ? [url, 'https://other.example.org/installer.dmg'] : [url];
        candidate.getTotalBytes = () => payload.length;
        candidate.getReceivedBytes = () => payload.length;
        candidate.setSavePath = value => { filename = value; };
        candidate.cancel = () => { cancellations++; };
        instance.emit('will-download', { preventDefault() {} }, candidate);
        if (!filename) return;
        await writeFile(filename, payload);
        candidate.emit('updated', {}, 'progressing');
        candidate.emit('done', {}, 'completed');
      });
    };
    return instance;
  } } };
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../dist/main/update-download.js');
  const dependency = createRequire(filename);
  new Function('require', 'module', 'exports', readFileSync(filename, 'utf8'))(name => name === 'electron' ? electron : dependency(name), module, module.exports);
  return { ...module.exports, sessions, downloads: () => downloads, cancellations: () => cancellations };
}
function descriptor(payload) {
  return { url: '/api/desktop/releases/files/00000000-0000-4000-8000-000000000000.dmg', size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') };
}
test('Mac downloads verify the full package before opening it and reuse only an intact cached file', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mac-update-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(2048, 1), file = descriptor(bytes), f = fixture(bytes), progress = [];
  const saved = await f.downloadMacInstaller(file, 'https://legacy-proctor.example.test', root, value => progress.push(value));
  assert.equal(await f.matchesUpdateFile(saved, file), true); assert.equal(progress.at(-1), 100);
  assert.equal(await f.downloadMacInstaller(file, 'https://legacy-proctor.example.test', root, () => {}), saved); assert.equal(f.downloads(), 1);
  await writeFile(saved, Buffer.alloc(bytes.length, 2));
  assert.equal(await f.matchesUpdateFile(saved, file), false);
  await f.downloadMacInstaller(file, 'https://legacy-proctor.example.test', root, () => {}); assert.equal(f.downloads(), 2);
  assert.notEqual(f.sessions[0], f.sessions[1]);
});
test('Mac packages with changed content, redirected URLs or oversized responses never survive as usable installers', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mac-update-reject-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = descriptor(Buffer.alloc(2048, 1));
  for (const f of [fixture(Buffer.alloc(2048, 2)), fixture(Buffer.alloc(4096)), fixture(Buffer.alloc(2048, 1), { redirect: true })]) {
    await assert.rejects(f.downloadMacInstaller(file, 'https://legacy-proctor.example.test', root, () => {}));
    assert.deepEqual(await readdir(root), []);
  }
});
