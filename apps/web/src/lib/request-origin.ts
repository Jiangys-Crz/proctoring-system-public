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
  // Docker may give Next an internal address. Match the configured public
  // origin, including the two loopback names for a local-only deployment.
  try {
    const configured = new URL(configuredBaseUrl);
    if (parsed.origin === configured.origin) return true;
    const loopback = ['127.0.0.1', 'localhost'];
    return loopback.includes(configured.hostname) && loopback.includes(parsed.hostname)
      && parsed.protocol === configured.protocol && parsed.port === configured.port;
  }
  catch { return false; }
}
