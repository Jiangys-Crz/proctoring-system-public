import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_JPEG_BYTES = 4 * 1024 * 1024;
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);

// FFmpeg image2pipe does not preserve frame boundaries between stdout chunks.
export class JpegFrameReader {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    if (this.pending.length + chunk.length > MAX_JPEG_BYTES * 2) throw new Error('屏幕采集帧过大');
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    while (this.pending.length) {
      const start = this.pending.indexOf(SOI);
      if (start < 0) { this.pending = Buffer.from(this.pending.subarray(-1)); break; }
      if (start) this.pending = this.pending.subarray(start);
      const end = this.pending.indexOf(EOI, 2);
      if (end < 0) { if (this.pending.length > MAX_JPEG_BYTES) throw new Error('屏幕采集帧不完整'); break; }
      if (end + 2 > MAX_JPEG_BYTES) throw new Error('屏幕采集帧过大');
      frames.push(Buffer.from(this.pending.subarray(0, end + 2)));
      this.pending = this.pending.subarray(end + 2);
    }
    return frames;
  }
}

export type ScreenBounds = { x: number; y: number; width: number; height: number };
export type NativeScreenFrame = { sequence: number; jpeg: Uint8Array };
export function windows7ScreenArgs(bounds: ScreenBounds) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)
      || Math.abs(bounds.x) > 100000 || Math.abs(bounds.y) > 100000
      || bounds.width < 32 || bounds.height < 32 || bounds.width > 32768 || bounds.height > 32768) {
    throw new Error('无法确认完整屏幕尺寸');
  }
  // Capture the display bounds, including Shell taskbars, using GDI/CAPTUREBLT.
  // Never capture an HWND/client area or use the work area excluding app bars.
  // Keep scaling proportional, including 4:3 and 5:4 Windows 7 displays.
  return ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab', '-framerate', '15', '-draw_mouse', '1',
    '-offset_x', String(bounds.x), '-offset_y', String(bounds.y),
    '-video_size', `${bounds.width}x${bounds.height}`, '-i', 'desktop',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-an', '-c:v', 'mjpeg', '-q:v', '4', '-threads', '1', '-f', 'image2pipe', 'pipe:1'];
}

type Waiter = { after: number; resolve: (frame: NativeScreenFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Lease = { waiter?: Waiter };

// Keep one producer and only its latest frame. Two consumers allow a new
// screen track to prove it receives frames before replacing the old track.
export class Windows7ScreenCapture {
  private child: ChildProcessWithoutNullStreams | null = null;
  private leases = new Map<string, Lease>();
  private latest: NativeScreenFrame | null = null;
  private sequence = 0;
  private bounds = '';
  private failure: Error | null = null;
  constructor(private readonly executable: () => string,
    private readonly launch: typeof spawn = spawn) {}

  start(bounds: ScreenBounds): string {
    const args = windows7ScreenArgs(bounds), key = JSON.stringify(bounds);
    if (this.bounds !== key || this.failure) this.stopAll();
    if (this.leases.size >= 2) throw new Error('屏幕采集正在切换，请稍后重试');
    if (!this.child) {
      this.bounds = key;
      const reader = new JpegFrameReader();
      const child = this.launch(this.executable(), args, { windowsHide: true }) as ChildProcessWithoutNullStreams;
      this.child = child;
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        try {
          for (const jpeg of reader.push(chunk)) this.latest = { sequence: ++this.sequence, jpeg };
          if (!this.latest) return;
          for (const lease of this.leases.values()) {
            if (!lease.waiter || this.latest.sequence <= lease.waiter.after) continue;
            const waiter = lease.waiter; lease.waiter = undefined;
            clearTimeout(waiter.timer); waiter.resolve(this.latest);
          }
        } catch (error) { this.fail(child, error as Error); }
      });
      child.on('error', error => this.fail(child, error));
      child.on('exit', () => this.fail(child, new Error(`完整屏幕采集已停止${stderr.trim() ? '：' + stderr.trim() : ''}`)));
    }
    const id = randomUUID(); this.leases.set(id, {}); return id;
  }

  read(id: string, after: number): Promise<NativeScreenFrame> {
    const lease = this.leases.get(id);
    if (!lease || !Number.isSafeInteger(after) || after < 0) return Promise.reject(new Error('屏幕采集已结束'));
    if (this.failure) return Promise.reject(this.failure);
    if (lease.waiter) return Promise.reject(new Error('请等待上一帧采集完成'));
    if (this.latest && this.latest.sequence > after) return Promise.resolve(this.latest);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        lease.waiter = undefined; reject(new Error('完整屏幕采集超时，请重新检测'));
      }, after ? 3000 : 8000);
      lease.waiter = { after, resolve, reject, timer };
    });
  }

  stop(id: string) {
    const lease = this.leases.get(id);
    if (!lease) return;
    this.rejectLease(lease, new Error('屏幕采集已结束'));
    this.leases.delete(id);
    if (!this.leases.size) this.stopAll();
  }

  stopAll() {
    const child = this.child; this.child = null;
    for (const lease of this.leases.values()) this.rejectLease(lease, new Error('屏幕采集已结束'));
    this.leases.clear(); this.latest = null; this.failure = null; this.bounds = '';
    child?.kill('SIGKILL');
  }

  private rejectLease(lease: Lease, error: Error) {
    if (!lease.waiter) return;
    clearTimeout(lease.waiter.timer); lease.waiter.reject(error); lease.waiter = undefined;
  }
  private fail(child: ChildProcessWithoutNullStreams, error: Error) {
    if (this.child !== child) return;
    this.child = null; this.latest = null; this.failure = error;
    for (const lease of this.leases.values()) this.rejectLease(lease, error);
    child.kill('SIGKILL');
  }
}
