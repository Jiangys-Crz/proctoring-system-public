// Chromium creates a separate MIME-handler WebContents for a PDF stream.
// The exam webview itself must never navigate to chrome:// or an extension.
const pdfExtension = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
export function chromiumPdfViewerResource(value: string, type: string, remoteDocument: string | undefined) {
  const viewer = pdfExtension + 'index.html';
  if (remoteDocument === undefined) return false;
  if (type === 'mainFrame') return value === viewer && (remoteDocument === '' || remoteDocument === viewer);
  return remoteDocument === viewer && type !== 'subFrame'
    && (value.startsWith(pdfExtension) || value.startsWith('chrome://resources/'));
}

/** Only the student application's pages, compiled static files and client APIs
 * belong to the embedded contest browser. Never permit static files as frames. */
export function contestPageRequestAllowed(value: string, resourceType: string, origin: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== origin) return false;
  const frame = resourceType === 'mainFrame' || resourceType === 'subFrame';
  const request = resourceType === 'xhr' || resourceType === 'fetch' || resourceType === 'other';
  const contest = url.pathname === '/contest' || url.pathname.startsWith('/contest/');
  if (frame) return contest;
  if (contest && request) return true;
  if (url.pathname.startsWith('/api/client/') && request) return true;
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/candidate-assets/_next/static/')) return true;
  return resourceType === 'image' && ['/brand/logo.png', '/candidate-assets/brand/logo.png'].includes(url.pathname);
}
