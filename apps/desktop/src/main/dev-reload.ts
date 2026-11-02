/**
 * 开发模式热更新（仅在 PROCTOR_DEV=1 时由 main.ts 加载）。
 *
 * - dist/renderer 下任何资源变化 → 刷新当前窗口（HTML/CSS/JS 改完立刻可见）
 * - dist/main 或 dist/preload 下任何 JS 变化 → 以退出码 42 退出，由 dev-watch.mjs 重启 Electron
 */
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

const distRoot = path.join(__dirname, '..');
const watchedDirs: Array<{ dir: string; on: 'reload' | 'restart' }> = [
  { dir: path.join(distRoot, 'renderer'), on: 'reload' },
  { dir: path.join(distRoot, 'main'), on: 'restart' },
  { dir: path.join(distRoot, 'preload'), on: 'restart' }
];
const RESTART_EXIT_CODE = 42;
/** tsc --watch 启动时会先全量重编一次，延迟挂载 watcher 以吸收这次初始 emit，避免启动即重启 */
const WATCHER_GRACE_MS = 3000;

let timer: NodeJS.Timeout | null = null;
let pendingAction: 'reload' | 'restart' = 'reload';

function schedule(action: 'reload' | 'restart') {
  if (timer) clearTimeout(timer);
  if (action === 'restart') pendingAction = 'restart';
  timer = setTimeout(() => {
    timer = null;
    const nextAction = pendingAction;
    pendingAction = 'reload';
    if (nextAction === 'reload') {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.reload();
      }
      console.log('[dev] renderer changed, window reloaded');
    } else {
      console.log('[dev] main/preload changed, relaunching electron…');
      app.exit(RESTART_EXIT_CODE);
    }
  }, 150);
}

function relevant(filename: string | null, action: 'reload' | 'restart') {
  if (!filename) return true;
  const lower = filename.toLowerCase();
  if (action === 'reload') return true;
  return lower.endsWith('.js');
}

export function enableDevReload() {
  console.log('[dev] dev-reload active (renderer -> reload, main/preload -> restart)');
  setTimeout(() => {
    for (const { dir, on } of watchedDirs) {
      let watcher: FSWatcher | null = null;
      try {
        watcher = watch(dir, { persistent: true, recursive: true }, (_event, filename) => {
          if (relevant(filename, on)) schedule(on);
        });
      } catch (error) {
        console.warn('[dev] cannot watch', dir, error instanceof Error ? error.message : error);
      }
      watcher?.on('error', (error) => console.warn('[dev] watcher error on', dir, error.message));
    }
    console.log('[dev] dev-reload watching dist/');
  }, WATCHER_GRACE_MS);
}
