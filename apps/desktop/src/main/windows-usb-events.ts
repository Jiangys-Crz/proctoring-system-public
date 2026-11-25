import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { usbDeviceIdentity, windowsUsbFingerprint, type WindowsUsbInventorySample } from './windows-usb-identity';
export { usbDeviceIdentity } from './windows-usb-identity';

export type UsbEvent = { id: string; action: 'INSERT' | 'REMOVE'; deviceId: string };
type TimedUsbEvent = UsbEvent & { firstSeenAt: number; inventoryFingerprint?: string };
type MonitorOptions = {
  launch?: typeof spawn;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
  diagnostic?: (detail: string) => void;
  confirmFingerprint?: (fingerprint: string, observedAt: number) => void;
  confirmedBaseline?: (fingerprint: string) => readonly string[] | undefined;
};

// Interface availability is not proof of a physical plug/unplug. Establish the
// present PnP inventory before trusting notifications, then verify transitions.
export class WindowsUsbEvents {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId = '';
  private events: TimedUsbEvent[] = [];
  private ready = false;
  private fault = false;
  private starting: Promise<void> | null = null;
  private cancelStart: (() => void) | null = null;
  private known: Set<string> | null = null;
  private arrivals = new Map<string, { firstPresent: number | null; departed: boolean; revision: number }>();
  private hintRevision = 0;
  private candidate: { devices: Set<string>; firstSeenAt: number } | null = null;
  private verificationTimer: ReturnType<typeof setTimeout> | null = null;
  private failWatcher: ((detail: string) => void) | null = null;
  private failedScans = 0;
  private readonly launch: typeof spawn;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  constructor(private readonly executable: () => string, private readonly inventory: () => Promise<WindowsUsbInventorySample>, private readonly options: MonitorOptions = {}) {
    this.launch = options.launch ?? spawn;
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
  }
  private diagnostic(detail: string) { this.options.diagnostic?.(detail); }
  private enqueue(action: UsbEvent['action'], deviceId: string, firstSeenAt: number, inventoryFingerprint?: string) {
    if (this.events.length >= 64) throw new Error('USB 事件队列已满');
    this.events.push({ id: randomUUID(), action, deviceId, firstSeenAt, ...(inventoryFingerprint ? { inventoryFingerprint } : {}) });
    this.diagnostic(`confirmed ${action} ${deviceId}`);
  }
  private observe(action: UsbEvent['action'], deviceId: string) {
    const revision = ++this.hintRevision;
    const arrival = this.arrivals.get(deviceId);
    if (action === 'INSERT' && !this.known?.has(deviceId)) {
      if (arrival?.departed || (!arrival && this.arrivals.size < 64)) this.arrivals.set(deviceId, { firstPresent: null, departed: false, revision });
      else if (arrival) arrival.revision = revision;
    } else if (action === 'REMOVE' && arrival) {
      arrival.departed = true; arrival.revision = revision;
    }
    // Start inventory promptly so a brief connection can be observed. Device
    // events still require confirmation from the physical snapshots.
    this.verifySoon(250);
  }
  private clearArrivalsThrough(revision: number, confirmed?: Set<string>) {
    for (const [id, arrival] of this.arrivals) {
      if (arrival.revision <= revision || confirmed?.has(id)) this.arrivals.delete(id);
    }
  }
  private verifySoon(delay = 1500) {
    if (this.verificationTimer || !this.child || !this.ready) return;
    const child = this.child;
    const prompt = delay < 1500;
    this.verificationTimer = this.schedule(() => {
      // Keep the timer marked as occupied until the scan settles, so parallel
      // OS notifications cannot launch overlapping confirmations.
      const revision = this.hintRevision;
      void this.inventory().then(({ devices: ids, observedAt: now }) => {
        const known = this.known;
        if (this.child !== child || !known) return;
        this.failedScans = 0;
        const devices = new Set(ids);
        const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(id => b.has(id));
        const before = this.events.length;
        // An interface hint must be corroborated by the physical inventory,
        // including a temporary insertion that has since been removed.
        for (const [id, arrival] of this.arrivals) {
          if (arrival.revision > revision) continue;
          if (devices.has(id)) arrival.firstPresent ??= now;
          else if (arrival.departed) {
            if (arrival.firstPresent !== null) {
              if (this.events.length > 62) throw new Error('USB 事件队列已满');
              this.enqueue('INSERT', id, arrival.firstPresent); this.enqueue('REMOVE', id, now);
            }
            this.arrivals.delete(id);
          }
        }
        const unchanged = same(devices, known);
        if (unchanged) {
          if (!prompt && before === this.events.length) this.diagnostic('ignored interface notifications; physical inventory unchanged');
          this.candidate = null;
          if (!prompt) this.clearArrivalsThrough(revision);
        } else if (!this.candidate || !same(devices, this.candidate.devices)) {
          this.candidate = { devices, firstSeenAt: now };
        } else if (now - this.candidate.firstSeenAt >= 3000) {
          const removed = [...known].filter(id => !devices.has(id));
          const inserted = [...devices].filter(id => !known.has(id));
          if (this.events.length + removed.length + inserted.length > 64) throw new Error('USB 事件队列已满');
          const fingerprint = windowsUsbFingerprint(devices);
          for (const id of removed) this.enqueue('REMOVE', id, this.candidate.firstSeenAt, fingerprint);
          for (const id of inserted) this.enqueue('INSERT', id, this.candidate.firstSeenAt, fingerprint);
          this.options.confirmFingerprint?.(fingerprint, now);
          this.known = devices; this.candidate = null; this.clearArrivalsThrough(revision, devices);
        }
        this.verificationTimer = null;
        // A device notification can arrive after SetupAPI sampled the list.
        // Recheck it even if that older result matched the baseline.
        // SetupAPI may still return the pre-change list on the quick probe.
        if (this.candidate || revision !== this.hintRevision || prompt && unchanged) this.verifySoon();
      }, error => {
        if (this.child !== child) return;
        this.candidate = null; this.clearArrivalsThrough(revision);
        for (const arrival of this.arrivals.values()) arrival.firstPresent = null;
        this.verificationTimer = null;
        if (++this.failedScans >= 2) this.failWatcher?.(`inventory: ${String(error)}`);
        else {
          this.diagnostic(`inventory retry: ${String(error)}`);
          this.verifySoon();
        }
      }).catch(error => { if (this.child === child) this.failWatcher?.(String(error)); });
    }, delay);
  }
  watch(sessionId: string, baselineFingerprint?: string): Promise<void> {
    if (this.sessionId !== sessionId) {
      this.stop();
      this.events = [];
      const approved = baselineFingerprint ? this.options.confirmedBaseline?.(baselineFingerprint) : undefined;
      this.known = approved ? new Set(approved) : null;
      this.sessionId = sessionId;
    }
    if (this.starting) return this.starting;
    if (this.child && this.ready) return Promise.resolve();
    this.stop();
    const task = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.launch(this.executable(), ['peripheral-events', String(process.pid)], { windowsHide: true });
      } catch (error) {
        this.fault = true;
        this.diagnostic(`failed launch: ${String(error)}`);
        reject(new Error('USB 设备通知监听不可用，请重新检测'));
        return;
      }
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
              void this.inventory().then(({ devices: ids, observedAt }) => {
                if (this.child !== child) return;
                const devices = new Set(ids);
                const known = this.known ??= devices;
                this.ready = true;
                this.diagnostic(`baseline devices=${known.size}`);
                if (devices.size !== known.size || ids.some(id => !known.has(id))) {
                  for (const id of devices) {
                    if (!known.has(id) && this.arrivals.size < 64) {
                      this.arrivals.set(id, { firstPresent: observedAt, departed: false, revision: this.hintRevision });
                    }
                  }
                  this.candidate = { devices, firstSeenAt: observedAt };
                  this.verifySoon();
                }
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
    const now = this.now();
    return { available: this.sessionId === sessionId && this.ready && !this.fault,
      events: this.sessionId === sessionId ? this.events.map(({ firstSeenAt, ...event }) => ({
        ...event, observedAgeMs: Math.floor(now - firstSeenAt)
      })) : [] };
  }
  acknowledge(sessionId: string, ids: string[]) {
    if (sessionId !== this.sessionId || !Array.isArray(ids) || ids.length > 64) return;
    const accepted = new Set(ids); this.events = this.events.filter(event => !accepted.has(event.id));
  }
  stop() {
    this.cancelStart?.(); this.cancelStart = null; this.starting = null;
    const child = this.child; this.child = null; this.ready = this.fault = false;
    if (this.verificationTimer) this.cancel(this.verificationTimer);
    this.verificationTimer = null; this.failWatcher = null;
    this.failedScans = 0; this.candidate = null; this.arrivals.clear(); this.hintRevision = 0;
    child?.kill();
  }
}
