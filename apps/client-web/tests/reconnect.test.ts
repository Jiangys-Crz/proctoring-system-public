import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { ClientApiError, isExpiredClientSessionError, restoreBoundSession } from '../src/lib/api';
import { readWithDeadline } from '../src/lib/contest-polling';

// Execute the component's callbacks with controllable requests and state setters.
// These tests intentionally deliver old responses after the replacement login.
const source = readFileSync(new URL('../src/components/CandidateApp.tsx', import.meta.url), 'utf8');
function between(start: string, end: string) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0);
  const boundary = source.indexOf(end, offset);
  assert.ok(boundary > offset, `missing callback boundary: ${end}`);
  return source.slice(offset, boundary);
}
function evaluate(code: string, context: vm.Context) {
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const restoredSession = { sessionId: 'session', miniProgramSessionToken: 'new-phone-token',
  session: { id: 'session', status: 'IN_EXAM' }, requirements: { requireSecondCamera: true } };

function harness(request: (path: string, token: string, init?: RequestInit) => Promise<unknown>, stop?: () => Promise<void>) {
  const storage = new Map<string, string>([['request', 'old-request']]);
  const state: Record<string, unknown> = { session: { id: 'session', status: 'IN_EXAM' }, sessionToken: 'old-phone-token' };
  let clears = 0, stops = 0;
  const environment: Record<string, unknown> = {
    useCallback: (callback: unknown) => callback,
    apiBase: 'https://api.test', configuredApiBase: 'https://api.test', deviceId: 'phone-device',
    sessionId: 'session', sessionToken: 'old-phone-token', secondCameraRequired: true, streamState: 'connected',
    form: {}, identityPhoto: null, roomVideo: null,
    joiningPairRef: { current: false }, testDisconnectingRef: { current: false },
    connectionGenerationRef: { current: 0 }, captureOwnedElsewhereRef: { current: false },
    recordingBuffersRef: { current: new Map() }, readWithDeadline,
    trustedApiBase: (_configured: string, base: string) => base,
    isExpiredClientSessionError,
    ClientApi: class {
      constructor(_base: string, private token = '') {}
      request(path: string, init?: RequestInit) { return request(path, this.token, init); }
    },
    STORAGE: { apiBase: 'base', sessionId: 'session', sessionToken: 'token', sessionApiBase: 'bound', loginRequestId: 'request' },
    localStorage: { setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    stopPublisher: async () => { stops++; await stop?.(); },
    clearSession: () => { clears++; state.session = null; state.sessionToken = ''; },
    flushClipUploads() {}, reportAlert: async () => {},
  };
  for (const name of ['ApiBase', 'SessionId', 'SessionToken', 'Session', 'RoomRequirements', 'PairCode', 'ConnectionLost',
    'CapturePermissionBlocked', 'CaptureIssue', 'StreamState', 'CaptureMode', 'Step', 'Message', 'Busy', 'PendingReconnectCode',
    'PendingRecoverySecret', 'LoginRequestId', 'TestPair', 'ScannedLoginProof', 'IdentityPhoto', 'RoomVideo', 'CredentialTicket', 'TicketReady', 'Form']) {
    environment[`set${name}`] = (value: unknown) => {
      const key = name[0].toLowerCase() + name.slice(1);
      state[key] = typeof value === 'function' ? value(state[key]) : value;
    };
  }
  const context = vm.createContext(environment);
  evaluate(between('  const reconnectWithPair = ', '  useEffect(() => {\n    if (!pendingReconnectCode') +
    between('  const heartbeat = ', '\n  useEffect(() => {') +
    '\nglobalThis.reconnect = reconnectWithPair; globalThis.beat = heartbeat;', context);
  return { context, storage, state, clears: () => clears, stops: () => stops,
    reconnect: () => context.reconnect('123456', 'x'.repeat(43)), heartbeat: () => context.beat(new AbortController().signal) };
}

for (const stale of ['unauthorized', 'finished'] as const) {
  test(`a delayed ${stale} heartbeat cannot clear or finish a newly recovered phone connection`, async () => {
    const old = deferred<unknown>();
    const h = harness(async path => path.endsWith('/heartbeat') ? old.promise : restoredSession);
    const oldHeartbeat = h.heartbeat();
    await h.reconnect();
    if (stale === 'unauthorized') old.reject(new ClientApiError('令牌无效', 401));
    else old.resolve({ session: { id: 'session', status: 'FINISHED' } });
    await oldHeartbeat;
    assert.equal(h.clears(), 0);
    assert.equal(h.stops(), 1, 'only the deliberate reconnect stops the old publisher');
    assert.equal(h.state.sessionToken, 'new-phone-token');
    assert.equal((h.state.session as { status: string }).status, 'IN_EXAM');
    assert.equal(h.storage.get('token'), 'new-phone-token');
    assert.equal(h.storage.has('request'), false);
  });
}

test('heartbeats pause until QR recovery installs the replacement credentials', async () => {
  const recovery = deferred<unknown>();
  const tokens: string[] = [];
  const h = harness(async (path, token) => {
    if (path.endsWith('/heartbeat')) { tokens.push(token); return { session: restoredSession.session }; }
    return recovery.promise;
  });
  const reconnecting = h.reconnect();
  await h.heartbeat();
  assert.deepEqual(tokens, []);
  recovery.resolve(restoredSession);
  await reconnecting;
  h.context.sessionToken = 'new-phone-token';
  await h.heartbeat();
  assert.deepEqual(tokens, ['new-phone-token']);
});

test('expiry cleanup already awaiting media shutdown cannot delete a newer recovery', async () => {
  const stopping = deferred<void>();
  let stops = 0;
  const h = harness(async path => {
    if (path.endsWith('/heartbeat')) throw new ClientApiError('令牌无效', 401);
    return restoredSession;
  }, async () => { if (++stops === 1) await stopping.promise; });
  const heartbeat = h.heartbeat();
  await new Promise(resolve => setImmediate(resolve));
  await h.reconnect();
  stopping.resolve();
  await heartbeat;
  assert.equal(h.clears(), 0);
  assert.equal(h.state.sessionToken, 'new-phone-token');
});

for (const { scan, flags } of [{ scan: true, flags: '&reconnect=1' }, { scan: false, flags: '&reconnect=1' }, { scan: true, flags: '&publicTest=1' }, { scan: true, flags: '' }, { scan: true, flags: '&reconnect=1&publicTest=1' }]) {
  test((scan ? 'opening a recovery QR excludes cached old authentication' : 'refreshing after recovery restores the newly saved authentication') + ` (${flags || 'secret only'})`, () => {
    const data = new Map([
      ['proctor.client.apiBase', 'https://api.test'], ['proctor.client.deviceId', 'phone-device'],
      ['proctor.client.sessionId', 'session'], ['proctor.client.sessionToken', scan ? 'old-token' : 'new-token'],
      ['proctor.client.loginRequestId', 'old-request'],
    ]);
    const state: Record<string, unknown> = { step: 'identity' };
    const page = new URL(`https://candidate.test/?pairCode=123456${flags}${scan ? '#recoverySecret=' + 'x'.repeat(43) + (flags === '&reconnect=1&publicTest=1' ? '&credentialTicket=stale-material-ticket' : '') : ''}`);
    const env: Record<string, unknown> = { URLSearchParams, configuredApiBase: 'https://api.test', restoreBoundSession,
      useEffect: (callback: () => void) => callback(), createDeviceId: () => 'phone-device',
      trustedApiBase: () => 'https://api.test',
      STORAGE: Object.fromEntries(['apiBase', 'deviceId', 'loginRequestId'].map(key => [key, `proctor.client.${key}`])),
      window: { location: page, history: { replaceState() {} } },
      localStorage: { getItem: (key: string) => data.get(key) || null, removeItem: (key: string) => data.delete(key),
        setItem: (key: string, value: string) => data.set(key, value) },
      clearSession: () => { state.sessionToken = ''; state.step = 'identity'; },
    };
    for (const name of ['CredentialTicket', 'Message', 'ScannedLoginProof', 'ApiBase', 'PairCode', 'PendingReconnectCode',
      'PendingRecoverySecret', 'DeviceId', 'SessionId', 'SessionToken', 'LoginRequestId', 'Step', 'Hydrated']) {
      env[`set${name}`] = (value: unknown) => { state[name[0].toLowerCase() + name.slice(1)] = value; };
    }
    evaluate(between('  useEffect(() => {\n    const savedBase', '\n  useEffect(() => {\n    if (!hydrated || !credentialTicket'), vm.createContext(env));
    assert.equal(state.sessionToken, scan ? '' : 'new-token');
    assert.equal(state.step, scan ? 'identity' : 'monitor');
    assert.equal(state.pendingReconnectCode, scan ? '123456' : undefined);
    assert.equal(state.credentialTicket, undefined, 'recovery never resumes an old material submission');
  });
}

test('reconnect scans distinguish an online-desktop recovery code from a new desktop login code', () => {
  const calls: Array<{ side: string; args: unknown[] }> = [];
  const state: Record<string, unknown> = {};
  const env: Record<string, unknown> = { URL, URLSearchParams,
    useCallback: (callback: unknown) => callback, step: 'identity', apiBase: 'https://api.test', configuredApiBase: 'https://api.test',
    sessionId: 'session', sessionToken: 'online-phone-token',
    reconnectScanRef: { current: true }, trustedApiBase: (_configured: string, value: string) => value,
    clearSession: () => assert.fail('a scan must not discard the still-online phone credentials'),
    reconnectWithPair: (...args: unknown[]) => calls.push({ side: 'MINIPROGRAM', args }),
    recoverDesktopWithPair: (...args: unknown[]) => calls.push({ side: 'DESKTOP', args }),
    STORAGE: { apiBase: 'base' }, localStorage: { setItem() {} },
  };
  for (const name of ['ApiBase', 'ScannedLoginProof', 'TestPair', 'PairCode', 'CaptureMode', 'Step', 'Message']) env[`set${name}`] = (value: unknown) => { state[name] = value; };
  const context = vm.createContext(env);
  evaluate(between('function readPairPayload(', 'function uploadPath(') + between('  const acceptQr = ', '\n  async function submitLoginRequest()') + '\nglobalThis.acceptQr = acceptQr;', context);
  const url = (recovery: boolean) => `https://candidate.test/?apiBase=https%3A%2F%2Fapi.test&pairCode=123456${recovery ? '&reconnect=1' : ''}#${recovery ? 'recoverySecret' : 'testSecret'}=${'x'.repeat(43)}`;
  context.acceptQr(url(true)); assert.equal(calls[0].side, 'MINIPROGRAM');
  assert.equal(calls[0].args[1], 'x'.repeat(43));
  context.reconnectScanRef.current = true;
  context.acceptQr(url(false)); assert.equal(calls[1].side, 'DESKTOP');
  assert.equal(calls[1].args[1], 'x'.repeat(43));
  context.reconnectScanRef.current = false;
  context.acceptQr(url(false)); assert.equal(calls.length, 2, 'ordinary initial login scans keep the normal identity flow');
  assert.equal(state.PairCode, '123456');
  context.sessionId = ''; context.sessionToken = ''; context.reconnectScanRef.current = true;
  context.acceptQr(url(false));
  assert.equal(calls.length, 2, 'signed-out phones must scan a recovery grant instead of an initial-login QR');
  assert.match(String(state.Message), /左下角.*重连二维码/);
  assert.equal(state.CaptureMode, null, 'show a rejected scan on the login page instead of leaving a stopped scanner open');
  context.acceptQr(url(true).replace('&reconnect=1', '&publicTest=1'));
  assert.equal(calls[2].side, 'MINIPROGRAM', 'a recovery secret takes priority over public-test login flags');
  assert.equal(calls[2].args[1], 'x'.repeat(43));
  context.acceptQr(url(true).replace('x'.repeat(43), 'short'));
  assert.equal(calls.length, 3, 'malformed recovery secrets are rejected before any request');
});

test('QR recovery from the identity page uses only the recovery grant, never passwords or fresh materials', async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const h = harness(async (path, _token, init) => {
    requests.push({ path, body: JSON.parse(String(init?.body)) });
    return restoredSession;
  });
  h.context.sessionId = ''; h.context.sessionToken = '';
  h.context.form = { password: 'old-password' };
  await h.reconnect();
  assert.deepEqual(requests, [{ path: '/api/client/reconnect', body: { pairCode: '123456', recoverySecret: 'x'.repeat(43), deviceId: 'phone-device' } }]);
  assert.equal(h.state.step, 'monitor');
  assert.equal(h.state.sessionToken, 'new-phone-token');
  assert.equal(h.state.identityPhoto, null);
  assert.equal(h.state.roomVideo, null);
  assert.equal(h.state.credentialTicket, '');
  assert.equal((h.state.form as { password: string }).password, '');
});

test('desktop recovery uses the phone token and keeps phone authentication and the original session', async () => {
  const requests: any[] = [], state: Record<string, unknown> = {};
  const env: Record<string, unknown> = { useCallback: (callback: unknown) => callback,
    apiBase: 'https://api.test', configuredApiBase: 'https://api.test', sessionId: 'session', sessionToken: 'online-phone-token', deviceId: 'phone-device',
    joiningPairRef: { current: false }, connectionGenerationRef: { current: 0 }, trustedApiBase: (_configured: string, base: string) => base,
    ClientApi: class {
      constructor(private base: string, private token: string) {}
      async request(path: string, init: RequestInit) { requests.push({ base: this.base, token: this.token, path, body: JSON.parse(String(init.body)) }); return restoredSession; }
    },
  };
  for (const name of ['CaptureMode', 'Message', 'Busy', 'Session', 'RoomRequirements', 'StreamState', 'ConnectionLost']) env[`set${name}`] = (value: unknown) => { state[name] = value; };
  const context = vm.createContext(env);
  evaluate(between('  const recoverDesktopWithPair = ', '  const acceptQr = ') + '\nglobalThis.recover = recoverDesktopWithPair;', context);
  await context.recover('123456', 'x'.repeat(43), 'https://api.test');
  assert.equal(requests[0].token, 'online-phone-token');
  assert.deepEqual(requests[0].body, { side: 'DESKTOP', sessionId: 'session', deviceId: 'phone-device', pairCode: '123456', recoverySecret: 'x'.repeat(43) });
  assert.equal(context.sessionToken, 'online-phone-token'); assert.equal(context.sessionId, 'session');
  assert.equal(state.Session, restoredSession.session); assert.equal(context.joiningPairRef.current, false);
  context.sessionToken = '';
  await context.recover('123456', 'x'.repeat(43));
  assert.equal(requests.length, 1, 'logged-out phones cannot restore a desktop with a six-digit code or QR alone');
});
