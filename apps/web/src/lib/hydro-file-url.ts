/** Signed Hydro download URLs may only name administrator-configured origins, and may not redirect. */
export function authorizedHydroFileUrl(value: string, baseUrl: string, additionalOrigins = process.env.HYDRO_FILE_ALLOWED_ORIGINS || '') {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('评测服务地址不符合要求');
  const allowed = new Set([base.origin]);
  for (const entry of additionalOrigins.split(',').map(item => item.trim()).filter(Boolean)) {
    const origin = new URL(entry);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || /[?#\\]/.test(entry) || origin.search || origin.hash || origin.pathname !== '/') {
      throw new Error('HYDRO_FILE_ALLOWED_ORIGINS 只能填写 HTTP/HTTPS 来源，不可包含路径或凭据');
    }
    allowed.add(origin.origin);
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error('评测服务未返回文件地址');
  const target = new URL(value, `${baseUrl.replace(/\/+$/, '')}/`);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || !allowed.has(target.origin)) {
    throw new Error('评测服务返回的文件地址不在允许的来源中');
  }
  return target;
}

export async function fetchHydroFile(value: string, baseUrl: string, signal?: AbortSignal) {
  const target = authorizedHydroFileUrl(value, baseUrl);
  // Signed downloads are bearer URLs themselves. Do not forward API keys, cookies or authorization headers.
  const timeout = AbortSignal.timeout(30_000);
  return fetch(target, { cache: 'no-store', redirect: 'error', credentials: 'omit', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}
