const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { ensureMacInstallation } = require('../dist/main/mac-installation');

function fixture(options = {}) {
  const messages = [], errors = []; let quits = 0, moves = 0;
  const app = { isPackaged: true, isInApplicationsFolder: () => false, getVersion: () => '1.0.11',
    getPath: () => '/Volumes/监考客户端/程序设计算法协会监考客户端.app/Contents/MacOS/客户端',
    quit: () => quits++, moveToApplicationsFolder: value => { moves++; return options.move ? options.move(value) : true; }, ...options.app };
  const dialog = { showMessageBox: async value => { messages.push(value); return { response: options.response || 0 }; },
    showErrorBox: (...value) => errors.push(value) };
  return { app, dialog, messages, errors, quits: () => quits, moves: () => moves };
}
test('installed and development Mac apps start without moving or opening an installer prompt', async () => {
  for (const app of [{ isPackaged: false }, { isInApplicationsFolder: () => true }]) {
    const f = fixture({ app }); assert.equal(await ensureMacInstallation(f.app, f.dialog), true);
    assert.equal(f.moves(), 0); assert.equal(f.messages.length, 0);
  }
});
test('opening the new DMG installs before the instance lock and never activates an older running copy', async () => {
  const f = fixture({ move: ({ conflictHandler }) => {
    assert.equal(conflictHandler('exists'), true); assert.equal(conflictHandler('existsAndRunning'), false); return true;
  } });
  assert.equal(await ensureMacInstallation(f.app, f.dialog), false);
  assert.equal(f.moves(), 1); assert.match(f.messages[0].title, /1\.0\.11/);
  const source = readFileSync(require.resolve('../src/main/bootstrap.ts'), 'utf8');
  assert(source.indexOf('ensureMacInstallation(app, dialog)') < source.indexOf('app.requestSingleInstanceLock()'));
  assert(source.indexOf("process.argv.includes('--proctor-version')") < source.indexOf('ensureMacInstallation(app, dialog)'));
});
test('cancelled installation, an active old copy and copy errors stop startup with actionable feedback', async () => {
  const cancelled = fixture({ response: 1 });
  assert.equal(await ensureMacInstallation(cancelled.app, cancelled.dialog), false);
  assert.equal(cancelled.moves(), 0); assert.equal(cancelled.quits(), 1);
  const busy = fixture({ move: () => false });
  assert.equal(await ensureMacInstallation(busy.app, busy.dialog), false);
  assert.match(busy.messages[1].message, /尚未替换/); assert.equal(busy.quits(), 1);
  const failed = fixture({ move: () => { throw Error('read-only volume'); } });
  assert.equal(await ensureMacInstallation(failed.app, failed.dialog), false);
  assert.equal(failed.errors.length, 1); assert.equal(failed.quits(), 1);
});
