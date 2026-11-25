(() => {
  'use strict';
  if (window !== window.top || location.href !== 'https://proctor-client.invalid/index.html') return;
  const transport = window.chrome.webview;
  const documentId = crypto.randomUUID();
  const post = (kind, data) => transport.postMessage({ migration: kind, document: documentId, ...data });
  const preferenceMarker = 'proctorLegacyPreferencesV1';
  try {
    if (PROCTOR_LEGACY_PREFERENCES && localStorage.getItem(preferenceMarker) === null) {
      for (const [key, value] of Object.entries(PROCTOR_LEGACY_PREFERENCES)) {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
      localStorage.setItem(preferenceMarker, '1');
    }
    post('preferences-applied');
  } catch { /* The existing client handles unavailable local storage. */ }
  if (!PROCTOR_LEGACY_EVIDENCE) return;

  let current = null;
  const databaseName = 'cwnupaa-proctor-offline';
  const storeNames = ['uploads', 'alerts'];
  const evidenceMarker = 'proctorLegacyEvidenceV1';
  const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  function validEntry(message) {
    const { record, store, size, type } = message;
    if (!storeNames.includes(store) || !record || !isText(record.id, 4096) ||
        !isText(record.sessionToken, 8192) || /[\r\n]/.test(record.sessionToken) ||
        !Number.isSafeInteger(size) || size < 0 || typeof type !== 'string' || type.length > 256) return false;
    try {
      if (record.serverUrl) {
        if (!isText(record.serverUrl, 2048)) return false;
        const address = new URL(record.serverUrl);
        if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password ||
            address.hash || address.search) return false;
      } else if (store !== 'uploads') return false;
    } catch { return false; }
    const session = store === 'uploads' ? record.fields?.sessionId : record.payload?.sessionId;
    if (!isText(session, 191) || !/^[A-Za-z0-9_-]+$/.test(session)) return false;
    return store === 'uploads' ? isText(record.filename, 1024) && Number.isFinite(record.createdAt) && size > 0
      : isText(record.payload?.eventId, 256) && size === 0;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 3);
      request.onupgradeneeded = () => {
        for (const name of storeNames) if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: 'id' });
        }
        if (!request.result.objectStoreNames.contains('migration-receipts')) request.result.createObjectStore('migration-receipts');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('offline storage busy'));
    });
  }

  async function hasReceipt({ store, record }) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const operation = db.transaction('migration-receipts').objectStore('migration-receipts').get([store, record.id]);
        operation.onsuccess = () => resolve(operation.result === true);
        operation.onerror = () => reject(operation.error);
      });
    } finally { db.close(); }
  }

  async function write({ store, record, size, type, bytes, chunks }) {
    if (bytes !== size) throw new Error('incomplete legacy evidence');
    const db = await openDatabase();
    try {
      if (store === 'uploads') record.blob = new Blob(chunks, { type });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction([store, 'migration-receipts'], 'readwrite', { durability: 'strict' });
        const target = transaction.objectStore(store);
        const receipts = transaction.objectStore('migration-receipts');
        const receipt = receipts.get([store, record.id]);
        receipt.onsuccess = () => {
          if (receipt.result === true) return;
          const existing = target.getKey(record.id);
          existing.onsuccess = () => {
            // A record already sent by the new client can be gone by retry time.
            // Keep a durable receipt in the same transaction as its import.
            if (existing.result === undefined) target.add(record);
            receipts.put(true, [store, record.id]);
          };
        };
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }

  const idbProgress = 'proctorLegacyEvidenceV1:';
  const resume = {};
  for (const store of storeNames) {
    try { resume[store] = localStorage.getItem(idbProgress + store); } catch {}
  }

  async function receive(data) {
    if (data?.document !== documentId) return;
    if (data.migration === 'entry') {
      current = null;
      if (!validEntry(data)) { post('skipped'); return; }
      if (await hasReceipt(data)) { post('duplicate'); return; }
      current = { ...data, chunks: [], bytes: 0 };
      post('continue');
    } else if (data?.migration === 'chunk') {
      if (!current || typeof data.bytes !== 'string' || data.bytes.length > 350000) throw new Error('invalid legacy evidence chunk');
      const bytes = Uint8Array.from(atob(data.bytes), char => char.charCodeAt(0));
      current.bytes += bytes.byteLength;
      if (current.bytes > current.size) throw new Error('oversized legacy evidence');
      current.chunks.push(bytes);
      post('continue');
    } else if (data?.migration === 'commit') {
      if (!current) throw new Error('missing legacy evidence');
      const work = current;
      current = null;
      await write(work);
      try { localStorage.setItem(idbProgress + work.store, work.record.id); } catch {}
      post('committed');
    } else if (data?.migration === 'complete') {
      try {
        localStorage.setItem(evidenceMarker, '1');
        for (const store of storeNames) localStorage.removeItem(idbProgress + store);
        post('evidence-applied');
      } catch {}
    }
  }
  transport.addEventListener('message', ({ data }) => {
    void receive(data).catch(() => { current = null; post('failed'); });
  });
  try {
    if (localStorage.getItem(evidenceMarker) === '1') { post('already-complete'); return; }
  } catch {}
  post('ready', { resume });
})();
