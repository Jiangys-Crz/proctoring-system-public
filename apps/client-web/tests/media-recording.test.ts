import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { startSegmentRecorder, type RecordedClip } from '../src/lib/segment-recorder';
import { queueMediaUpload, queuedMediaToken } from '../src/lib/offline-media';
import { publishWhip } from '../src/lib/whip';
import { acquireCaptureLock } from '../src/lib/capture-lock';

const originalRecorder = globalThis.MediaRecorder;
const originalIndexedDB = globalThis.indexedDB;
const originalPeer = globalThis.RTCPeerConnection;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.MediaRecorder = originalRecorder;
  globalThis.indexedDB = originalIndexedDB;
  globalThis.RTCPeerConnection = originalPeer;
  globalThis.fetch = originalFetch;
});

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state = 'inactive';
  mimeType = 'video/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: MediaStream, public options: MediaRecorderOptions) { FakeRecorder.instances.push(this); }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; }
  finish(value: string) {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([value]) });
    this.onstop?.();
  }
}

const stream = { getVideoTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream;

test('late old-generation stop keeps independent bytes and cannot restart the old recorder', async () => {
  globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
  FakeRecorder.instances = [];
  let generation = 1;
  const clips: RecordedClip[] = [];
  const start = (current: number) => startSegmentRecorder({
    stream, mimeType: 'video/webm', isCurrent: () => generation === current,
    onClip: clip => { clips.push(clip); }, onError: error => { throw error; }
  });
  const stopOld = start(1);
  const old = FakeRecorder.instances[0];
  assert.deepEqual(old.options, { mimeType: 'video/webm', videoBitsPerSecond: 600_000, audioBitsPerSecond: 32_000 });
  old.ondataavailable?.({ data: new Blob(['old-']) });
  generation = 2;
  stopOld();
  const stopNew = start(2);
  const current = FakeRecorder.instances[1];
  current.ondataavailable?.({ data: new Blob(['new-']) });
  old.finish('final');
  old.onstop?.(); // Duplicate callbacks must not upload twice.
  assert.equal(FakeRecorder.instances.length, 2);
  const stoppedNew = stopNew();
  current.finish('final');
  await Promise.all([stopOld(), stoppedNew]);
  assert.deepEqual(await Promise.all(clips.map(clip => clip.blob.text())), ['old-final', 'new-final']);
  assert.ok(clips.every(clip => Date.parse(clip.endedAt) >= Date.parse(clip.startedAt)));
});

test('recording errors save the final data once without spawning another recorder', async () => {
  globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
  FakeRecorder.instances = [];
  const clips: RecordedClip[] = [];
  let errors = 0;
  const stop = startSegmentRecorder({
    stream, mimeType: 'video/webm', isCurrent: () => true,
    onClip: clip => { clips.push(clip); }, onError: () => { errors += 1; }
  });
  const recorder = FakeRecorder.instances[0];
  recorder.onerror?.();
  recorder.finish('partial-evidence');
  await stop();
  assert.equal(errors, 1);
  assert.equal(FakeRecorder.instances.length, 1);
  assert.equal(await clips[0].blob.text(), 'partial-evidence');
});

test('stopping waits until the final evidence clip is saved', async () => {
  globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
  FakeRecorder.instances = [];
  let commit!: () => void;
  const disk = new Promise<void>(resolve => { commit = resolve; });
  const stop = startSegmentRecorder({ stream, mimeType: 'video/webm', isCurrent: () => true,
    onClip: () => disk, onError: error => { throw error; } });
  const stopped = stop();
  FakeRecorder.instances[0].finish('last evidence');
  let done = false;
  void stopped.then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  commit();
  await stopped;
  assert.equal(done, true);
});

function mockDatabase() {
  let value: unknown;
  const request = { result: 'fixed-clip', onsuccess: null, onerror: null };
  const transaction = {
    oncomplete: null as (() => void) | null,
    onabort: null as (() => void) | null,
    onerror: null as (() => void) | null,
    error: null as Error | null,
    objectStore: () => ({ put: (item: unknown) => { value = item; return request; } })
  };
  const database = { transaction: () => transaction, close: () => {} };
  const open = { result: database, onsuccess: null as (() => void) | null };
  globalThis.indexedDB = { open: () => { queueMicrotask(() => open.onsuccess?.()); return open; } } as unknown as IDBFactory;
  return { transaction, value: () => value };
}

const queuedItem = {
  blob: new Blob(['video']), filename: 'video.webm', fields: { uploadId: 'fixed-clip', sessionId: 'session' },
  token: 'token', apiBase: 'https://exam.example'
};

test('recovered clips use the new token only for the same session and server', () => {
  const item = { ...queuedItem, id: 'fixed-clip', createdAt: Date.now() };
  assert.equal(queuedMediaToken(item, { apiBase: item.apiBase, sessionId: 'session', token: 'renewed' }), 'renewed');
  assert.equal(queuedMediaToken(item, { apiBase: item.apiBase, sessionId: 'different', token: 'renewed' }), 'token');
  assert.equal(queuedMediaToken(item, { apiBase: 'https://another.example', sessionId: 'session', token: 'renewed' }), 'token');
  assert.equal(queuedMediaToken(item, { apiBase: item.apiBase, sessionId: 'session', token: '' }), 'token');
});

test('offline recording resolves only after commit and retains its upload identity', async () => {
  const database = mockDatabase();
  let settled = false;
  const pending = queueMediaUpload(queuedItem).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal((database.value() as { id: string }).id, 'fixed-clip');
  database.transaction.oncomplete?.();
  await pending;
  assert.equal(settled, true);
});

test('a rolled-back recording transaction rejects instead of reporting saved evidence', async () => {
  const database = mockDatabase();
  const pending = queueMediaUpload(queuedItem);
  const rejected = assert.rejects(pending, /quota/);
  await new Promise(resolve => setImmediate(resolve));
  database.transaction.error = new Error('quota exceeded');
  database.transaction.onabort?.();
  await rejected;
});

test('WHIP initialization failure closes its peer even before a server resource exists', async () => {
  let closed = 0;
  class FailedPeer {
    getSenders() { return []; }
    close() { closed += 1; }
    addTransceiver() { return {}; }
    addEventListener() {}
    async createOffer() { throw new Error('offer failed'); }
  }
  globalThis.RTCPeerConnection = FailedPeer as unknown as typeof RTCPeerConnection;
  await assert.rejects(publishWhip({ endpoint: 'https://exam.example/whip', stream, token: 'token' }), /offer failed/);
  assert.equal(closed, 1);
});

test('a repeated browser page cannot acquire the camera lock until the owner releases it', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let locked = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
      if (locked) return callback(null);
      locked = true;
      try { await callback({}); } finally { locked = false; }
    } } }
  });
  try {
    const release = await acquireCaptureLock('session');
    assert.equal(typeof release, 'function');
    assert.equal(await acquireCaptureLock('session'), null);
    release?.();
    await new Promise(resolve => setImmediate(resolve));
    const nextRelease = await acquireCaptureLock('session');
    assert.equal(typeof nextRelease, 'function');
    nextRelease?.();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
