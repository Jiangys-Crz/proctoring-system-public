import path from 'node:path';
import { app, BrowserWindow, screen, type WebContents } from 'electron';
import type { ScreenControlDisplay } from './screen-control';
import { WindowsScreenControlGuard, type ScreenControlGuard } from './windows-screen-control-guard';

// Dedicated windows keep the broadcast above setup, waiting, exam and security
// pages without changing their original window mode or monitoring lifecycle.
export class ScreenControlWindows {
  private readonly windows = new Map<number, BrowserWindow>();
  private current: ScreenControlDisplay | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly guard: ScreenControlGuard | null;
  private guardError: string | null = null;
  private readonly onDisplaysChanged = () => { if (this.current) this.reconcileWindows(); };

  constructor(private readonly restoreClient: () => void, guard?: ScreenControlGuard) {
    this.guard = guard || (process.platform === 'win32' ? new WindowsScreenControlGuard({
      executable: app.isPackaged ? path.join(process.resourcesPath, 'security/screen-control-guard.exe')
        : path.join(__dirname, '../../native/windows-screen-control', process.arch, 'screen-control-guard.exe'),
      onDesktopChanged: () => {
        if (!this.current) return;
        // Showing an existing HWND cannot move it to another Windows virtual
        // desktop. Recreate windows while the native shields cover all screens.
        for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy();
        this.windows.clear();
        this.reconcileWindows();
      },
      onStatus: (error) => {
        this.guardError = error;
        if (error) console.warn('[screen-control]', error);
        this.sendDisplay();
      },
    }) : null);
  }

  dispose() { this.show(null); }

  rendererReady(sender: WebContents) {
    // Only our dedicated display windows may request their latest image data.
    if (!this.current) return;
    for (const window of this.windows.values()) {
      if (!window.isDestroyed() && window.webContents === sender) {
        sender.send('screen-control:display', { ...this.current, guardError: this.guardError });
        return;
      }
    }
  }

  private sendDisplay() {
    if (!this.current) return;
    for (const window of this.windows.values()) {
      if (!window.isDestroyed() && !window.webContents.isLoading()) window.webContents.send('screen-control:display', { ...this.current, guardError: this.guardError });
    }
  }

  show(value: ScreenControlDisplay | null) {
    const wasDisplaying = this.current !== null;
    this.current = value;
    if (!value) {
      this.guard?.stop();
      this.guardError = null;
      if (this.focusTimer) clearTimeout(this.focusTimer);
      this.focusTimer = null;
      screen.removeListener('display-added', this.onDisplaysChanged);
      screen.removeListener('display-removed', this.onDisplaysChanged);
      screen.removeListener('display-metrics-changed', this.onDisplaysChanged);
      for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy();
      this.windows.clear();
      if (wasDisplaying) this.restoreClient();
      return;
    }
    if (!wasDisplaying) {
      this.guard?.start();
      screen.on('display-added', this.onDisplaysChanged);
      screen.on('display-removed', this.onDisplaysChanged);
      screen.on('display-metrics-changed', this.onDisplaysChanged);
    }
    this.reconcileWindows();
    this.sendDisplay();
  }

  private focusPrimary() {
    if (!this.current) return;
    const window = this.windows.get(screen.getPrimaryDisplay().id) || this.windows.values().next().value;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private reconcileWindows() {
    const displays = screen.getAllDisplays();
    const displayIds = new Set(displays.map((display) => display.id));
    for (const [id, window] of this.windows) {
      if (!displayIds.has(id)) { window.destroy(); this.windows.delete(id); }
    }
    for (const display of displays) {
      let window = this.windows.get(display.id);
      if (window && !window.isDestroyed()) {
        window.setBounds(display.bounds);
        window.setFocusable(display.id === screen.getPrimaryDisplay().id);
        continue;
      }
      const primary = display.id === screen.getPrimaryDisplay().id;
      window = new BrowserWindow({
        ...display.bounds, show: process.platform === 'win32', frame: false, backgroundColor: '#000000',
        title: '监考屏幕展示', alwaysOnTop: true, skipTaskbar: true,
        closable: false, minimizable: false, maximizable: false,
        movable: false, resizable: false, fullscreenable: true, focusable: primary,
        webPreferences: {
          preload: path.join(__dirname, '../preload/screen-control-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true,
          webSecurity: true, devTools: false
        }
      });
      const overlay = window;
      this.windows.set(display.id, overlay);
      overlay.setAlwaysOnTop(true, 'screen-saver');
      // Electron explicitly does not implement this API on Windows.
      if (process.platform !== 'win32') overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // macOS simple fullscreen avoids moving each display into a separate Space.
      if (process.platform === 'darwin') overlay.setSimpleFullScreen(true);
      else { overlay.setFullScreen(true); overlay.setKiosk(true); }
      overlay.on('close', (event) => { if (this.current) event.preventDefault(); });
      overlay.on('minimize', () => { if (this.current) overlay.restore(); });
      overlay.on('leave-full-screen', () => {
        if (!this.current || overlay.isDestroyed()) return;
        if (process.platform === 'darwin') overlay.setSimpleFullScreen(true);
        else { overlay.setFullScreen(true); overlay.setKiosk(true); }
      });
      overlay.on('blur', () => {
        if (display.id !== screen.getPrimaryDisplay().id) return;
        if (!this.current || this.focusTimer) return;
        this.focusTimer = setTimeout(() => { this.focusTimer = null; this.focusPrimary(); }, 50);
      });
      overlay.webContents.on('before-input-event', (event) => event.preventDefault());
      overlay.webContents.on('context-menu', (event) => event.preventDefault());
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      overlay.webContents.on('will-navigate', (event) => event.preventDefault());
      overlay.webContents.on('will-attach-webview', (event) => event.preventDefault());
      overlay.webContents.on('did-finish-load', () => {
        this.sendDisplay();
      });
      // Electron 22 still reports isLoading() during did-finish-load. Replay
      // after loading stops, including after a renderer crash or slow startup.
      overlay.webContents.on('did-stop-loading', () => this.sendDisplay());
      overlay.webContents.on('render-process-gone', () => {
        if (this.current && !overlay.isDestroyed()) void overlay.loadFile(path.join(__dirname, '../renderer/screen-control.html'));
      });
      overlay.once('ready-to-show', () => {
        if (!this.current || overlay.isDestroyed()) return;
        if (primary) { overlay.show(); overlay.focus(); }
        else overlay.showInactive();
      });
      void overlay.loadFile(path.join(__dirname, '../renderer/screen-control.html'));
    }
    this.guard?.updateWindows([...this.windows.values()].filter(window => !window.isDestroyed()).map(window => window.getNativeWindowHandle()));
    this.focusPrimary();
  }
}
