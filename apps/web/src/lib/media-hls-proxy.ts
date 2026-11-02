/** MediaMTX negotiates an HLS session with a redirect on the first asset read.
 * Keep its credentials on the configured upstream and this one stream only. */
export async function fetchHlsAsset(target: URL, streamPath: string, headers: Headers, signal: AbortSignal) {
  let url = target;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(url, { headers, cache: 'no-store', redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('直播媒体地址无效');
    const next = new URL(location, url);
    if (next.origin !== target.origin || !next.pathname.startsWith(streamPath + '/') || next.username || next.password || next.hash) throw new Error('直播媒体地址无效');
    url = next;
  }
  throw new Error('直播媒体连接重定向过多');
}

export function copyHlsQuery(incoming: URL, target: URL) {
  for (const key of ['_HLS_msn', '_HLS_part', '_HLS_skip', 'session']) {
    const value = incoming.searchParams.get(key);
    if (value && /^[A-Za-z0-9_-]{1,128}$/.test(value)) target.searchParams.set(key, value);
  }
}
