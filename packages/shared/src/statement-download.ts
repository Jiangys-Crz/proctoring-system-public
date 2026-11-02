export type StatementDownload = { name: string; url?: string };

/** Hydro file:// links refer to problem attachments, never the computer's filesystem. */
export function statementDownloadTarget(value: string): StatementDownload | null {
  const href = value.trim();
  if (!href || /[\u0000-\u001f\\]/.test(href) || href.startsWith('#') || href.startsWith('//')) return null;
  const attachment = /^file:\/\//i.test(href);
  const remote = /^https?:\/\//i.test(href);
  if (!attachment && !remote && /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  let pathname: string;
  try { pathname = remote ? new URL(href).pathname : href.replace(/^file:\/\//i, '').split(/[?#]/, 1)[0]; }
  catch { return null; }
  if (attachment && pathname.startsWith('/')) return null;
  let name: string;
  try { name = decodeURIComponent(pathname.split('/').at(-1) || ''); }
  catch { return null; }
  if (!name || /[/\\\u0000-\u001f]/.test(name) || ['.', '..'].includes(name) || name.length > 255) return null;
  if (attachment) return { name };
  const file = /\.[a-z\d]{1,12}$/i.test(name) && !/\.(?:html?|php|aspx?|jsp)$/i.test(name);
  if (!file && !/(?:^|\/)(?:file|download)(?:\/|$)/i.test(pathname)) return null;
  // Hydro's problem-file routes should use the authenticated attachment API.
  if (!remote || /\/p\/[^/]+\/file\//i.test(pathname)) return { name };
  try { const url = new URL(href); if (url.username || url.password) return null; }
  catch { return null; }
  return { name, url: href };
}

export function statementAttachmentHref(value: string, problemId: string) {
  const target = statementDownloadTarget(value);
  return target && !target.url
    ? `/api/problems/${encodeURIComponent(problemId)}/file/${encodeURIComponent(target.name)}?download=1`
    : value;
}
