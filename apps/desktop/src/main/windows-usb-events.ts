import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { usbDeviceIdentity } from './windows-usb-identity';
export { usbDeviceIdentity } from './windows-usb-identity';

export type UsbEvent = { id: string; action: 'INSERT' | 'REMOVE'; deviceId: string };
type MonitorOptions = {
  launch?: typeof spawn;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
  diagnostic?: (detail: string) => void;
};

// Interface availability is not proof of a physical plug/unplug. Establish the
// present PnP inventory before trusting notifications, then verify transitions.
export class WindowsUsbEvents {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId = '';
  private events: UsbEvent[] = [];
  private ready = false;
  private fault = false;
  private starting: Promise<void> | null = null;
  private cancelStart: (() => void) | null = null;
  private known = new Set<string>();
  private arrivals = new Set<string>();
  private candidate: { devices: Set<string>; firstSeenAt: number } | null = null;
  private verificationTimer: ReturnType<typeof setTimeout> | null = null;
  private failWatcher: ((detail: string) => void) | null = null;
  private readonly launch: typeof spawn;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  constructor(private readonly executable: () => string, private readonly inventory: () => Promise<string[]>, private readonly options: MonitorOptions = {}) {
    this.launch = options.launch ?? spawn;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
  }
  private diagnostic(detail: string) { this.options.diagnostic?.(detail); }
  private enqueue(action: UsbEvent['action'], deviceId: string) {
    if (this.events.length >= 64) throw new Error('USB 事件队列已满');
    this.events.push({ id: randomUUID(), action, deviceId });
    this.diagnostic(`confirmed ${action} ${deviceId}`);
  }
  private observe(action: UsbEvent['action'], deviceId: string) {
    if (action === 'INSERT' && !this.known.has(deviceId)) {
      if (this.arrivals.size >= 64) throw new Error('USB 待核实设备过多');
      this.arrivals.add(deviceId);
    } else if (action === 'REMOVE' && this.arrivals.delete(deviceId) && !this.known.has(deviceId)) {
      // A genuinely new device may appear and disappear before either scan.
      // Existing-device resets do not qualify for this short-insertion path.
      if (this.events.length > 62) throw new Error('USB 事件队列已满');
      this.enqueue('INSERT', deviceId); this.enqueue('REMOVE', deviceId);
    }
    this.verifySoon();
  }
  private verifySoon() {
    if (this.verificationTimer || !this.child || !this.ready) return;
    const child = this.child;
    this.verificationTimer = this.schedule(() => {
      // Keep the timer marked as occupied until the scan settles, so parallel
      // OS notifications cannot launch overlapping confirmations.
      void this.inventory().then(ids => {
        if (this.child !== child) return;
        const devices = new Set(ids), now = this.now();
        const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(id => b.has(id));
        if (same(devices, this.known)) {
          this.diagnostic('ignored interface notifications; physical inventory unchanged');
          this.candidate = null; this.arrivals.clear();
        } else if (!this.candidate || !same(devices, this.candidate.devices)) {
          this.candidate = { devices, firstSeenAt: now };
        } else if (now - this.candidate.firstSeenAt >= 3000) {
          const removed = [...this.known].filter(id => !devices.has(id));
          const inserted = [...devices].filter(id => !this.known.has(id));
          if (this.events.length + removed.length + inserted.length > 64) throw new Error('USB 事件队列已满');
          for (const id of removed) this.enqueue('REMOVE', id);
          for (const id of inserted) this.enqueue('INSERT', id);
          this.known = devices; this.candidate = null; this.arrivals.clear();
        }
        this.verificationTimer = null;
        if (this.candidate) this.verifySoon();
      }).catch(error => { if (this.child === child) this.failWatcher?.(`inventory: ${String(error)}`); });
    }, 1500);
  }
  watch(sessionId: string): Promise<void> {
    if (this.sessionId !== sessionId) { this.stop(); this.events = []; this.sessionId = sessionId; }
    if (this.starting) return this.starting;
    if (this.child && this.ready) return Promise.resolve();
    this.stop(); this.fault = false;
    const task = new Promise<void>((resolve, reject) => {
      const child = this.launch(this.executable(), ['peripheral-events', String(process.pid)], { windowsHide: true }) as ChildProcessWithoutNullStreams;
      this.child = child;
      let buffer = ''; const decoder = new StringDecoder('utf8');
      let initialized = false;
      const earlyEvents: Array<{ action: UsbEvent['action']; deviceId: string }> = [];
      const fail = (detail = 'notification process exited') => {
        if (this.child !== child) return;
        this.child = null; this.ready = false; this.fault = true;
        this.cancel(timer); this.cancelStart = null;
        if (this.verificationTimer) this.cancel(this.verificationTimer);
        this.verificationTimer = null; this.failWatcher = null;
        this.diagnostic(`failed ${detail}`);
        child.kill(); reject(new Error('USB 设备通知监听不可用，请重新检测'));
      };
      this.failWatcher = fail;
      const timer = this.schedule(() => fail('startup timeout'), 10000);
      this.cancelStart = () => { this.cancel(timer); reject(new Error('USB 检测已结束')); };
      child.on('error', error => fail(String(error))); child.on('exit', (code, signal) => fail(`exit=${code} signal=${signal}`)); child.stderr.resume();
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        buffer += decoder.write(chunk);
        if (buffer.length > 65536) { fail('notification stream overflow'); return; }
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
          try {
            const value = JSON.parse(line);
            if (value.ready === true) {
              if (initialized) throw new Error('Duplicate ready message');
              initialized = true;
              void this.inventory().then(ids => {
                if (this.child !== child) return;
                this.known = new Set(ids); this.ready = true;
                this.diagnostic(`baseline devices=${this.known.size}`);
                for (const event of earlyEvents) this.observe(event.action, event.deviceId);
                this.cancel(timer); this.cancelStart = null; resolve();
              }).catch(error => fail(`baseline: ${String(error)}`));
              continue;
            }
            if (!initialized || !['INSERT', 'REMOVE'].includes(value.action)) throw new Error('Invalid device event');
            const deviceId = usbDeviceIdentity(value.path);
            if (!deviceId) continue;
            if (!this.ready) {
              if (earlyEvents.length >= 64) throw new Error('Startup notification overflow');
              earlyEvents.push({ action: value.action, deviceId });
            } else this.observe(value.action, deviceId);
          } catch (error) { fail(String(error)); return; }
        }
      });
    });
    this.starting = task;
    void task.finally(() => { if (this.starting === task) this.starting = null; }).catch(() => {});
    return task;
  }
  read(sessionId: string) {
    if (this.sessionId === sessionId && this.fault && !this.child && !this.starting) void this.watch(sessionId).catch(() => {});
    return { available: this.sessionId === sessionId && this.ready && !this.fault,
      events: this.sessionId === sessionId ? this.events.map(event => ({ ...event })) : [] };
  }
  acknowledge(sessionId: string, ids: string[]) {
    if (sessionId !== this.sessionId || !Array.isArray(ids) || ids.length > 64) return;
    const accepted = new Set(ids); this.events = this.events.filter(event => !accepted.has(event.id));
  }
  stop() {
    this.cancelStart?.(); this.cancelStart = null; this.starting = null;
    const child = this.child; this.child = null; this.ready = false;
    if (this.verificationTimer) this.cancel(this.verificationTimer);
    this.verificationTimer = null; this.failWatcher = null;
    this.candidate = null; this.arrivals.clear(); this.known.clear();
    child?.kill();
  }
}
