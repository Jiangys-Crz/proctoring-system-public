export interface ScreenControlIdentity {
  baseUrl: string;
  sessionId: string;
  token: string;
}

interface ScreenControlImage {
  id: string;
  name: string;
  url: string;
  order: number;
}

export interface ScreenControlDisplay {
  id: string;
  groupName: string;
  startsAtLocal: number;
  endsAtLocal: number | null;
  intervalMs: 5000;
  images: Array<{ id: string; name: string; dataUrl: string }>;
}

interface ScreenControlState {
  serverNow: number;
  nextStartsAt: number | null;
  active: null | {
    id: string;
    groupName: string;
    startsAt: number;
    endsAt: number | null;
    images: ScreenControlImage[];
  };
}

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function validateScreenControlIdentity(identity: ScreenControlIdentity): ScreenControlIdentity {
  const url = new URL(identity?.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !idPattern.test(identity?.sessionId) || typeof identity?.token !== 'string' ||
      !identity.token || identity.token.length > 8192 || /[\r\n]/.test(identity.token)) {
    throw new Error('无效的屏幕控制会话');
  }
  return { baseUrl: url.origin, sessionId: identity.sessionId, token: identity.token };
}

export function screenControlImageUrl(identity: ScreenControlIdentity, image: { id: string; url: string }) {
  if (!idPattern.test(image.id)) throw new Error('无效的屏幕控制图片');
  const url = new URL(image.url, identity.baseUrl);
  if (url.origin !== identity.baseUrl || url.username || url.password || url.hash ||
      url.pathname !== `/api/client/screen-control/images/${image.id}` ||
      url.searchParams.get('sessionId') !== identity.sessionId ||
      [...url.searchParams.keys()].some((key) => key !== 'sessionId')) {
    throw new Error('屏幕控制图片地址不属于当前会话');
  }
  return url;
}

function timestamp(value: unknown, required = false): number | null {
  if (value === null || value === undefined) {
    if (required) throw new Error('屏幕控制缺少服务器时间');
    return null;
  }
  const result = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(result)) throw new Error('无效的屏幕控制时间');
  return result;
}

export function parseScreenControlState(value: unknown, identity: ScreenControlIdentity): ScreenControlState {
  if (!value || typeof value !== 'object') throw new Error('无效的屏幕控制状态');
  const raw = value as Record<string, any>;
  const serverNow = timestamp(raw.serverNow, true)!;
  const nextStartsAt = timestamp(raw.nextStartsAt);
  if (raw.active === null) return { serverNow, nextStartsAt, active: null };
  const active = raw.active;
  if (!active || !idPattern.test(active.id) || typeof active.groupName !== 'string' ||
      active.groupName.length > 200 || active.intervalMs !== 5000 ||
      !Array.isArray(active.images) || active.images.length < 1 || active.images.length > 30) {
    throw new Error('无效的屏幕控制展示');
  }
  const startsAt = timestamp(active.startsAt, true)!;
  const endsAt = timestamp(active.endsAt);
  if (startsAt > serverNow || (endsAt !== null && (endsAt <= startsAt || endsAt <= serverNow))) {
    throw new Error('屏幕控制展示不在有效时间内');
  }
  const imageIds = new Set<string>();
  const images = active.images.map((image: any, index: number) => {
    if (!image || !idPattern.test(image.id) || imageIds.has(image.id) ||
        typeof image.url !== 'string' || typeof image.name !== 'string' || image.name.length > 512) {
      throw new Error('无效的屏幕控制图片列表');
    }
    imageIds.add(image.id);
    screenControlImageUrl(identity, image);
    return { id: image.id, name: image.name, url: image.url, order: Number.isFinite(image.order) ? image.order : index };
  }).sort((a: ScreenControlImage, b: ScreenControlImage) => a.order - b.order);
  return { serverNow, nextStartsAt, active: { id: active.id, groupName: active.groupName, startsAt, endsAt, images } };
}

type Timer = ReturnType<typeof setTimeout>;
export interface ScreenControlDependencies {
  readState(identity: ScreenControlIdentity): Promise<unknown>;
  readImage(identity: ScreenControlIdentity, image: ScreenControlImage): Promise<string>;
  display(value: ScreenControlDisplay | null): void;
  reportError?(error: unknown): void;
  now?(): number;
  setTimer?(callback: () => void, delay: number): Timer;
  clearTimer?(timer: Timer): void;
}

// The main process owns both polling and the display lock. A renderer refresh,
// stopped exam heartbeat, or untrusted webview cannot release a broadcast.
export class ScreenControlWatcher {
  private identity: ScreenControlIdentity | null = null;
  private generation = 0;
  private polling = false;
  private pollTimer: Timer | null = null;
  private expiryTimer: Timer | null = null;
  private releaseAfterDisplay = false;
  private current: ScreenControlDisplay | null = null;
  private loadedImages = '';
  private loadingImages = '';
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  constructor(private readonly dependencies: ScreenControlDependencies) {
    this.now = dependencies.now || Date.now;
    this.setTimer = dependencies.setTimer || setTimeout;
    this.clearTimer = dependencies.clearTimer || clearTimeout;
  }

  get isDisplaying() { return this.current !== null; }
  get displayState() { return this.current; }

  async watch(request: ScreenControlIdentity) {
    const identity = validateScreenControlIdentity(request);
    const sameSession = this.identity?.baseUrl === identity.baseUrl && this.identity.sessionId === identity.sessionId;
    if (this.isDisplaying && !sameSession) throw new Error('屏幕展示期间不能切换登录会话');
    this.releaseAfterDisplay = false;
    if (sameSession) {
      const tokenChanged = this.identity!.token !== identity.token;
      this.identity = identity;
      if (tokenChanged && !this.polling) await this.poll();
      return;
    }
    this.stop();
    this.identity = identity;
    await this.poll();
  }

  release() {
    if (this.isDisplaying) this.releaseAfterDisplay = true;
    else this.stop();
  }

  private stop() {
    this.generation += 1;
    this.identity = null;
    this.loadedImages = '';
    this.loadingImages = '';
    this.polling = false;
    if (this.pollTimer) this.clearTimer(this.pollTimer);
    if (this.expiryTimer) this.clearTimer(this.expiryTimer);
    this.pollTimer = null;
    this.expiryTimer = null;
    this.current = null;
    this.dependencies.display(null);
  }

  private clearDisplay() {
    if (this.expiryTimer) this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    this.loadedImages = '';
    this.loadingImages = '';
    if (this.current) {
      this.current = null;
      this.dependencies.display(null);
    }
    if (this.releaseAfterDisplay) this.stop();
  }

  private scheduleExpiry(generation: number) {
    if (this.expiryTimer) this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    if (this.current?.endsAtLocal === null || !this.current) return;
    // Timers larger than 2^31 overflow on Node, so recheck long broadcasts.
    const delay = Math.min(2_147_483_647, Math.max(0, this.current.endsAtLocal - this.now()));
    this.expiryTimer = this.setTimer(() => {
      if (generation !== this.generation || !this.current) return;
      if (this.current.endsAtLocal !== null && this.now() >= this.current.endsAtLocal) this.clearDisplay();
      else this.scheduleExpiry(generation);
    }, delay);
  }

  private async poll() {
    if (!this.identity || this.polling) return;
    const identity = this.identity;
    const generation = this.generation;
    if (this.pollTimer) this.clearTimer(this.pollTimer);
    this.pollTimer = null;
    this.polling = true;
    let pollDelay = 2000;
    try {
      const response = parseScreenControlState(await this.dependencies.readState(identity), identity);
      if (generation !== this.generation) return;
      const receivedAt = this.now();
      if (response.nextStartsAt !== null && response.nextStartsAt > response.serverNow) {
        pollDelay = Math.min(pollDelay, Math.max(100, response.nextStartsAt - response.serverNow));
      }
      if (!response.active) {
        this.clearDisplay();
        return;
      }
      const active = response.active;
      const sameDisplay = this.current?.id === active.id;
      const endsAtLocal = active.endsAt === null ? null : receivedAt + active.endsAt - response.serverNow;
      this.current = {
        id: active.id, groupName: active.groupName,
        startsAtLocal: receivedAt + active.startsAt - response.serverNow,
        endsAtLocal, intervalMs: 5000, images: sameDisplay ? this.current!.images : []
      };
      this.scheduleExpiry(generation);
      if (!sameDisplay) this.dependencies.display(this.current);
      const imageKey = `${active.id}:${active.images.map((image) => image.id).join(',')}`;
      if (this.loadedImages === imageKey || this.loadingImages === imageKey) return;
      this.loadingImages = imageKey;
      // Slow image downloads must never delay a subsequent stop/state poll.
      void this.loadImages(identity, generation, active, imageKey);
    } catch (error) {
      if (generation === this.generation) this.dependencies.reportError?.(error);
      // A transient network failure is never an instruction to unlock.
    } finally {
      if (generation === this.generation) {
        this.polling = false;
        if (this.identity) this.pollTimer = this.setTimer(() => { void this.poll(); }, pollDelay);
      }
    }
  }

  private async loadImages(identity: ScreenControlIdentity, generation: number,
    active: NonNullable<ScreenControlState['active']>, imageKey: string) {
    try {
      // Keep download concurrency bounded; tokens never enter the display page.
      const images: ScreenControlDisplay['images'] = [];
      for (let index = 0; index < active.images.length; index += 4) {
        const batch = await Promise.all(active.images.slice(index, index + 4).map(async (image) => ({
          id: image.id, name: image.name, dataUrl: await this.dependencies.readImage(identity, image)
        })));
        if (generation !== this.generation || this.current?.id !== active.id || this.loadingImages !== imageKey) return;
        images.push(...batch);
      }
      if (!this.current || generation !== this.generation || this.loadingImages !== imageKey) return;
      this.loadedImages = imageKey;
      this.current = { ...this.current, images };
      this.dependencies.display(this.current);
    } catch (error) {
      if (generation === this.generation) this.dependencies.reportError?.(error);
    } finally {
      if (this.loadingImages === imageKey) this.loadingImages = '';
    }
  }
}
