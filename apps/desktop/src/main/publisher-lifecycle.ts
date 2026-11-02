import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type Slot<T> = { identity: string; child?: ChildProcessWithoutNullStreams; value?: T; ready: Promise<T> };

/** One publisher per physical channel, including the asynchronous startup period. */
export class PublisherLifecycle<T> {
  private slots = new Map<string, Slot<T>>();
  private stopping = new Map<string, Promise<void>>();
  private children = new Set<ChildProcessWithoutNullStreams>();

  start(channel: string, identity: string, launch: (register: (child: ChildProcessWithoutNullStreams) => void) => Promise<T>): Promise<T> {
    const existing = this.slots.get(channel);
    if (existing?.identity === identity && (!existing.child || this.alive(existing.child))) return existing.ready;
    const stopped = this.stop(channel);
    const slot: Slot<T> = { identity, ready: Promise.resolve(undefined as T) };
    this.slots.set(channel, slot);
    slot.ready = (async () => {
      await stopped;
      if (this.slots.get(channel) !== slot) throw new Error('推流启动已取消');
      try {
        // launch registers synchronously immediately after spawn, before awaiting readiness.
        const value = await launch((child) => {
          this.children.add(child);
          child.once('exit', () => this.children.delete(child));
          child.once('error', () => { if (!child.pid) this.children.delete(child); });
          slot.child = child;
          if (this.slots.get(channel) !== slot) {
            void this.terminate(child).catch(() => undefined);
            throw new Error('推流启动已取消');
          }
        });
        if (this.slots.get(channel) !== slot || !slot.child || !this.alive(slot.child)) throw new Error('推流启动已取消或进程已退出');
        slot.value = value;
        return value;
      } catch (error) {
        if (this.slots.get(channel) === slot) await this.stop(channel);
        throw error;
      }
    })();
    return slot.ready;
  }

  stop(channel: string): Promise<void> {
    const slot = this.slots.get(channel);
    this.slots.delete(channel);
    const previous = this.stopping.get(channel) || Promise.resolve();
    if (!slot?.child) return previous;
    const stopped = Promise.all([previous, this.terminate(slot.child)]).then(() => undefined);
    this.stopping.set(channel, stopped);
    // Preserve failures for the next start, but always install a rejection handler
    // because shutdown callers may intentionally not await process teardown.
    void stopped.then(() => { if (this.stopping.get(channel) === stopped) this.stopping.delete(channel); }, () => undefined);
    return stopped;
  }

  stopAll(): Promise<void> {
    const channels = new Set([...this.slots.keys(), ...this.stopping.keys()]);
    return Promise.all([...channels].map((channel) => this.stop(channel))).then(() => undefined);
  }

  /** exit handlers cannot await graceful shutdown. */
  killAllNow() {
    this.slots.clear();
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* Process already gone. */ }
      }
    }
  }

  private alive(child: ChildProcessWithoutNullStreams) {
    return !child.killed && child.exitCode === null && child.signalCode === null;
  }

  private terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(deadline);
        child.removeListener('exit', onExit);
        error ? reject(error) : resolve();
      };
      const onExit = () => finish();
      const forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* The exit event settles teardown. */ }
      }, 1500);
      const deadline = setTimeout(() => finish(new Error('旧推流进程尚未退出，已暂停新推流以避免重复录像')), 4000);
      forceTimer.unref();
      deadline.unref();
      child.once('exit', onExit);
      try { child.stdin.end(); } catch { /* Input is already closed. */ }
      try { child.kill('SIGTERM'); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
