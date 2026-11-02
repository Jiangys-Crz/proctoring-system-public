export function contestDownloadAllowed(source: string, urls: string[], origin: string, embedded: boolean) {
  if (!embedded || !urls.length) return false;
  try {
    const page = new URL(source);
    if (page.origin !== origin || !(page.pathname === '/contest' || page.pathname.startsWith('/contest/'))) return false;
    return urls.every(value => { const url = new URL(value); return url.protocol === 'blob:' && url.origin === origin; });
  } catch { return false; }
}

export function contestDownloadFilename(value: string) {
  return value.split(/[/\\]/).pop()?.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 200) || '题目附件';
}
