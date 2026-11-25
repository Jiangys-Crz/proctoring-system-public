export type HydroBrowserScope = { origin: string; basePath: string; contestId: string };
export const HYDRO_PROCTOR_HEADER = 'x-hydro-proctor-key';

export function hydroBrowserScope(baseUrl: string, contestId: string): HydroBrowserScope {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /[\\\s]/.test(baseUrl) || !/^\/(?:d\/[a-zA-Z0-9_-]+\/?)?$/.test(url.pathname)
    || !/^[a-f\d]{24}$/.test(contestId)) throw new Error('HydroOJ 考试范围无效');
  return { origin: url.origin, basePath: url.pathname.replace(/\/$/, ''), contestId };
}

export function hydroBrowserCookie(value: unknown, scope: HydroBrowserScope) {
  const login = value as { platform?: string; loginUrl?: string; cookie?: { name?: string; value?: string }; expiresAt?: string } | null;
  const expirationDate = Date.parse(login?.expiresAt || '') / 1000;
  if (login?.platform !== 'HYDRO_BROWSER' || login.loginUrl !== `${scope.origin}${scope.basePath}/contest/${scope.contestId}`
    || login.cookie?.name !== 'sid' || typeof login.cookie.value !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(login.cookie.value)
    || !Number.isFinite(expirationDate) || expirationDate <= Date.now() / 1000) throw new Error('HydroOJ 登录凭据与当前考试不匹配');
  return { url: scope.origin, name: 'sid', value: login.cookie.value, path: '/', expirationDate,
    httpOnly: true, secure: scope.origin.startsWith('https:'), sameSite: 'lax' as const };
}

export function hydroBrowserClientKey(value: unknown) {
  const key = (value as { proctoringKey?: unknown } | null)?.proctoringKey;
  if (typeof key !== 'string' || !/^[\w-]{43}$/.test(key)) throw new Error('HydroOJ 未返回监考专用访问凭据');
  return key;
}

export function hydroBrowserHeaders(value: string, headers: Record<string, string>, scope: HydroBrowserScope | null, key: string) {
  const result = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== HYDRO_PROCTOR_HEADER));
  if (!scope || !key) return result;
  try {
    const url = new URL(value);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.origin === scope.origin) result[HYDRO_PROCTOR_HEADER] = key;
  } catch { /* Keep the proof within the configured origin. */ }
  return result;
}

function contestQueryAllowed(url: URL, scope: HydroBrowserScope) {
  const domain = scope.basePath.slice(3) || 'system';
  return url.searchParams.getAll('domainId').every(value => value === domain)
    && url.searchParams.getAll('tid').every(value => value === scope.contestId)
    && !url.searchParams.has('all') && !url.searchParams.has('allDomain') && !url.searchParams.has('sid');
}

function contestRoute(pathname: string, scope: HydroBrowserScope) {
  // Hydro generates both spellings for the default domain.
  if (scope.basePath === '' || scope.basePath === '/d/system') return pathname.replace(/^\/d\/system(?=\/)/, '');
  return pathname.startsWith(scope.basePath + '/') ? pathname.slice(scope.basePath.length) : '';
}

const domjudgeParticipantRoute = /^\/domjudge-ui(?:\/(?:booklet\.pdf|samples|runs\/-?\d+\/[1-9]\d*|school-logos\/[a-f0-9]{64}\.(?:png|jpg|webp|gif|svg)))?$/;

export function hydroBrowserNavigationAllowed(value: string, scope: HydroBrowserScope) {
  try {
    const url = new URL(value);
    if (url.origin !== scope.origin || !contestQueryAllowed(url, scope)) return false;
    const route = contestRoute(url.pathname, scope);
    const prefix = `/contest/${scope.contestId}`;
    if (route === prefix || route === prefix + '/') return true;
    if (route.startsWith(prefix + '/')) {
      const tail = route.slice(prefix.length);
      return /^\/(?:problems|print|clarification|scoreboard(?:\/[\w-]+)?|file\/(?:public|private)\/[^/]+)$/.test(tail)
        || domjudgeParticipantRoute.test(tail);
    }
    if (/^\/record\/[a-f\d]{24}$/.test(route)) return true; // Record ownership is resolved by the main process.
    return url.searchParams.get('tid') === scope.contestId && (route === '/record'
      || /^\/p\/[\w.-]+(?:\/submit|\/file\/[^/]+)?$/.test(route));
  } catch { return false; }
}

export function hydroBrowserFileUrl(value: string, scope: HydroBrowserScope) {
  if (!hydroBrowserNavigationAllowed(value, scope)) return false;
  const url = new URL(value);
  return url.pathname.includes('/file/') || /\/domjudge-ui\/(?:samples|booklet\.pdf)$/.test(url.pathname)
    || (/\/record\/[a-f\d]{24}$/.test(url.pathname) && url.searchParams.get('download') === '1');
}

export function hydroBrowserInlinePdf(value: string, scope: HydroBrowserScope) {
  if (!hydroBrowserFileUrl(value, scope)) return false;
  const url = new URL(value);
  return url.pathname.endsWith('/domjudge-ui/booklet.pdf')
    || (/\/file\/.*\.pdf$/i.test(url.pathname) && url.searchParams.get('noDisposition') === '1');
}

function xcpcioFrame(url: URL, scope: HydroBrowserScope) {
  if (!/^\/hydro-league-xcpcio\/index(?:-[\w.-]+)?\.html$/.test(url.pathname)) return false;
  const sources = url.searchParams.getAll('source');
  if (sources.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'source')) return false;
  const source = new URL(sources[0], scope.origin);
  const route = contestRoute(source.pathname, scope);
  const prefix = '/contest/' + scope.contestId + '/scoreboard/';
  return source.origin === scope.origin && !source.username && !source.password
    && route.startsWith(prefix) && ['xcpcio', 'leagueboard', 'league-xcpcio'].includes(route.slice(prefix.length))
    && source.searchParams.get('json') === 'true'
    && [...source.searchParams.keys()].every(key => ['json', 'scope', 'realtime'].includes(key) && source.searchParams.getAll(key).length === 1);
}

export function hydroBrowserRequestAllowed(value: string, type: string, scope: HydroBrowserScope, method = '') {
  try {
    const url = new URL(value);
    const frame = type === 'mainFrame' || type === 'subFrame';
    if (url.protocol === 'blob:') return !frame && url.origin === scope.origin;
    if (url.protocol === 'data:') return !frame;
    if (type === 'webSocket') {
      if (!['ws:', 'wss:'].includes(url.protocol)) return false;
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      return url.origin === scope.origin && contestQueryAllowed(url, scope) && (
        (url.pathname === '/record-conn' && url.searchParams.get('tid') === scope.contestId)
        || (url.pathname === '/record-detail-conn' && /^[a-f\d]{24}$/.test(url.searchParams.get('rid') || ''))
        || url.pathname === '/websocket'
      );
    }
    if (url.origin !== scope.origin) return false;
    const read = !method || method === 'GET' || method === 'HEAD';
    if (hydroBrowserNavigationAllowed(value, scope)) {
      const ui = '/contest/' + scope.contestId + '/domjudge-ui';
      const route = contestRoute(url.pathname, scope);
      if (route === ui) return !method || method === 'POST';
      return !route.startsWith(ui + '/') || read;
    }
    if (/^(?:\/d\/[\w-]+)?\/(?:contest|p|record)(?:\/|$)/.test(url.pathname)) return false;
    const fetch = type === 'xhr' || type === 'fetch' || type === 'other';
    if (read && (type === 'subFrame' || fetch) && xcpcioFrame(url, scope)) return true;
    if (frame) return false;
    if (read && fetch && /^\/hydro-league-xcpcio\/asset-manifest(?:-[\w.-]+)?\.json$/.test(url.pathname)) return true;
    return /^\/(?:resource|fs)\//.test(url.pathname)
      // Hydro's service worker re-fetches static assets with fetch(url), which
      // Electron reports as xhr/other instead of the original destination.
      || ((fetch || ['script', 'stylesheet', 'image', 'font', 'media'].includes(type))
        && /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|svg|gif|ico|avif|mp4)$/i.test(url.pathname));
  } catch { return false; }
}

export function hydroBrowserRecordId(value: string, scope: HydroBrowserScope) {
  const url = new URL(value);
  if (url.pathname === '/record-detail-conn') return url.searchParams.get('rid');
  return /^\/record\/([a-f\d]{24})$/.exec(contestRoute(url.pathname, scope))?.[1] || null;
}

export function hydroBrowserDownloadAllowed(source: string, urls: string[], scope: HydroBrowserScope, embedded: boolean) {
  return embedded && hydroBrowserNavigationAllowed(source, scope) && urls.length > 0
    && urls.every(value => {
      try {
        const url = new URL(value);
        return url.origin === scope.origin && (url.protocol === 'blob:' || url.pathname.startsWith('/fs/') || hydroBrowserFileUrl(value, scope));
      } catch { return false; }
    });
}
