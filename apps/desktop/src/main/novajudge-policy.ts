export type NovaJudgeScope = { origin: string; contestId: string };
export const NOVAJUDGE_PROCTOR_HEADER = 'x-novajudge-proctor-key';

export function novaJudgeClientKey(value: unknown) {
  const login = value as { loginSource?: string; proctoringKey?: string } | null;
  if (login?.loginSource !== 'PROCTORING' || typeof login.proctoringKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(login.proctoringKey)) {
    throw new Error('NovaJudge 未返回监考专用访问凭据，请更新 NovaJudge 与监考后台');
  }
  return login.proctoringKey;
}

export function novaJudgeHeaders(url: string, headers: Record<string, string>, scope: NovaJudgeScope | null, key: string) {
  const result = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== NOVAJUDGE_PROCTOR_HEADER));
  if (scope && key) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
      else if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
      if (parsed.origin === scope.origin) result[NOVAJUDGE_PROCTOR_HEADER] = key;
    } catch { /* Never disclose the binding outside the exact NovaJudge origin. */ }
  }
  return result;
}

export function novaJudgeFileUrl(value: string, scope: NovaJudgeScope) {
  try {
    const url = new URL(value);
    return url.origin === scope.origin && (/^\/api\/problems\/[^/]+\/assets\/[^/]+$/.test(url.pathname)
      || [`/api/contests/${scope.contestId}/editorial`, `/api/contests/${scope.contestId}/rank-export`].includes(url.pathname)
      || /\.(?:pdf|zip|7z|rar|tar|gz|txt|csv|xlsx?|docx?|pptx?|cpp|c|h|py|java|in|out)$/i.test(url.pathname));
  } catch { return false; }
}

export function novaJudgeNavigationAllowed(value: string, scope: NovaJudgeScope) {
  try {
    const url = new URL(value);
    const prefix = `/contest/${scope.contestId}`;
    return url.origin === scope.origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
  } catch { return false; }
}

/** Every network request, including images, scripts, sockets and redirects,
 * must stay on the configured origin. Frames stay in this one contest. */
export function novaJudgeRequestAllowed(value: string, type: string, scope: NovaJudgeScope) {
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:') return url.origin === scope.origin && !['mainFrame', 'subFrame'].includes(type);
    if (url.protocol === 'data:') return !['mainFrame', 'subFrame'].includes(type);
    if (['ws:', 'wss:'].includes(url.protocol)) {
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      return type === 'webSocket' && url.origin === scope.origin;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== scope.origin) return false;
    if (type === 'mainFrame' || type === 'subFrame') return novaJudgeNavigationAllowed(value, scope);
    return true;
  } catch { return false; }
}

export function novaJudgeDownloadAllowed(source: string, urls: string[], scope: NovaJudgeScope, embedded: boolean) {
  return embedded && novaJudgeNavigationAllowed(source, scope) && urls.length > 0
    && urls.every(value => {
      try { const url = new URL(value); return ['http:', 'https:', 'blob:'].includes(url.protocol) && url.origin === scope.origin; }
      catch { return false; }
    });
}

export function novaJudgeCookie(value: unknown, scope: NovaJudgeScope) {
  const login = value as { loginUrl?: string; cookie?: { name?: string; value?: string } } | null;
  if (login?.loginUrl !== `${scope.origin}/contest/${scope.contestId}` || login.cookie?.name !== 'user_token'
    || typeof login.cookie.value !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(login.cookie.value)
    || login.cookie.value.length > 8192) throw new Error('NovaJudge 登录凭据与当前考试不匹配');
  return { url: scope.origin, name: 'user_token', value: login.cookie.value, path: '/',
    httpOnly: true, secure: scope.origin.startsWith('https:'), sameSite: 'lax' as const };
}
