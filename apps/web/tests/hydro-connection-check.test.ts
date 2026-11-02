import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HydroSettingsSchema } from '../src/lib/settings';
import { checkHydroConnection } from '../src/lib/hydro-connection-check';
import { generateHydroApiKey } from '../src/lib/hydro-api-key';

const settings = HydroSettingsSchema.parse({
  baseUrl: 'https://judge.example.org', apiKey: 'test-key', sharedSecret: 'test-secret',
  problemDomainId: 'Problems', judgeUsername: 'proctor-judge',
});
const remote = { configured: true, problemDomainId: 'Problems', authMode: 'api-key' };

test('backend API keys carry 256 random bits and can be verified by the API-Key bridge', () => {
  const keys = new Set(Array.from({ length: 64 }, () => generateHydroApiKey()));
  assert.equal(keys.size, 64);
  for (const apiKey of keys) assert.match(apiKey, /^[a-f0-9]{64}$/);
});

async function withFetch<T>(implementation: typeof fetch, action: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try { return await action(); } finally { globalThis.fetch = original; }
}

test('legacy settings preserve the compatibility password while client addresses are not configured', () => {
  const parsed = HydroSettingsSchema.parse({ baseUrl: settings.baseUrl, judgePassword: 'legacy-unused', websiteUrl: 'http://legacy.example.org' });
  assert.equal(Object.hasOwn(parsed, 'websiteUrl'), false);
  assert.equal(parsed.judgePassword, 'legacy-unused');
  assert.equal(parsed.problemDomainId, process.env.HYDRO_PROCTOR_PROBLEM_DOMAIN || 'Problems');
});

test('service addresses reject unsupported protocols, embedded credentials and API paths', () => {
  for (const baseUrl of ['ftp://judge.example.org', 'https://user:pass@judge.example.org', 'https://judge.example.org/api', 'https://judge.example.org/?key=x', 'https://judge.example.org?', 'https://judge.example.org#', 'http:judge.example.org', 'https://judge.example.org\\api']) {
    assert.equal(HydroSettingsSchema.safeParse({ ...settings, baseUrl }).success, false);
  }
  assert.equal(HydroSettingsSchema.parse({ ...settings, baseUrl: 'https://JUDGE.example.org/' }).baseUrl, 'https://judge.example.org');
  for (const problemDomainId of ['some/domain', 'two words', 'x'.repeat(101)]) {
    assert.equal(HydroSettingsSchema.safeParse({ ...settings, problemDomainId }).success, false);
  }
});

test('configuration check sends only the entered API key, avoids redirects and creates no judge request', async () => {
  let calls = 0;
  const result = await withFetch(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://judge.example.org/api/proctor/config-check');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, '{}');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-proctor-api-key'), settings.apiKey);
    assert.equal(headers.has('x-proctor-signature'), false);
    assert.equal(headers.has('x-proctor-timestamp'), false);
    return Response.json({ ok: true, data: { ...remote, apiKey: 'never-return-this', sharedSecret: 'never-return-this' } });
  }, () => checkHydroConnection(settings));
  assert.equal(calls, 1);
  assert.equal(result.matched, true);
  assert.equal(result.checks.length, 2);
  assert.ok(!JSON.stringify(result).includes(settings.apiKey));
  assert.ok(!JSON.stringify(result).includes(settings.sharedSecret));
  assert.ok(!JSON.stringify(result).includes('never-return-this'));
});

test('mismatched domain are reported while successful authentication stays distinct', async () => {
  const result = await withFetch(async () => Response.json({ ok: true, data: { ...remote, problemDomainId: 'Other', judgeUsername: 'different-user' } }), () => checkHydroConnection(settings));
  assert.equal(result.matched, false);
  assert.equal(result.checks[0].matched, true);
  assert.equal(result.checks[1].matched, false);
  assert.match(result.checks[1].message, /Other/);
});

test('missing credentials fail before any network request', async () => {
  await withFetch(async () => { throw new Error('must not fetch'); }, async () => {
    await assert.rejects(checkHydroConnection({ ...settings, apiKey: '' }), /先填写/);

  });
});

test('an API key alone works with empty legacy credentials', async () => {
  const result = await withFetch(async () => Response.json({ ok: true, data: remote }),
    () => checkHydroConnection({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, problemDomainId: settings.problemDomainId }));
  assert.equal(result.matched, true);
});

test('authentication errors and missing plugin versions provide actionable messages without remote secret echoes', async () => {
  for (const status of [401, 403]) {
    await withFetch(async () => Response.json({ message: settings.sharedSecret }, { status }), async () => {
      await assert.rejects(checkHydroConnection(settings), error => error instanceof Error && /认证失败/.test(error.message) && !error.message.includes(settings.sharedSecret));
    });
  }
  await withFetch(async () => new Response('', { status: 404 }), async () => {
    await assert.rejects(checkHydroConnection(settings), /更新并启用/);
  });
});

test('network errors, redirect rejection and unexpected responses do not claim a working connection', async () => {
  await withFetch(async () => { throw new Error('redirect or private diagnostics'); }, async () => {
    await assert.rejects(checkHydroConnection(settings), /无法连接/);
  });
  for (const response of [Response.json({ ok: true, data: {} }), Response.json({ ok: false }), new Response('<html>login</html>')]) {
    await withFetch(async () => response, async () => {
      await assert.rejects(checkHydroConnection(settings), /结果无效/);
    });
  }
});


test('old plugin responses produce an upgrade check instead of a malformed-result error or a false success', async () => {
  const old = { configured: true, problemDomainId: 'Problems', judgeUsername: 'legacy-user', ownerUid: 1, sharedSecret: 'do-not-echo' };
  const result = await withFetch(async () => Response.json({ ok: true, data: old }), () => checkHydroConnection(settings));
  assert.equal(result.matched, false);
  assert.equal(result.checks[0].matched, true);
  assert.equal(result.checks[1].matched, true);
  assert.equal(result.checks[2].matched, false);
  assert.match(result.checks[2].message, /旧插件.*启用.*重启/);
  assert.ok(!JSON.stringify(result).includes('do-not-echo'));
});

test('modern nested and flat envelopes identify the loaded plugin and unconfigured plugins do not pass', async () => {
  for (const response of [{ ok: true, data: { ...remote, pluginVersion: '0.2.1' } }, { ok: true, ...remote, pluginVersion: '0.2.1' }]) {
    const result = await withFetch(async () => Response.json(response), () => checkHydroConnection(settings));
    assert.equal(result.matched, true); assert.match(result.checks[2].message, /0.2.1/);
  }
  const result = await withFetch(async () => Response.json({ ok: true, data: { ...remote, configured: false } }), () => checkHydroConnection(settings));
  assert.equal(result.matched, false);
  assert.match(result.checks[2].message, /尚未完成配置/);
});
