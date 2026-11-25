(() => {
  'use strict';
  if (window !== window.top || location.href !== PROCTOR_LEGACY_SOURCE_URL) return;
  const transport = window.chrome.webview;
  const post = (kind, data) => transport.postMessage({ migration: kind, ...data });
  const prefs = Object.create(null);
  if (PROCTOR_LEGACY_READ_PREFERENCES) {
    let read = true;
    try {
      for (const key of ['proctorServerUrl', 'monitorPreviewPosition', 'monitorPreviewRestoreTop']) {
        const value = localStorage.getItem(key);
        if (value && value.length <= 2048) prefs[key] = value;
      }
    } catch { read = false; }
    post('preferences', { values: prefs, read });
  }

  const databaseName = 'cwnupaa-proctor-offline';
  let database;
  function openExisting() {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      // Chromium must find the old database under the staged file:// origin.
      // Treat a fresh empty database as an import failure and leave it unused.
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('offline storage busy'));
    });
    return database;
  }
  let active = null;
  let requestSerial = 0;
  let generation = 0;
  const evidence = (kind, data) => post(kind, { ...data, generation });

  async function read(storeName, after) {
    const db = await openExisting();
    if (!db.objectStoreNames.contains(storeName)) return null;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const range = typeof after === 'string' ? IDBKeyRange.lowerBound(after, true) : undefined;
      const request = transaction.objectStore(storeName).openCursor(range);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function next({ store, after }, serial) {
    if (!['uploads', 'alerts'].includes(store)) return;
    const item = await read(store, after);
    if (serial !== requestSerial) return;
    if (!item) { evidence('store-complete', { store }); return; }
    const blob = item.blob instanceof Blob ? item.blob : null;
    const { blob: _blob, ...record } = item;
    active = { store, record, blob, offset: 0 };
    evidence('entry', { store, record, size: blob?.size || 0, type: blob?.type || '' });
  }

  async function chunk() {
    if (!active) return;
    const current = active;
    if (!current.blob || current.offset >= current.blob.size) {
      active = null;
      evidence('commit');
      return;
    }
    const buffer = new Uint8Array(await current.blob.slice(current.offset, current.offset + 256 * 1024).arrayBuffer());
    if (current !== active) return;
    current.offset += buffer.byteLength;
    let binary = '';
    for (let i = 0; i < buffer.length; i += 8192) binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
    evidence('chunk', { bytes: btoa(binary) });
  }

  transport.addEventListener('message', ({ data }) => {
    let request;
    if (data?.migration === 'next') {
      generation = data.generation;
      active = null;
      request = next(data, ++requestSerial);
    } else if (data?.migration === 'continue' && data.generation === generation) request = chunk();
    const serial = requestSerial;
    if (request) void request.catch(() => { if (serial === requestSerial) evidence('failed'); });
  });
})();
