export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  message?: string;
}

export function normalizeApiBase(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function isLocalNetworkHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || /^127\./.test(host)) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 169 && parts[1] === 254;
}

export function defaultApiBase(configured: string) {
  const normalized = normalizeApiBase(configured);
  if (typeof window === 'undefined') return 'http://localhost:4031';
  // The LAN HTTPS entry proxies both the candidate app and every /api request.
  // Keeping a previously saved http://...:4031 address on an HTTPS page makes
  // mobile Safari/Chrome reject all API calls as mixed content ("Load failed").
  const localFallback = window.location.protocol === 'https:'
    ? window.location.origin === 'https://proctorstu.example.org'
      ? 'https://proctoring.example.org'
      : window.location.origin
    : `${window.location.protocol}//${window.location.hostname}:4031`;
  if (!normalized) return localFallback;
  try {
    const configuredUrl = new URL(normalized);
    const pageHost = window.location.hostname;
    // Docker builds often contain the LAN address that was active at build time. When
    // both addresses are local, follow the host used by this phone instead of keeping
    // a stale localhost/private IP in localStorage or in a generated QR link.
    if (isLocalNetworkHost(pageHost) && isLocalNetworkHost(configuredUrl.hostname)) {
      if (window.location.protocol === 'https:' && configuredUrl.protocol === 'http:') {
        return window.location.origin;
      }
      configuredUrl.hostname = pageHost;
    }
    return configuredUrl.toString().replace(/\/$/, '');
  } catch {
    return localFallback;
  }
}

/** URL/QR parameters select an already configured service; they cannot add a new trusted origin. */
export function trustedApiBase(configured: string, requested?: string | null) {
  const fallback = defaultApiBase(configured);
  if (!requested) return fallback;
  const candidate = defaultApiBase(requested);
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('服务器地址不符合当前部署配置，请重新扫描客户端二维码');
  }
  const fallbackUrl = new URL(fallback);
  const allowed = new Map([[fallbackUrl.origin, fallbackUrl.pathname.replace(/\/+$/, '')]]);
  if (typeof window !== 'undefined') {
    if (!allowed.has(window.location.origin)) allowed.set(window.location.origin, '');
    if (window.location.protocol === 'http:') allowed.set(`http://${window.location.hostname}:4031`, '');
  }
  if (!allowed.has(parsed.origin) || allowed.get(parsed.origin) !== parsed.pathname.replace(/\/+$/, '')) throw new Error('二维码服务器地址不属于当前监考平台，请重新扫描客户端二维码');
  return normalizeApiBase(candidate);
}

export class ClientApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function isExpiredClientSessionError(error: unknown) {
  return error instanceof ClientApiError && [401, 410].includes(error.status);
}

function waitDownloadRetry(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('下载已取消或超时', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function restoreBoundSession(storage: Pick<Storage, 'getItem' | 'removeItem'>, prefix: string, base: string) {
  const savedBase = storage.getItem(`${prefix}.sessionApiBase`) || storage.getItem(`${prefix}.apiBase`);
  const id = storage.getItem(`${prefix}.sessionId`) || '';
  const token = storage.getItem(`${prefix}.sessionToken`) || '';
  if (!savedBase || normalizeApiBase(savedBase) !== normalizeApiBase(base) || !id || !token) {
    for (const key of ['sessionId', 'sessionToken', 'sessionApiBase', 'loginRequestId']) storage.removeItem(`${prefix}.${key}`);
    return { id: '', token: '' };
  }
  return { id, token };
}

export function absoluteMediaUrl(apiBase: string, value: string) {
  if (/^(https?:|blob:|data:)/i.test(value)) return value;
  return `${normalizeApiBase(apiBase)}${value.startsWith('/') ? '' : '/'}${value}`;
}

export class ClientApi {
  private serverClock?: { serverAt: number; observedAt: number };

  now() {
    return this.serverClock ? this.serverClock.serverAt + Math.max(0, performance.now() - this.serverClock.observedAt) : Date.now();
  }

  constructor(
    public base: string,
    public token = ''
  ) {
    this.base = normalizeApiBase(base);
  }

  private headers(extra?: HeadersInit) {
    const headers = new Headers(extra);
    headers.set('x-proctor-client', 'browser');
    if (this.token) {
      headers.set('x-proctor-session-token', this.token);
      headers.set('authorization', `Bearer ${this.token}`);
    }
    return headers;
  }

  async request<T>(path: string, init: RequestInit = {}) {
    const headers = this.headers(init.headers);
    if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort();
    const loginPost = (init.method || 'GET').toUpperCase() === 'POST' && [
      '/api/login-requests', '/api/client/credential-login', '/api/client/candidate-verify', '/api/client/pair', '/api/client/material-upload-ticket', '/api/client/reconnect'
    ].includes(path.split('?')[0]);
    const contestLoad = (init.method || 'GET').toUpperCase() === 'GET' && path.split('?')[0] === '/api/client/contest';
    const ojLogin = (init.method || 'GET').toUpperCase() === 'POST' && path.split('?')[0] === '/api/client/oj-cookie';
    const timeout = setTimeout(abort, init.body instanceof FormData || ojLogin ? 60_000 : loginPost ? 40_000 : contestLoad ? 30_000 : 15_000);
    try {
      const response = await fetch(`${this.base}${path}`, { ...init, signal: controller.signal, headers, redirect: 'error' });
      const body = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
      if (!response.ok || !body?.ok) throw new ClientApiError(body?.message || `请求失败（${response.status}）`, response.status);
      const data = body.data;
      if (data && typeof data === 'object' && 'serverNow' in data && typeof data.serverNow === 'string') {
        const serverAt = Date.parse(data.serverNow);
        if (Number.isFinite(serverAt)) this.serverClock = { serverAt, observedAt: performance.now() };
      }
      return data;
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    }
  }

  async upload<T>(path: string, file: Blob, filename: string, fields: Record<string, string>, headers?: HeadersInit) {
    const form = new FormData();
    form.append('file', file, filename);
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      return await this.request<T>(path, { method: 'POST', body: form, signal: controller.signal, headers });
    } finally {
      clearTimeout(timeout);
    }
  }

  async download(path: string, init: RequestInit = {}) {
    const headers = this.headers(init.headers);
    if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort();
    const timeout = setTimeout(abort, 60_000);
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${this.base}${path}`, {
          ...init, signal: controller.signal, headers, redirect: 'error',
        });
        // Busy download slots are transient. Retry read-only downloads within
        // the same deadline; do not turn a brief queue peak into a broken image.
        if ([429, 503].includes(response.status) && attempt < 3) {
          const retryAfter = Number(response.headers.get('retry-after')) || 1;
          await response.body?.cancel().catch(() => {});
          await waitDownloadRetry(Math.min(8000, Math.max(retryAfter * 1000, 1000 * 2 ** attempt)) + Math.random() * 500, controller.signal);
          continue;
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as ApiEnvelope<unknown> | null;
          throw new ClientApiError(body?.message || `下载失败（${response.status}）`, response.status);
        }
        // Keep the deadline until all bytes have arrived, not just the headers.
        return await response.blob();
      }
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    }
  }

  whipEndpoint(sessionId: string, channel = 'MOBILE_CAMERA') {
    return `${this.base}/api/client/whip?sessionId=${encodeURIComponent(sessionId)}&channel=${encodeURIComponent(channel)}`;
  }
}
