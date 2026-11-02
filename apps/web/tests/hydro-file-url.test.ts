import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizedHydroFileUrl, fetchHydroFile } from '../src/lib/hydro-file-url';

test('Hydro file URLs use the configured origin or an explicit complete origin allowlist', () => {
  const base = 'https://hydro.example.test';
  assert.equal(authorizedHydroFileUrl('/file/id?signature=value', base, '').href, `${base}/file/id?signature=value`);
  assert.equal(authorizedHydroFileUrl('https://cdn.example.test/file', base, 'https://cdn.example.test').origin, 'https://cdn.example.test');
  for (const value of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:4031/api/settings', 'https://elsewhere.example.test/f', 'https://hydro.example.test.evil.test/f', 'file:///etc/passwd', 'https://user:pass@hydro.example.test/f']) assert.throws(() => authorizedHydroFileUrl(value, base, ''), /允许|地址/);
  for (const allow of ['https://cdn.example.test/path', 'https://user:pass@cdn.example.test', 'https://cdn.example.test?', 'https://cdn.example.test#', 'file:///tmp']) assert.throws(() => authorizedHydroFileUrl('/f', base, allow));
  assert.equal(authorizedHydroFileUrl('/file', 'http://hydro:8888', '').origin, 'http://hydro:8888'); // An intentional internal Hydro service is allowed.
});

test('signed downloads never forward credentials or follow origin-changing redirects', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.equal([...new Headers(init?.headers)].length, 0);
    throw new TypeError('redirect rejected');
  };
  try { await assert.rejects(fetchHydroFile('/file', 'https://hydro.example.test'), /redirect rejected/); }
  finally { globalThis.fetch = original; }
});
