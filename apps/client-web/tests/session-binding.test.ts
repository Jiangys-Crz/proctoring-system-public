import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClientApi, ClientApiError, isExpiredClientSessionError, restoreBoundSession, trustedApiBase } from '../src/lib/api';

function atPage(url: string, run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: new URL(url) } });
  try { run(); } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
}

test('URL/QR apiBase cannot add an attacker service but LAN and HTTPS routing remain available', () => {
  atPage('http://192.168.50.30:4032', () => {
    assert.equal(trustedApiBase('', 'http://192.168.50.30:4031/'), 'http://192.168.50.30:4031');
    for (const base of ['https://attacker.example.test', 'http://192.168.50.30:5000', 'http://user:pass@192.168.50.30:4031', 'http://192.168.50.30:4031/other', 'javascript:alert(1)']) assert.throws(() => trustedApiBase('', base), /地址|平台/);
    assert.equal(trustedApiBase('https://api.example.test/base', 'https://api.example.test/base/'), 'https://api.example.test/base');
  });
  atPage('https://192.168.50.30:3443', () => assert.equal(trustedApiBase('', 'http://localhost:4031'), 'https://192.168.50.30:3443'));
});

test('a cached token is restored only for its original API base and stale request state is cleared', () => {
  const data = new Map([['proctor.client.apiBase', 'https://api.example.test'], ['proctor.client.sessionId', 'session'], ['proctor.client.sessionToken', 'local-test-token'], ['proctor.client.loginRequestId', 'request']]);
  const storage = { getItem: (key: string) => data.get(key) || null, removeItem: (key: string) => { data.delete(key); } };
  assert.deepEqual(restoreBoundSession(storage, 'proctor.client', 'https://api.example.test'), { id: 'session', token: 'local-test-token' });
  assert.deepEqual(restoreBoundSession(storage, 'proctor.client', 'https://other.example.test'), { id: '', token: '' });
  assert.equal(data.has('proctor.client.sessionToken'), false);
  assert.equal(data.has('proctor.client.loginRequestId'), false);
});

test('material upload sends its ticket header and authenticated requests cannot follow redirects', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-proctor-session-token'), 'local-test-session');
    if (init?.body instanceof FormData) { assert.equal(headers.get('x-proctor-upload-ticket'), 'local-test-upload'); assert.equal(init.body.get('uploadTicket'), 'local-test-upload'); }
    return Response.json({ ok: true, data: { id: 'test' } });
  };
  try {
    const api = new ClientApi('https://api.example.test', 'local-test-session');
    await api.upload('/api/client/upload', new Blob(['local fixture']), 'test.txt', { uploadTicket: 'local-test-upload' }, { 'x-proctor-upload-ticket': 'local-test-upload' });
    await api.download('/api/client/contest/file');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
  assert.equal(isExpiredClientSessionError(new ClientApiError('revoked', 410)), true);
  assert.equal(isExpiredClientSessionError(new ClientApiError('forbidden', 403)), false);
});
