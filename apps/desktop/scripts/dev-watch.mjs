/**
 * 桌面客户端开发模式（实时预览）：
 *
 *   1. 先做一次完整构建（tsc + 渲染资源拷贝），保证 dist 就绪
 *   2. 启动 tsc --watch，编译 src/main、src/preload、src/shared 的改动
 *   3. 监听 src/renderer，改动即同步到 dist/renderer
 *   4. 以 PROCTOR_DEV=1 启动 Electron：
 *        - 渲染资源变化 → 窗口自动刷新（由 dev-reload 在 main 进程内完成）
 *        - 主进程/预加载变化 → Electron 以退出码 42 退出，本脚本自动重启
 *   5. 开发模式下自动打开独立的 DevTools（见 main.ts）
 *
 * 用法：pnpm dev:desktop:watch
 */
import { spawn } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTART_EXIT_CODE = 42;
const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcRenderer = path.join(desktopDir, 'src', 'renderer');
const distRenderer = path.join(desktopDir, 'dist', 'renderer');
const useShell = process.platform === 'win32';

const tscBin = path.join(desktopDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const electronBin = path.join(desktopDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

let stopping = false;
let electronChild = null;
let tscWatch = null;
let copyTimer = null;
let copyQueue = Promise.resolve();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: desktopDir, stdio: 'inherit', shell: useShell });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function copyRenderer() {
  await mkdir(distRenderer, { recursive: true });
  await cp(srcRenderer, distRenderer, { recursive: true });
  console.log('[dev] renderer assets synced -> dist/renderer');
}

async function buildOnce() {
  await run(tscBin, ['-p', 'tsconfig.json']);
  await copyRenderer();
}

function spawnElectron() {
  const child = spawn(electronBin, ['.'], {
    cwd: desktopDir,
    stdio: 'inherit',
    shell: useShell,
    env: { ...process.env, PROCTOR_DEV: '1' }
  });
  electronChild = child;
  child.on('error', (error) => {
    console.error('[dev] failed to start electron:', error.message);
    shutdown(1);
  });
  child.on('exit', (code) => {
    if (stopping) return;
    if (code === RESTART_EXIT_CODE) {
      console.log('[dev] main/preload changed — restarting electron');
      spawnElectron();
    } else {
      console.log(`[dev] electron exited with code ${code ?? 0} — stopping`);
      shutdown(code ?? 0);
    }
  });
  return child;
}

function shutdown(code) {
  stopping = true;
  electronChild?.kill();
  tscWatch?.kill();
  process.exit(code);
}

console.log('[dev] initial build…');
try {
  await buildOnce();
} catch (error) {
  console.error('[dev] build failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}

try {
  watch(srcRenderer, { recursive: true }, () => {
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyQueue = copyQueue.then(copyRenderer).catch((error) => console.error('[dev] renderer sync failed:', error.message));
    }, 100);
  });
  console.log('[dev] watching src/renderer…');
} catch (error) {
  console.error('[dev] cannot watch src/renderer:', error instanceof Error ? error.message : error);
}

tscWatch = spawn(tscBin, ['-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], {
  cwd: desktopDir,
  stdio: 'inherit',
  shell: useShell
});
tscWatch.on('error', (error) => {
  console.error('[dev] tsc --watch failed:', error.message);
  shutdown(1);
});
tscWatch.on('exit', (code) => {
  console.log('[dev] tsc --watch exited with code', code);
  shutdown(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[dev] received ${signal} — cleaning up`);
    stopping = true;
    electronChild?.kill(signal);
    tscWatch.kill(signal);
    process.exit(0);
  });
}

spawnElectron();
