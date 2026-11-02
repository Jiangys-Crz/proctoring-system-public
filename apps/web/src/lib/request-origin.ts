/** Cookie-authenticated writes must come from the admin site's own origin. */
export function isTrustedMutationOrigin(request: Request, configuredBaseUrl = process.env.APP_BASE_URL || '') {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get('origin');
  if (origin === null) {
    // Native clients and server-side tools do not send Fetch Metadata. Browsers
    // that do send it must not use an opaque or cross-origin write context.
    const site = request.headers.get('sec-fetch-site');
    return !site || site === 'same-origin' || site === 'none';
  }
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
  if (parsed.origin === new URL(request.url).origin) return true;
  // A reverse proxy may give Next an internal HTTP URL while the browser uses
  // the configured HTTPS address. Never trust a client-supplied forwarded host.
  try { return !!configuredBaseUrl && parsed.origin === new URL(configuredBaseUrl).origin; }
  catch { return false; }
}
