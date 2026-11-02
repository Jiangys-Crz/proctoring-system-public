const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const Module = require('node:module');
const crypto = require('node:crypto');

// The integration cases use Hydro's actual setting registry, without starting
// Hydro or connecting to MongoDB. Override this path when testing elsewhere.
const hydroRoot = process.env.HYDRO_SOURCE_ROOT
  ? path.resolve(process.env.HYDRO_SOURCE_ROOT)
  : path.resolve(__dirname, '../../../../Hydro-master');
if (!fs.existsSync(path.join(hydroRoot, 'packages/hydrooj/src/model/setting.ts'))) {
  throw new Error('Set HYDRO_SOURCE_ROOT to a Hydro source checkout with its dependencies installed.');
}
const hydroRequire = createRequire(path.join(hydroRoot, 'package.json'));
hydroRequire('@hydrooj/register');

const {
  DEFAULT_CONFIG,
  DEFAULT_API_KEY,
  DEFAULT_SECRET,
  DEFAULT_RULE_MAPPINGS,
  ProctorConfigError,
  proctorSettingKey,
  proctorSettingsFromForm,
  publicProctorConfig,
  resolveProctorConfig,
} = require('../config.ts');

const legacy = {
  ...DEFAULT_CONFIG,
  apiKey: 'test-only-legacy-key',
  sharedSecret: 'test-only-legacy-secret',
  websiteUrl: 'https://legacy.example.test',
  problemDomainId: 'LegacyProblems',
  judgeAccount: 'legacy-judge',
  judgePassword: 'test-only-legacy-password',
};
const read = (values) => (key) => values[key];
const valuesFor = (values) => Object.fromEntries(
  Object.entries(values).map(([key, value]) => [proctorSettingKey(key), value]),
);
const resolve = (values = {}, old = legacy) => resolveProctorConfig(read(valuesFor(values)), old);

test('absent and null system settings preserve the legacy plugin configuration', () => {
  assert.deepEqual(resolve(), legacy);
  assert.deepEqual(resolve({ apiKey: null, sharedSecret: undefined, problemDomainId: null }), legacy);
  assert.deepEqual(resolve({}, DEFAULT_CONFIG), DEFAULT_CONFIG);
});

test('saved system settings override legacy fields and map the website judge username', () => {
  const result = resolve({
    apiKey: 'test-only-new-key',
    sharedSecret: 'test-only-new-secret',
    problemDomainId: 'SharedProblems',
    judgeUsername: ' current-judge ',
    domainId: 'competition',
    ownerUid: '42',
    ticketTtlSeconds: '300',
    ruleMappings: JSON.stringify([{ hydroRule: ' ICPC ', displayRule: 'acm' }]),
  });
  assert.equal(result.apiKey, 'test-only-new-key');
  assert.equal(result.sharedSecret, 'test-only-new-secret');
  assert.equal(result.websiteUrl, legacy.websiteUrl);
  assert.equal(result.problemDomainId, 'SharedProblems');
  assert.equal(result.judgeAccount, 'current-judge');
  assert.equal(result.domainId, 'competition');
  assert.equal(result.ownerUid, 42);
  assert.equal(result.ticketTtlSeconds, 300);
  assert.deepEqual(result.ruleMappings, [{ hydroRule: 'icpc', displayRule: 'acm' }]);
  assert.equal(result.judgePassword, legacy.judgePassword);
});

test('explicitly stored blank values do not reactivate old credentials', () => {
  const result = resolve({ apiKey: '', sharedSecret: '' });
  assert.equal(result.apiKey, '');
  assert.equal(result.sharedSecret, '');
  assert.equal(publicProctorConfig(result).configured, false);
});

test('each resolution sees changes in Hydro live system cache immediately', () => {
  const cache = valuesFor({ apiKey: 'test-only-first-key', problemDomainId: 'FirstProblems' });
  const get = read(cache);
  assert.equal(resolveProctorConfig(get, legacy).apiKey, 'test-only-first-key');
  cache[proctorSettingKey('apiKey')] = 'test-only-second-key';
  cache[proctorSettingKey('problemDomainId')] = 'SecondProblems';
  const current = resolveProctorConfig(get, legacy);
  assert.equal(current.apiKey, 'test-only-second-key');
  assert.equal(current.problemDomainId, 'SecondProblems');
});

test('blank native secret inputs mean unchanged, while empty rule tables can be saved', () => {
  const updates = proctorSettingsFromForm({
    cwnupaaProctor: { apiKey: '', sharedSecret: '', ruleMappings: '[]', ticketTtlSeconds: '200' },
    unrelated: 'ignored',
  });
  assert.deepEqual(updates, valuesFor({ ruleMappings: '[]', ticketTtlSeconds: '200' }));
  assert.equal(resolveProctorConfig(read(updates), legacy).apiKey, legacy.apiKey);
  const flat = proctorSettingsFromForm(valuesFor({ apiKey: 'test-only-replacement', sharedSecret: '' }));
  assert.deepEqual(flat, valuesFor({ apiKey: 'test-only-replacement' }));
});

test('external redirect prefixes are rejected', () => {
  for (const allowedRedirectPrefix of ['', 'https://example.test/', '//example.test/', '/\\example.test/', '/contest/\0']) {
    assert.throws(() => resolve({ allowedRedirectPrefix }), ProctorConfigError);
  }
  assert.equal(resolve({ allowedRedirectPrefix: '/contest/' }).allowedRedirectPrefix, '/contest/');
});

test('legacy website addresses retain compatibility and obsolete system address settings are ignored', () => {
  for (const websiteUrl of ['candidate.internal', 'https://candidate.example.test/contest']) {
    const old = { ...legacy, websiteUrl };
    assert.equal(resolve({ websiteUrl: 'invalid-system-address', proctorBaseUrl: 'also-obsolete' }, old).websiteUrl, websiteUrl);
  }
});

test('ticket TTL and owner UID enforce integer bounds even when posted as strings', () => {
  for (const ticketTtlSeconds of [0, 4, 3601, 2.5, '', 'NaN', true]) {
    assert.throws(() => resolve({ ticketTtlSeconds }), ProctorConfigError);
  }
  assert.equal(resolve({ ticketTtlSeconds: '5' }).ticketTtlSeconds, 5);
  assert.equal(resolve({ ticketTtlSeconds: 3600 }).ticketTtlSeconds, 3600);
  for (const ownerUid of [0, -1, 2147483648, '1.5', '']) {
    assert.throws(() => resolve({ ownerUid }), ProctorConfigError);
  }
  assert.equal(resolve({ ownerUid: '2147483647' }).ownerUid, 2147483647);
});

test('domains cannot be blank or contain whitespace or path characters', () => {
  for (const key of ['domainId', 'problemDomainId']) {
    for (const value of ['', 'two domains', 'bank/inner', 'bank\\inner', 'bank?x=1', 'bank#part', 'bank\0', 'bank\u0007']) {
      assert.throws(() => resolve({ [key]: value }), ProctorConfigError);
    }
  }
  assert.equal(resolve({ problemDomainId: ' private-bank ' }).problemDomainId, 'private-bank');
});

test('blank service usernames are compatible with API-Key-only judging and existing legacy usernames are preserved', () => {
  assert.equal(resolve({ judgeUsername: '' }).judgeAccount, '');
  assert.equal(resolve({ judgeUsername: '   ' }).judgeAccount, '');
  assert.equal(resolve({}, { ...legacy, judgeAccount: '' }).judgeAccount, '');
});

test('rule mappings accept valid JSON and arrays, and reject malformed or unsafe tables', () => {
  assert.deepEqual(resolve({ ruleMappings: [] }).ruleMappings, []);
  assert.deepEqual(resolve({ ruleMappings: JSON.stringify(DEFAULT_RULE_MAPPINGS) }).ruleMappings, DEFAULT_RULE_MAPPINGS);
  for (const ruleMappings of ['invalid-json', '{}', {}, [{ hydroRule: '', displayRule: 'oi' }], [{ hydroRule: 'icpc', displayRule: 'wrong' }], [{ hydroRule: 'ICPC', displayRule: 'acm' }, { hydroRule: 'icpc', displayRule: 'oi' }], Array.from({ length: 101 }, (_, i) => ({ hydroRule: `rule${i}`, displayRule: 'oi' }))]) {
    assert.throws(() => resolve({ ruleMappings }), ProctorConfigError);
  }
});

test('public configuration checks contain no keys, signing secrets, or legacy passwords', () => {
  const result = publicProctorConfig(resolve());
  assert.deepEqual(Object.keys(result).sort(), ['configured', 'authMode', 'pluginVersion', 'problemDomainId'].sort());
  assert.equal(result.configured, true);
  const serialized = JSON.stringify(result);
  for (const secret of [legacy.apiKey, legacy.sharedSecret, legacy.judgePassword]) assert.ok(!serialized.includes(secret));
  assert.equal(publicProctorConfig(resolve({ apiKey: DEFAULT_API_KEY })).configured, false);
  assert.equal(publicProctorConfig(resolve({ sharedSecret: DEFAULT_SECRET, judgeUsername: '' })).configured, true);
});

global.Hydro = { model: {}, locales: {}, module: {}, script: {} };
const nativeSettings = hydroRequire('./packages/hydrooj/src/model/setting.ts');
const nativeTypes = hydroRequire('@hydrooj/framework/validator').Types;
const systemCache = {};
const modelCalls = [];
class ValidationError extends Error {}
class ForbiddenError extends Error {}
class BadRequestError extends Error {}
class NotFoundError extends Error {}
const sideEffectModel = (name) => new Proxy({}, {
  get: (_target, method) => (...args) => {
    modelCalls.push({ name, method, args });
    if (name === 'domain' && method === 'get') return Promise.resolve({ _id: args[0] });
    throw new Error(`Unexpected model access: ${name}.${String(method)}`);
  },
});
const hydroMock = {
  Context: class {},
  Handler: class {},
  Service: class { constructor(ctx) { this.ctx = ctx; } },
  Schema: hydroRequire('schemastery'),
  SettingModel: nativeSettings,
  SystemModel: { get: (key) => systemCache[key] },
  DomainModel: sideEffectModel('domain'),
  UserModel: sideEffectModel('user'),
  ProblemModel: sideEffectModel('problem'),
  RecordModel: sideEffectModel('record'),
  ContestModel: sideEffectModel('contest'),
  StorageModel: sideEffectModel('storage'),
  db: sideEffectModel('database'),
  PERM: { PERM_ALL: 0n },
  PRIV: { PRIV_NONE: 0 },
  STATUS_TEXTS: {},
  getAlphabeticId: (index) => String.fromCharCode(65 + index),
  param: () => () => undefined,
  Types: nativeTypes,
  ValidationError,
  ForbiddenError,
  BadRequestError,
  NotFoundError,
};
const originalLoad = Module._load;
const yaml = hydroRequire('js-yaml');
let plugin;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'hydrooj') return hydroMock;
    if (request === 'js-yaml') return yaml;
    return originalLoad.call(this, request, parent, isMain);
  };
  plugin = require('../index.ts');
} finally {
  Module._load = originalLoad;
}

function context() {
  const disposers = [];
  const handlers = new Map();
  const routes = new Map();
  const locales = {};
  const errors = [];
  return {
    disposers, handlers, routes, locales, errors,
    i18n: { load: (lang, messages) => { locales[lang] = { ...locales[lang], ...messages }; } },
    effect: (factory) => { disposers.push(factory()); },
    on: (name, callback) => { handlers.set(name, callback); },
    Route: (_name, url, HandlerClass) => { routes.set(url, HandlerClass); },
    logger: { error: (error) => { errors.push(error); } },
    dispose: () => { for (const disposer of disposers.reverse()) if (typeof disposer === 'function') disposer(); },
  };
}

test('real Hydro registration provides native password fields and a Chinese section, and disposes cleanly', () => {
  const ctx = context();
  const before = new Set(nativeSettings.SYSTEM_SETTINGS.map((setting) => setting.key));
  try {
    plugin.registerProctorSystemSettings(ctx, legacy);
    const rows = nativeSettings.SYSTEM_SETTINGS.filter((setting) => setting.key.startsWith('cwnupaaProctor.'));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((setting) => setting.key).sort(), Object.keys(valuesFor({
      apiKey: '', problemDomainId: '',
    })).sort());
    assert.ok(rows.every((setting) => setting.family === 'setting_cwnupaa_proctor'));
    assert.equal(ctx.locales.zh.setting_cwnupaa_proctor, '考试监考平台');
    for (const key of ['apiKey']) {
      const setting = nativeSettings.SYSTEM_SETTINGS_BY_KEY[proctorSettingKey(key)];
      assert.equal(setting.type, 'password');
      assert.ok(setting.flag & nativeSettings.FLAG_SECRET);
      assert.equal(setting.value, '');
      assert.ok(!JSON.stringify(setting).includes(legacy[key]));
    }
    assert.equal(nativeSettings.SYSTEM_SETTINGS_BY_KEY[proctorSettingKey('problemDomainId')].value, legacy.problemDomainId);
    for (const key of ['sharedSecret', 'ownerUid', 'judgeUsername', 'judgePassword']) assert.ok(!nativeSettings.SYSTEM_SETTINGS_BY_KEY[proctorSettingKey(key)]);
    assert.ok(!nativeSettings.SYSTEM_SETTINGS_BY_KEY[proctorSettingKey('websiteUrl')]);
    assert.ok(!nativeSettings.SYSTEM_SETTINGS_BY_KEY[proctorSettingKey('proctorBaseUrl')]);
  } finally {
    ctx.dispose();
  }
  assert.deepEqual(new Set(nativeSettings.SYSTEM_SETTINGS.map((setting) => setting.key)), before);
  assert.ok(!nativeSettings.SYSTEM_SETTINGS_BY_KEY[proctorSettingKey('apiKey')]);
});

test('the native save hook rejects invalid values before writes and preserves blank secret inputs', () => {
  const ctx = context();
  try {
    plugin.registerProctorSystemSettings(ctx, legacy);
    const guard = ctx.handlers.get('handler/before/SystemSetting');
    assert.equal(typeof guard, 'function');
    assert.throws(() => guard({ request: { method: 'POST' }, args: { cwnupaaProctor: { ticketTtlSeconds: '4' } } }), ValidationError);
    assert.throws(() => guard({ request: { method: 'POST' }, args: { cwnupaaProctor: { ruleMappings: 'bad JSON' } } }), ValidationError);
    assert.throws(() => guard({ request: { method: 'POST' }, args: { cwnupaaProctor: { problemDomainId: 'bad\u0007name' } } }), ValidationError);
    assert.doesNotThrow(() => guard({ request: { method: 'POST' }, args: { cwnupaaProctor: { apiKey: '', sharedSecret: '' } } }));
    assert.doesNotThrow(() => guard({ request: { method: 'GET' }, args: { cwnupaaProctor: { ticketTtlSeconds: '4' } } }));
  } finally {
    ctx.dispose();
  }
});

function signedHandler(HandlerClass, body, key, secret, timestamp = String(Date.now())) {
  const handler = Object.create(HandlerClass.prototype);
  handler.request = {
    headers: {
      'x-proctor-api-key': key,
      'x-proctor-timestamp': timestamp,
      'x-proctor-signature': crypto.createHmac('sha256', secret).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex'),
    },
    body,
  };
  handler.response = { addHeader: () => undefined };
  return handler;
}

test('the complete plugin registers an API-Key-only, read-only configuration check with live settings', async () => {
  const ctx = context();
  try {
    new plugin.default(ctx, legacy);
    await Promise.resolve();
    assert.equal(ctx.errors.length, 0);
    const HandlerClass = ctx.routes.get('/api/proctor/config-check');
    assert.equal(typeof HandlerClass, 'function');
    modelCalls.length = 0;
    const original = signedHandler(HandlerClass, {}, legacy.apiKey, legacy.sharedSecret);
    await original.post();
    assert.deepEqual(original.response.body, { ok: true, data: publicProctorConfig(legacy) });
    assert.deepEqual(modelCalls, []);

    Object.assign(systemCache, valuesFor({ apiKey: 'test-only-live-key', sharedSecret: 'test-only-live-secret', problemDomainId: 'LiveProblems' }));
    await assert.rejects(() => signedHandler(HandlerClass, {}, legacy.apiKey, legacy.sharedSecret).post(), ForbiddenError);
    const live = signedHandler(HandlerClass, {}, 'test-only-live-key', 'test-only-live-secret');
    await live.post();
    assert.equal(live.response.body.data.problemDomainId, 'LiveProblems');
    assert.deepEqual(modelCalls, []);
    const response = JSON.stringify(live.response.body);
    assert.ok(!response.includes('test-only-live-key') && !response.includes('test-only-live-secret'));
    await signedHandler(HandlerClass, {}, 'test-only-live-key', 'wrong-signature-secret').post();
    await signedHandler(HandlerClass, {}, 'test-only-live-key', 'test-only-live-secret', String(Date.now() - 600_000)).post();
    const tampered = signedHandler(HandlerClass, {}, 'test-only-live-key', 'test-only-live-secret');
    tampered.request.body = { changed: true };
    await tampered.post();
    assert.deepEqual(modelCalls, []);
  } finally {
    for (const key of Object.keys(systemCache)) delete systemCache[key];
    ctx.dispose();
  }
});

test('API-Key-only judge and status handlers queue canonical Python without looking up users or contests', async () => {
  const ctx = context();
  const originals = { record: hydroMock.RecordModel, problem: hydroMock.ProblemModel, setting: hydroMock.SettingModel };
  const calls = [];
  let allowed = [];
  try {
    new plugin.default(ctx, { ...legacy, sharedSecret: '', judgeAccount: '' });
    await Promise.resolve();
    hydroMock.SettingModel = { ...nativeSettings, langs: { py3: { display: 'Python 3' }, py2: { display: 'Python 2' }, java: { disabled: true } } };
    hydroMock.ProblemModel = { ...originals.problem, get: async () => ({ config: { type: 'default', langs: allowed } }) };
    let record;
    hydroMock.RecordModel = {
      add: async (...args) => { calls.push(['add', ...args]); record = { _id: 'fixture-rid', pid: args[1], uid: args[2], lang: args[3], code: args[4], status: 0 }; return record._id; },
      get: async () => record,
      judge: async (...args) => { calls.push(['judge', ...args]); },
    };
    const handler = Object.create(ctx.routes.get('/api/proctor/judge').prototype);
    handler.request = { headers: { 'x-proctor-api-key': legacy.apiKey }, body: { pid: 7, lang: 'python', code: 'print(1+2)', uid: 999, account: 'unlinked', contestId: 'not-an-exam' } };
    handler.response = {};
    modelCalls.length = 0;
    await handler.post({ domainId: 'system' });
    assert.equal(calls[0][1], legacy.problemDomainId);
    assert.deepEqual(calls[0].slice(2), [7, 1, 'py3', 'print(1+2)', false, { type: 'judge' }]);
    assert.equal(calls[1][0], 'judge'); assert.equal(calls[1][3], 50);
    assert.equal(handler.response.body.data.lang, 'py3');
    assert.equal('uid' in handler.response.body.data, false);
    assert.ok(modelCalls.every(call => call.name === 'domain'));
    const status = Object.create(ctx.routes.get('/api/proctor/judge/:rid').prototype);
    status.request = { headers: { 'x-proctor-api-key': legacy.apiKey }, body: {} }; status.response = {};
    await status.post({ domainId: 'unrelated-exam' }, 'fixture-rid');
    assert.equal(status.response.body.data.id, 'fixture-rid');
    assert.ok(modelCalls.every(call => call.name === 'domain'));
    allowed = ['py2']; calls.length = 0;
    await assert.rejects(() => handler.post({ domainId: 'system' }), BadRequestError);
    assert.equal(calls.length, 0, 'alias cannot bypass problem restrictions or switch to Python 2');
    handler.request.body.lang = 'java'; allowed = [];
    await assert.rejects(() => handler.post({ domainId: 'system' }), BadRequestError);
    handler.request.headers['x-proctor-api-key'] = 'wrong'; handler.request.body.lang = 'py3';
    await assert.rejects(() => handler.post({ domainId: 'system' }), ForbiddenError);
  } finally { hydroMock.RecordModel = originals.record; hydroMock.ProblemModel = originals.problem; hydroMock.SettingModel = originals.setting; ctx.dispose(); }
});

test('language listing includes usable compilers across all judge reports and excludes disabled or missing languages', async () => {
  const ctx = context();
  const originals = { database: hydroMock.db, setting: hydroMock.SettingModel };
  try {
    new plugin.default(ctx, { ...legacy, sharedSecret: '' }); await Promise.resolve();
    hydroMock.SettingModel = { ...nativeSettings, langs: { py3: { display: 'Python 3' }, js: { display: 'JavaScript' }, rust: { display: 'Rust' }, java: { disabled: true }, cc: {}, _: {} } };
    hydroMock.db = { collection: () => ({ find: () => ({ toArray: async () => [
      { compilers: { py3: 'Python 3.12', cc: 'execve: no such file' } },
      { compilers: { js: 'Node v22', rust: 'rustc 1.90', java: 'JDK 21' } },
    ] }) }) };
    const handler = Object.create(ctx.routes.get('/api/proctor/languages').prototype);
    handler.request = { headers: { 'x-proctor-api-key': legacy.apiKey }, body: {} }; handler.response = {};
    await handler.post();
    assert.deepEqual(handler.response.body.data.map(item => item.id), ['py3', 'js', 'rust']);
  } finally { hydroMock.db = originals.database; hydroMock.SettingModel = originals.setting; ctx.dispose(); }
});
