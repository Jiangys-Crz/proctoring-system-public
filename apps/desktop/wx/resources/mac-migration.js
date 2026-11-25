(() => {
  'use strict';
  if (window !== window.top || location.href !== window.__proctorShellOrigin + '/mac-migration.html') return;
  const transport = window.chrome.webview;
  const acknowledge = (migration, fields = {}) => transport.postMessage({ migration, ...fields });
  let progressKey;
  let progress;
  let current;
  let waiting = false;
  let complete = true;

  function preferences(values) {
    if (!values) return;
    const marker = 'proctorMacLegacyPreferencesV1';
    if (localStorage.getItem(marker) === '1') return;
    for (const key of ['proctorServerUrl', 'monitorPreviewPosition', 'monitorPreviewRestoreTop']) {
      const value = values?.[key];
      if (typeof value === 'string' && value.length <= 2048 && localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
      }
    }
    localStorage.setItem(marker, '1');
  }

  function openQueue() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('cwnupaa-proctor-offline', 3);
      request.onupgradeneeded = () => {
        for (const name of ['uploads', 'alerts']) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
        }
        if (!request.result.objectStoreNames.contains('migration-receipts')) {
          request.result.createObjectStore('migration-receipts');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => reject(new Error('offline storage unavailable'));
    });
  }

  function validateRecord({ store, record, size }) {
    if (!['uploads', 'alerts'].includes(store) || !record || typeof record.id !== 'string' ||
        !record.id.length || record.id.length > 4096 || typeof record.sessionToken !== 'string' ||
        !record.sessionToken.length || record.sessionToken.length > 8192 || /[\r\n]/.test(record.sessionToken)) {
      throw new Error('invalid offline record');
    }
    if (record.serverUrl) {
      const origin = new URL(record.serverUrl);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.hash || origin.search) {
        throw new Error('invalid offline server');
      }
    } else if (store !== 'uploads') throw new Error('missing offline server');
    const session = store === 'uploads' ? record.fields?.sessionId : record.payload?.sessionId;
    if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,191}$/.test(session)) throw new Error('invalid offline session');
    if (store === 'uploads') {
      if (typeof record.filename !== 'string' || !record.filename.length || record.filename.length > 1024 ||
          !Number.isFinite(record.createdAt) || size === 0) throw new Error('invalid recording');
    } else if (size || typeof record.payload?.eventId !== 'string' || !record.payload.eventId.length ||
               record.payload.eventId.length > 256) throw new Error('invalid offline alert');
  }

  async function saveRecord(work) {
    const { store, record, type, chunks } = work;
    validateRecord(work);
    if (store === 'uploads') record.blob = new Blob(chunks, { type });
    const db = await openQueue();
    try {
      await new Promise((resolve, reject) => {
        let transaction;
        try { transaction = db.transaction([store, 'migration-receipts'], 'readwrite', { durability: 'strict' }); }
        catch { transaction = db.transaction([store, 'migration-receipts'], 'readwrite'); }
        const target = transaction.objectStore(store);
        const existing = target.getKey(record.id);
        existing.onsuccess = () => {
          if (existing.result === undefined) target.add(record);
        };
        transaction.objectStore('migration-receipts').put(true, [store, record.id]);
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }

  async function hasReceipt({ store, record }) {
    const db = await openQueue();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('migration-receipts').objectStore('migration-receipts').get([store, record.id]);
        request.onsuccess = () => resolve(request.result === true);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  function translateUrl(value) {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      const prefix = '/dist/renderer/';
      const position = url.pathname.lastIndexOf(prefix);
      if (url.host || position < 0 || url.search || url.hash) throw new Error('invalid local cache key');
      const path = url.pathname.slice(position + prefix.length);
      if (!/^[A-Za-z0-9_.\/-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('invalid cache path');
      }
      return new URL(path, location.origin + '/');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('invalid cache key');
    }
    return url;
  }

  async function saveCache({ name, url, headers, status, statusText, size, chunks }) {
    if (!window.caches || typeof name !== 'string' || !name.length || name.length > 256 ||
        !Array.isArray(headers) || headers.length > 256 || !Number.isInteger(status) || status < 200 ||
        status > 599 || status === 206 || typeof statusText !== 'string' || statusText.length > 256) {
      throw new Error('invalid cache entry');
    }
    const request = new Request(translateUrl(url));
    const cache = await caches.open(name);
    if (await cache.match(request)) return;
    const responseHeaders = new Headers(headers.filter(pair => !/^set-cookie2?$/i.test(pair[0])));
    const hasNoBody = [204, 205, 304].includes(status);
    if (hasNoBody && size !== 0) throw new Error('unexpected cache body');
    const response = new Response(hasNoBody ? null : new Blob(chunks), { headers: responseHeaders, status, statusText });
    await cache.put(request, response);
  }

  async function handle(message) {
    const kind = message?.migration;
    if (kind === 'initialize') {
      if (progressKey || typeof message.id !== 'string' || !/^[a-f0-9]{64}$/.test(message.id)) throw new Error('invalid migration');
      progressKey = 'proctorMacLegacyProgressV1:' + message.id;
      preferences(message.preferences);
      progress = Number(localStorage.getItem(progressKey)) || 0;
      if (!Number.isSafeInteger(progress) || progress < 0) throw new Error('invalid migration progress');
      complete = localStorage.getItem(progressKey + ':partial') !== '1';
      acknowledge('initialized', { progress, complete });
    } else if (kind === 'entry') {
      if (!progressKey || current || waiting || message.index !== progress || !['record', 'cache'].includes(message.kind) ||
          !Number.isSafeInteger(message.size) || message.size < 0 || message.size > 512 * 1024 * 1024) {
        throw new Error('invalid migration entry');
      }
      if (message.kind === 'record') {
        try { validateRecord(message); }
        catch {
          complete = false;
          localStorage.setItem(progressKey + ':partial', '1');
          localStorage.setItem(progressKey, String(++progress));
          acknowledge('unsupported', { progress });
          return;
        }
        waiting = true;
        const migrated = await hasReceipt(message);
        waiting = false;
        if (migrated) {
          localStorage.setItem(progressKey, String(++progress));
          acknowledge('skipped', { progress });
          return;
        }
      }
      current = { ...message, chunks: [], received: 0 };
      acknowledge('continue');
    } else if (kind === 'chunk') {
      if (!current || typeof message.bytes !== 'string' || message.bytes.length > 350000) throw new Error('invalid migration chunk');
      const chunk = Uint8Array.from(atob(message.bytes), byte => byte.charCodeAt(0));
      current.received += chunk.byteLength;
      if (current.received > current.size) throw new Error('oversized migration chunk');
      current.chunks.push(chunk);
      acknowledge('continue');
    } else if (kind === 'commit') {
      if (!current || current.received !== current.size || waiting) throw new Error('incomplete migration entry');
      const work = current;
      current = null;
      waiting = true;
      if (work.kind === 'record') await saveRecord(work);
      else await saveCache(work);
      localStorage.setItem(progressKey, String(++progress));
      waiting = false;
      acknowledge('committed', { progress });
    }
  }

  transport.addEventListener('message', ({ data }) => {
    void handle(data).catch(() => acknowledge('failed'));
  });
  function ready() { acknowledge('ready'); }
  // Defer until WKWebView has committed this top-level document.
  if (document.readyState === 'complete') setTimeout(ready, 0);
  else window.addEventListener('load', ready, { once: true });
})();
