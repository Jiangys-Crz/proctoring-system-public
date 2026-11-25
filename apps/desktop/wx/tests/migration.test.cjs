const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourceUrl = 'file:///C:/proctor/migration.html';
const targetUrl = 'https://proctor-client.invalid/index.html';
const asset = name => fs.readFileSync(path.join(__dirname, '../resources', name), 'utf8');

function browser({ url, script, preferences = {}, rows = {}, sender, main = true }) {
  const listeners = [];
  const storage = new Map(Object.entries(preferences));
  const stores = Object.fromEntries(['uploads', 'alerts'].map(name => [name, new Map((rows[name] || []).map(row => [row.id, row]))]));
  stores['migration-receipts'] = new Map();
  const database = {
    close() {},
    objectStoreNames: { contains: name => Boolean(stores[name]) },
    transaction(name, mode) {
      let pending = 0;
      function getResult(result) {
        const request = { result };
        pending += 1;
        queueMicrotask(() => {
          request.onsuccess?.();
          pending -= 1;
          if (!pending && mode === 'readwrite') transaction.oncomplete();
        });
        return request;
      }
      const transaction = {
        objectStore(storeName) {
          const rows = stores[storeName || name];
          return {
            openCursor(after) {
              const id = [...rows.keys()].sort().find(key => after === undefined || key > after);
              const request = { result: id ? { value: rows.get(id) } : null };
              queueMicrotask(() => request.onsuccess());
              return request;
            },
            getKey(id) { return getResult(rows.has(id) ? id : undefined); },
            get(id) { return getResult(rows.get(JSON.stringify(id))); },
            put(value, id) { rows.set(JSON.stringify(id), value); },
            add(row) { rows.set(row.id, row); }
          };
        }
      };
      return transaction;
    }
  };
  const window = {
    chrome: { webview: {
      addEventListener(_event, callback) { listeners.push(callback); },
      postMessage(data) { queueMicrotask(() => sender(structuredClone(data))); }
    } }
  };
  window.top = main ? window : {};
  vm.runInNewContext(script, {
    window,
    location: new URL(url),
    atob,
    btoa,
    Blob,
    URL,
    Uint8Array,
    crypto,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    indexedDB: { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess());
      return request;
    } },
    IDBKeyRange: { lowerBound(value) { return value; } }
  });
  return { send: data => listeners.forEach(listener => listener({ data })), storage, stores };
}

const sourceScript = `const PROCTOR_LEGACY_SOURCE_URL = ${JSON.stringify(sourceUrl)};\nconst PROCTOR_LEGACY_READ_PREFERENCES = true;\n${asset('migration-source.js')}`;
const targetScript = ({ prefs = {}, evidence = true } = {}) => `const PROCTOR_LEGACY_PREFERENCES = ${JSON.stringify(prefs)};\nconst PROCTOR_LEGACY_EVIDENCE = ${evidence};\n${asset('migration-client.js')}`;

test('migration scripts ignore unexpected documents and frames', async () => {
  const messages = [];
  const sender = value => messages.push(value);
  browser({ url: sourceUrl + '?remote', script: sourceScript, sender });
  browser({ url: sourceUrl, script: sourceScript, sender, main: false });
  browser({ url: 'https://other.invalid/index.html', script: targetScript(), sender });
  browser({ url: targetUrl, script: targetScript(), sender, main: false });
  await Promise.resolve();
  assert.deepEqual(messages, []);
});

test('migration keeps current preferences and queued work, replays same-origin evidence in committed chunks', async () => {
  const serverUrl = 'https://legacy-test.invalid/path';
  const sessionToken = 'synthetic-not-used-for-login';
  const video = Uint8Array.from({ length: 3 * 256 * 1024 + 17 }, (_, index) => index % 251);
  const videoRow = {
    id: 'v2', serverUrl, sessionToken, filename: 'screen.webm', createdAt: 100,
    fields: { sessionId: 'test-session', uploadId: 'test-upload' }, blob: new Blob([video], { type: 'video/webm' })
  };
  const alert = { id: 'a1', serverUrl, sessionToken, payload: { sessionId: 'test-session', eventId: 'test-event' } };
  const fresh = { id: 'v1', filename: 'newer-version.webm' };
  let document, store, after, sourcePrefs;
  let skipped = 0;
  const generation = 1;
  const next = () => source.send({ migration: 'next', generation, store, after });
  const completion = Promise.withResolvers();
  const source = browser({ url: sourceUrl, script: sourceScript,
    rows: { uploads: [{ ...videoRow, id: 'v0', serverUrl: 'https://user:password@wrong.invalid' }, { ...videoRow, id: 'v1' }, videoRow], alerts: [alert] },
    preferences: { monitorPreviewPosition: '{"left":9,"top":10}', monitorPreviewRestoreTop: '96', proctorServerUrl: serverUrl, secret: 'excluded' },
    sender(data) {
      const kind = data.migration;
      if (kind === 'preferences') { sourcePrefs = data.values; return; }
      assert.equal(data.generation, generation);
      if (kind === 'store-complete') {
        if (store === 'uploads') { store = 'alerts'; after = undefined; next(); }
        else target.send({ migration: 'complete', document });
      } else {
        if (kind === 'entry') after = data.record.id;
        target.send({ ...data, document });
      }
    }
  });
  await Promise.resolve();
  assert.deepEqual(sourcePrefs, { monitorPreviewPosition: '{"left":9,"top":10}', monitorPreviewRestoreTop: '96', proctorServerUrl: serverUrl });
  const target = browser({
    url: targetUrl, script: targetScript({ prefs: sourcePrefs }),
    rows: { uploads: [fresh] },
    preferences: { monitorPreviewPosition: '{"left":42,"top":1}' },
    sender(data) {
      switch (data.migration) {
        case 'preferences-applied': break;
        case 'ready':
          document = data.document; store = 'uploads'; next();
          target.send({ migration: 'entry', document: 'outdated-document', store, record: videoRow });
          break;
        case 'continue': source.send({ migration: 'continue', generation }); break;
        case 'committed': next(); break;
        case 'skipped': ++skipped; next(); break;
        case 'evidence-applied': completion.resolve(); break;
        default: completion.reject(new Error(`unexpected message: ${data.migration}`));
      }
    }
  });
  await completion.promise;
  assert.equal(skipped, 1);
  assert.equal(target.storage.get('monitorPreviewPosition'), '{"left":42,"top":1}');
  assert.equal(target.storage.get('monitorPreviewRestoreTop'), '96');
  assert.equal(target.storage.get('proctorServerUrl'), serverUrl);
  assert.equal(target.storage.get('secret'), undefined);
  assert.equal(target.storage.get('proctorLegacyEvidenceV1'), '1');
  assert.deepEqual([...target.stores.uploads.keys()], ['v1', 'v2']);
  assert.deepEqual(target.stores.uploads.get('v1'), fresh);
  const addedVideo = target.stores.uploads.get('v2');
  assert.equal(addedVideo.blob.type, 'video/webm');
  assert.deepEqual(new Uint8Array(await addedVideo.blob.arrayBuffer()), video);
  assert.equal(addedVideo.serverUrl, serverUrl);
  assert.deepEqual(target.stores.alerts.get('a1'), alert);
  assert.deepEqual([...source.stores.uploads.keys()], ['v0', 'v1', 'v2']);
  assert.deepEqual([...source.stores.alerts.keys()], ['a1']);
});

test('completed migration does not overwrite a deliberate preference deletion or replay evidence', async () => {
  const messages = [];
  const state = browser({ url: targetUrl, script: targetScript({ prefs: { proctorServerUrl: sourceUrl } }),
    preferences: { proctorLegacyPreferencesV1: '1', proctorLegacyEvidenceV1: '1' }, sender: data => messages.push(data.migration) });
  await Promise.resolve();
  assert.deepEqual(messages, ['preferences-applied', 'already-complete']);
  assert.equal(state.storage.get('proctorServerUrl'), undefined);
});
