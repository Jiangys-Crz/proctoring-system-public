const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

test('the native policy blocks Windows task view and desktop shortcuts while preserving the secure attention sequence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-key-policy-'));
  try {
    const header = path.resolve(__dirname, '../native/windows-screen-control/keyboard-policy.h');
    const source = `#include <assert.h>\n#include ${JSON.stringify(header)}\nint main(void) {
      assert(screen_control_block_key(0x5b, 0, 0, 0));
      assert(screen_control_block_key(0x5c, 0, 0, 0));
      assert(screen_control_block_key(0x09, 0, 0, 1)); /* Win+Tab */
      assert(screen_control_block_key(0x25, 1, 0, 1)); /* Ctrl+Win+Left */
      assert(screen_control_block_key(0x27, 1, 0, 1)); /* Ctrl+Win+Right */
      assert(screen_control_block_key(0x44, 1, 0, 1)); /* Ctrl+Win+D */
      assert(screen_control_block_key(0x73, 1, 0, 1)); /* Ctrl+Win+F4 */
      assert(screen_control_block_key(0x44, 0, 0, 1)); /* Win+D */
      assert(screen_control_block_key(0x09, 0, 1, 0)); /* Alt+Tab */
      assert(screen_control_block_key(0x1b, 0, 1, 0)); /* Alt+Esc */
      assert(screen_control_block_key(0x73, 0, 1, 0)); /* Alt+F4 */
      assert(screen_control_block_key(0x1b, 1, 0, 0)); /* Ctrl+[Shift]+Esc */
      assert(!screen_control_block_key(0x2e, 1, 1, 0)); /* Ctrl+Alt+Delete */
      assert(!screen_control_block_key(0x2e, 1, 1, 1));
      assert(!screen_control_block_key(0x41, 0, 0, 0));
      assert(!screen_control_block_key(0x56, 1, 0, 0));
      return 0;
    }`;
    const file = path.join(directory, 'policy.c'), binary = path.join(directory, 'policy');
    fs.writeFileSync(file, source);
    const compile = spawnSync(process.env.CC || 'cc', ['-Wall', '-Wextra', '-Werror', file, '-o', binary], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr || String(compile.error));
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function fixture() {
  let now = 0;
  const timers = new Map(), children = [], statuses = [];
  let desktops = 0;
  const context = { module: { exports: {} }, exports: null, process: { pid: 321 }, Buffer,
    setTimeout(callback, delay) { const timer = { at: now + delay, callback, unref() {} }; timers.set(timer, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }, require,
  };
  context.exports = context.module.exports;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/main/windows-screen-control-guard'), 'utf8'), context);
  const guard = new context.module.exports.WindowsScreenControlGuard({ executable: 'guard.exe',
    onStatus(error) { statuses.push(error); }, onDesktopChanged() { desktops++; },
    launch(executable, args, options) {
      assert.equal(executable, 'guard.exe'); assert.deepEqual(Array.from(args), ['321']);
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      child.stdin = new EventEmitter(); child.stdin.destroyed = false; child.writes = [];
      child.stdin.write = text => child.writes.push(text);
      child.stdin.end = text => { child.writes.push(text); child.stdin.destroyed = true; };
      child.stdout = new EventEmitter(); child.stderr = { resume() {} }; child.exitCode = null;
      child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); };
      children.push(child); return child;
    },
  });
  return { guard, children, statuses, timers, get desktops() { return desktops; },
    advance(ms) { now += ms; for (const [timer] of timers) if (timer.at <= now) { timers.delete(timer); timer.callback(); } },
    send(child, message) { child.stdout.emit('data', Buffer.from(message)); },
  };
}

test('native guard reports readiness, tracks 32/64-bit windows and fully releases on broadcast stop', () => {
  const env = fixture(); env.guard.start(); env.guard.start();
  assert.equal(env.children.length, 1);
  const child = env.children[0];
  const x64 = Buffer.alloc(8); x64.writeBigUInt64LE(0x123456789n);
  env.guard.updateWindows([Buffer.from([1, 2, 0, 0]), x64]);
  env.send(child, 'DESK'); env.send(child, 'TOP\nREADY\n');
  assert.equal(env.desktops, 1);
  assert.equal(env.statuses.at(-1), null);
  assert.equal(child.writes.at(-1), 'WINDOWS 201 123456789\n');
  env.guard.stop();
  assert.equal(child.writes.at(-1), 'STOP\n');
  env.send(child, 'DESKTOP\nREADY\n');
  assert.equal(env.desktops, 1);
  env.advance(1000);
  assert.equal(child.killed, true, 'a helper stuck in a shell call must still be removed');
  assert.equal(env.timers.size, 0);
});

test('helper failures cannot report protected success and retries stop after three attempts', () => {
  const env = fixture(); env.guard.start();
  env.send(env.children[0], 'DEGRADED\n');
  assert.match(env.statuses.at(-1), /保护异常/);
  env.advance(500);
  env.children[1].emit('error', new Error('missing helper'));
  env.advance(1000);
  env.children[2].emit('exit', 22);
  env.advance(10_000);
  assert.equal(env.children.length, 3);
  assert.equal(env.statuses.includes(null), false);
  env.guard.stop();
  env.advance(10_000);
  assert.equal(env.timers.size, 0);
});

test('stopping during a retry cancels restart and a new broadcast starts a fresh helper', () => {
  const env = fixture(); env.guard.start();
  env.children[0].emit('error', new Error('offline'));
  env.guard.stop(); env.advance(10_000);
  assert.equal(env.children.length, 1);
  env.guard.start();
  assert.equal(env.children.length, 2);
  env.send(env.children[1], 'READY\n');
  assert.equal(env.statuses.at(-1), null);
  env.guard.stop(); env.advance(1000);
});

test('an unresponsive helper triggers visible failure instead of silently claiming protection', () => {
  const env = fixture(); env.guard.start(); env.advance(4000);
  assert.match(env.statuses.at(-1), /保护异常/);
  env.guard.stop(); env.advance(10_000);
  assert.equal(env.children.length, 1);
});
