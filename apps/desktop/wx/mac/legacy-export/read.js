(() => {
  'use strict';

  let database, activeBlob;
  let cacheRequests;
  const stores = ['uploads', 'alerts'];
  const prefs = ['proctorServerUrl', 'monitorPreviewPosition', 'monitorPreviewRestoreTop'];

  function openExisting() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('cwnupaa-proctor-offline');
      let created = false;
      request.onupgradeneeded = event => {
        created = event.oldVersion === 0;
        request.transaction.abort();
      };
      request.onerror = () => created ? resolve(null) : reject(new Error('offline database'));
      request.onsuccess = () => resolve(request.result);
      request.onblocked = () => reject(new Error('offline database busy'));
    });
  }

  async function nextRecord(store, after) {
    if (!stores.includes(store)) throw new Error('unknown store');
    if (database === undefined) database = await openExisting();
    if (!database?.objectStoreNames.contains(store)) return { entry: null, skipped: false };
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(store, 'readonly');
      const range = typeof after === 'string' ? IDBKeyRange.lowerBound(after, true) : undefined;
      const request = transaction.objectStore(store).openCursor(range);
      let entry = null, skipped = false;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          const { blob, ...record } = cursor.value;
          if (typeof cursor.primaryKey !== 'string' || record.id !== cursor.primaryKey || (store === 'uploads' && !(blob instanceof Blob))) {
            throw new Error('offline record format');
          }
          activeBlob = blob instanceof Blob ? blob : null;
          entry = {
            record: JSON.parse(JSON.stringify(record)),
            size: activeBlob?.size || 0,
            type: activeBlob?.type || ''
          };
        } catch {
          skipped = true;
          cursor.continue();
        }
      };
      transaction.oncomplete = () => resolve({ entry, skipped });
      transaction.onerror = transaction.onabort = () => reject(new Error('offline record'));
    });
  }

  async function nextCache() {
    if (cacheRequests === undefined) {
      cacheRequests = [];
      if (typeof caches === 'undefined') return null;
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (request.method === 'GET') cacheRequests.push({ name, cache, request });
        }
      }
    }
    while (cacheRequests.length > 0) {
      const { name, cache, request } = cacheRequests.shift();
      const result = await cache.match(request);
      // Opaque responses and network redirects are not transferable through
      // the Cache API without changing which origin owns their pixels/bytes.
      if (!result || result.type === 'opaque' || result.type === 'opaqueredirect' || result.redirected) continue;
      activeBlob = await result.blob();
      return {
        name, url: request.url, status: result.status, statusText: result.statusText,
        headers: Array.from(result.headers.entries()), size: activeBlob.size
      };
    }
    return null;
  }

  async function chunk(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !activeBlob) throw new Error('invalid read offset');
    const bytes = new Uint8Array(await activeBlob.slice(offset, offset + 256 * 1024).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  }

  function preferences() {
    const result = Object.create(null);
    for (const key of prefs) {
      const value = localStorage.getItem(key);
      if (typeof value === 'string' && value.length <= 2048) result[key] = value;
    }
    return result;
  }

  Object.defineProperty(window, '__proctorLegacyRead', {
    value: Object.freeze({ nextRecord, nextCache, chunk, preferences })
  });
})();
