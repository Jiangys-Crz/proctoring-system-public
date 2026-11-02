/** A reference window owns one exact address, never an origin-wide browser. */
export function referenceLinkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function referenceNavigationAllowed(value: string, target: string) {
  const url = referenceLinkUrl(value);
  return url !== null && url === target;
}

export function referenceRequestAllowed(value: string, resourceType: string, target: string) {
  if (resourceType === 'subFrame' || resourceType === 'webSocket') return false;
  if (referenceNavigationAllowed(value, target)) return true;
  // Permit assets and data needed to render the document, including CDN assets
  // and dynamic pages. Document navigation remains pinned to the clicked URL.
  return ['stylesheet', 'script', 'image', 'font', 'media', 'xhr', 'fetch'].includes(resourceType) && referenceLinkUrl(value) !== null;
}

export function referenceIsFile(target: string) {
  try {
    const url = new URL(target);
    const name = decodeURIComponent(url.pathname.split('/').pop() || '');
    return (/\.[a-z\d]{1,12}$/i.test(name) && !/\.(?:html?|php|aspx?|jsp)$/i.test(name))
      || /(?:^|\/)(?:file|download)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

export function referenceDownloadAllowed(urls: string[], target: string, downloadOnly: boolean) {
  return urls.length > 0 && referenceNavigationAllowed(urls[0], target)
    && urls.every(url => downloadOnly ? referenceLinkUrl(url) !== null : referenceNavigationAllowed(url, target));
}
