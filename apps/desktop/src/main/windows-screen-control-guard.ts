import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface ScreenControlGuard {
  start(): void;
  stop(): void;
  updateWindows(handles: Buffer[]): void;
}

export class WindowsScreenControlGuard implements ScreenControlGuard {
  private active = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private handles: string[] = [];

  constructor(private readonly options: {
    executable: string;
    onDesktopChanged(): void;
    onStatus(error: string | null): void;
    launch?: typeof spawn;
  }) {}

  start() {
    if (this.active) return;
    this.active = true;
    this.attempts = 0;
    this.options.onStatus('正在启用屏幕控制保护…');
    this.launch();
  }

  stop() {
    this.active = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.retryTimer = this.readyTimer = null;
    const child = this.child;
    this.child = null;
    this.handles = [];
    if (child) this.release(child);
  }

  updateWindows(handles: Buffer[]) {
    this.handles = handles.map(handle => handle.length === 8 ? handle.readBigUInt64LE().toString(16) : handle.readUInt32LE().toString(16));
    this.sendWindows();
  }

  private sendWindows() {
    if (this.child && !this.child.stdin.destroyed) this.child.stdin.write(`WINDOWS ${this.handles.join(' ')}\n`);
  }

  private release(child: ChildProcessWithoutNullStreams) {
    child.stdin.end('STOP\n');
    // A wedged shell COM call cannot leave a helper/hook behind after STOP.
    const timeout = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000);
    timeout.unref();
    child.once('exit', () => clearTimeout(timeout));
  }

  private launch() {
    if (!this.active) return;
    this.attempts++;
    const child = (this.options.launch || spawn)(this.options.executable, [String(process.pid)], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    let output = '';
    const fail = () => {
      if (this.child !== child) return;
      this.child = null;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.release(child);
      if (!this.active) return;
      this.options.onStatus('屏幕控制保护异常，请联系监考老师。');
      if (this.attempts < 3) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.launch(); }, 500 * this.attempts);
    };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    this.readyTimer = setTimeout(fail, 4000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.active || this.child !== child) return;
      output += chunk.toString('utf8');
      if (output.length > 4096) { fail(); return; }
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (line === 'READY') {
          if (this.readyTimer) clearTimeout(this.readyTimer);
          this.readyTimer = null;
          this.options.onStatus(null);
          this.sendWindows();
        } else if (line === 'DESKTOP') {
          try { this.options.onDesktopChanged(); } catch { fail(); return; }
        }
        else if (line === 'DEGRADED') { fail(); return; }
      }
    });
  }
}
