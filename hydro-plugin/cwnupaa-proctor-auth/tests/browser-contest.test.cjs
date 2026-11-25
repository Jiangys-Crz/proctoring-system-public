const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const test = require('node:test');
const ts = require('../../../apps/web/node_modules/typescript');

const tid = '691000000000000000000001';
const rid = '691000000000000000000002';
const otherTid = '691000000000000000000003';
const otherRid = '691000000000000000000004';
const proof = 'a'.repeat(43);
const origin = 'https://hydro.example';
const digest = value => createHash('sha256').update(value).digest('hex');
class PermissionError extends Error {}
class ContestScoreboardHiddenError extends Error {}
class ForbiddenError extends Error {}
class ConnectionHandler {}
class ObjectId {
    constructor(value) { this.value = value; }
    toHexString() { return this.value; }
    toString() { return this.value; }
}
class Handler {
    request = { method: 'get', path: '/record', headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'x-hydro-proctor-key': proof }, query: {} };
    args = { tid, domainId: 'school' };
    domain = { _id: 'school' };
    user = { _id: 7, hasPerm: () => true };
    session = { _id: 'session' };
    context = { cookies: { get: () => 'session' } };
    headers = {};
    response = { addHeader: (name, value) => { this.headers[name] = value; } };
    url(name, { domainId, tid: contestId }) {
        assert.equal(name, 'contest_problemlist');
        assert.equal(domainId, (this.request.originalPath || this.request.path).startsWith('/d/') ? this.domain._id : undefined);
        const domain = domainId || this.domain._id;
        return `${domain === 'system' && !domainId ? '' : `/d/${domain}`}/contest/${contestId}/problems`;
    }
}

const filename = require.resolve('../browser-contest.ts');
const pluginSource = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
}).outputText;

function hooksFor(hydro, authorize = () => {}) {
    const hooks = {};
    const plugin = new Module(filename, module);
    plugin.require = name => name === 'hydrooj' ? hydro : require(name);
    plugin._compile(pluginSource, filename);
    plugin.exports.registerBrowserContest({
        on: (name, hook) => { hooks[name] = hook; },
        Route(name, path, route) { hooks.routes = { ...hooks.routes, [path]: route }; },
        logger: { error: assert.fail },
    }, authorize, handler => handler.service === true);
    return hooks;
}

function fixture({ enrolled = true, ongoing = true } = {}) {
    const hydro = {
        Handler, ConnectionHandler, ObjectId, PermissionError, ContestScoreboardHiddenError, ForbiddenError,
        CreateError: () => class extends ForbiddenError {}, Types: { ObjectId: {} }, param: () => () => {},
        PERM: { PERM_VIEW: 1n, PERM_VIEW_CONTEST: 2n },
        ContestModel: { get: async () => ({}), isOngoing: () => ongoing, getStatus: async () => ({ attend: enrolled }) },
        RecordModel: { get: async (domainId, recordId) => {
            assert.equal(domainId, 'school');
            assert.equal(String(recordId), rid);
            return { contest: new ObjectId(tid) };
        } },
        db: { collection: name => ({
            createIndex: async () => {},
            findOne: async ({ _id, sid }) => {
                if (name.endsWith('.contest')) return ['school', 'system'].some(domain => _id === `${domain}/${tid}`) ? {} : null;
                assert.equal(sid, 'session');
                return ['school', 'system'].some(domain => _id === `${domain}/${tid}/7`)
                    ? { hash: digest(proof) } : null;
            },
        }) },
    };
    return hooksFor(hydro)['handler/error'];
}

test('contest HTML permission errors return a verified candidate to the same domain problem list', async () => {
    const onError = fixture();
    for (const [path, error] of [
        ['/record', new PermissionError()],
        [`/d/school/record/${rid}`, new PermissionError()],
        [`/contest/${tid}/scoreboard`, new ContestScoreboardHiddenError()],
    ]) {
        const handler = new Handler();
        handler.request.path = path;
        await onError(handler, error);
        assert.equal(handler.response.redirect, `/d/school/contest/${tid}/problems`);
        assert.equal(handler.headers['Cache-Control'], 'no-store');
    }
    const rootDomain = new Handler();
    rootDomain.args.domainId = rootDomain.domain._id = 'system';
    await onError(rootDomain, new PermissionError());
    assert.equal(rootDomain.response.redirect, `/contest/${tid}/problems`);
    const domainPrefixed = new Handler();
    domainPrefixed.request.originalPath = '/d/school/record';
    await onError(domainPrefixed, new PermissionError());
    assert.equal(domainPrefixed.response.redirect, `/d/school/contest/${tid}/problems`);
});

test('denials leave API, mutations, downloads, unbound users and the destination alone', async () => {
    for (const change of [
        h => { h.request.path = `/contest/${tid}/problems/`; },
        h => { h.request.path = `/api/contest/${tid}`; },
        h => { h.request.method = 'post'; },
        h => { h.request.json = true; },
        h => { h.request.query = { download: '1' }; },
        h => { h.request.headers['sec-fetch-mode'] = 'cors'; },
        h => { h.request.headers['x-hydro-proctor-key'] = 'b'.repeat(43); },
        h => { h.args.tid = '691000000000000000000009'; },
        h => { h.user.hasPerm = (...permissions) => permissions.some(permission => permission === 1n); },
        h => { h.user.hasPerm = (...permissions) => permissions.some(permission => permission === 2n); },
        h => { h.service = true; },
    ]) {
        const handler = new Handler();
        change(handler);
        await fixture()(handler, new PermissionError());
        assert.equal(handler.response.redirect, undefined);
    }
    const handler = new Handler();
    await fixture({ enrolled: false })(handler, new PermissionError());
    await fixture({ ongoing: false })(handler, new PermissionError());
    await fixture()(handler, new ForbiddenError());
    await fixture()(new ConnectionHandler(), new PermissionError());
    assert.equal(handler.response.redirect, undefined);
});

function leaseFixture(domain = 'school') {
    const state = {
        binding: { _id: `${domain}/${tid}/7`, sid: 'session', hash: digest(proof) },
        session: { uid: 7, expireAt: new Date(Date.now() + 3600_000) },
        ongoing: true,
        restricted: true,
    };
    const hydro = {
        Handler, ConnectionHandler, ObjectId, PermissionError, ContestScoreboardHiddenError, ForbiddenError,
        CreateError: () => class extends ForbiddenError {}, Types: { ObjectId: {} }, param: () => () => {},
        PERM: { PERM_VIEW: 1n, PERM_VIEW_CONTEST: 2n, PERM_EDIT_CONTEST: 4n },
        PRIV: { PRIV_EDIT_SYSTEM: 1 },
        ContestModel: { get: async () => ({}), isOngoing: () => state.ongoing, isDone: () => !state.ongoing },
        TokenModel: { get: async sid => sid === 'session' ? state.session : null, TYPE_SESSION: 0 },
        RecordModel: { get: async (recordDomain, id) => {
            assert.equal(recordDomain, domain);
            if (String(id) === rid) return { contest: new ObjectId(tid) };
            if (String(id) === otherRid) return { contest: new ObjectId(otherTid) };
            return null;
        } },
        db: { collection: name => ({
            createIndex: async () => {},
            find: ({ uid }) => ({ toArray: async () => uid === 7 && state.restricted ? [{ domainId: domain, tid: new ObjectId(tid) }] : [] }),
            findOne: async ({ _id, sid }) => {
                if (name.endsWith('.contest')) return _id === `${domain}/${tid}` ? {} : null;
                return _id === state.binding._id && (sid === undefined || sid === state.binding.sid) ? structuredClone(state.binding) : null;
            },
            updateOne: async (filter, { $set }) => {
                if (state.beforeUpdate) state.beforeUpdate();
                const binding = state.binding;
                const expected = filter['socketLease.proofs./record-conn'];
                const previousMatches = typeof expected === 'string'
                    ? binding.socketLease?.proofs['/record-conn'] === expected
                    : expected.$exists === false && !binding.socketLease;
                if (filter._id !== binding._id || filter.sid !== binding.sid || filter.hash !== binding.hash || !previousMatches) {
                    return { matchedCount: 0 };
                }
                Object.assign(binding, $set);
                return { matchedCount: 1 };
            },
        }) },
    };
    const hooks = hooksFor(hydro, () => { throw new Error('service authorization required'); });
    const LeaseHandler = hooks.routes['/api/proctor/browser-contest/:tid'];
    function leaseRequest() {
        const h = new LeaseHandler();
        h.args.domainId = h.domain._id = domain;
        h.request.method = 'post';
        h.request.host = 'hydro.example';
        h.request.headers.origin = origin;
        h.request.body = { action: 'socket-lease' };
        return h;
    }
    async function issue(h = leaseRequest()) {
        await h.post(h.args, new ObjectId(h.args.tid));
        assert.equal(h.headers['Cache-Control'], 'no-store');
        assert.equal(h.response.body.ok, true);
        assert.equal(h.response.body.data.expiresInSeconds, 90);
        const values = {};
        for (const { path, name, value } of h.response.body.data.cookies) {
            assert.equal(name, 'proctor_ws');
            assert.match(value, /^[A-Za-z0-9_-]{43}$/);
            assert.equal(state.binding.socketLease.proofs[path], digest(value));
            values[path] = value;
        }
        assert.deepEqual(Object.keys(values), ['/record-conn', '/record-detail-conn', '/websocket']);
        assert.equal(new Set(Object.values(values)).size, 3);
        return values;
    }
    function socket(path, value, changes = {}) {
        const connection = new ConnectionHandler();
        const cookieValues = { sid: 'session', proctor_ws: value };
        const query = path === '/record-conn' ? { domainId: 'school', tid } : path === '/record-detail-conn' ? { domainId: 'school', rid } : {};
        connection.request = { path, query, host: 'hydro.example', headers: { origin, upgrade: 'websocket' } };
        connection.args = { domainId: 'system', ...query };
        connection.domain = { _id: 'school' };
        connection.user = { _id: 7, hasPriv: () => false, hasPerm: () => false };
        connection.session = { _id: 'session' };
        connection.context = { cookies: { get: name => cookieValues[name] } };
        connection.ctx = { interval: (callback, delay) => {
            assert.equal(delay, 2000);
            connection.recheck = callback;
        } };
        connection.close = (code, reason) => { connection.closure = { code, reason }; };
        if (changes.modify) changes.modify(connection, cookieValues);
        return connection;
    }
    return { state, leaseRequest, issue, socket, hooks, connect: hooks['handler/create/ws'], http: hooks['handler/create/http'] };
}

test('WebKit participant requests use the original contest lease on both system-domain paths', async () => {
    for (const base of ['', '/d/system']) {
        const app = leaseFixture('system');
        const issuance = app.leaseRequest();
        issuance.context.request = { secure: true };
        issuance.request.originalPath = base + '/api/proctor/browser-contest/' + tid;
        Object.assign(issuance.request.body, { transport: 'wkwebview', basePath: base });
        await app.issue(issuance);
        const cookies = Object.fromEntries(issuance.response.body.data.httpCookies.map(c => [c.path, c.value]));
        const contest = '/contest/' + tid;
        async function visit(path, method, cookie, domain = 'system') {
            const h = new Handler();
            h.args.domainId = h.domain._id = domain;
            h.request = { path, method, host: 'hydro.example', query: {}, headers: { origin } };
            h.context = { request: { secure: true }, cookies: { get: name => name === 'sid' ? 'session' : cookie, set() {} } };
            await app.http(h);
        }
        const proof = cookies[base + contest];
        for (const prefix of ['', '/d/system']) {
            const ui = prefix + contest + '/domjudge-ui';
            await visit(ui, 'post', proof);
            await visit(ui + '/booklet.pdf', 'get', proof);
            await visit(prefix + contest + '/scoreboard/xcpcio', 'get', proof);
            await visit(prefix + '/record/' + rid, 'get', cookies[base + '/record']);
            await assert.rejects(visit(prefix + '/record/' + otherRid, 'get', cookies[base + '/record']), ForbiddenError);
            await assert.rejects(visit(ui + '/settings', 'post', proof), ForbiddenError);
            await assert.rejects(visit(ui + '/samples', 'post', proof), ForbiddenError);
            await assert.rejects(visit(ui, 'post', cookies[base + '/p']), ForbiddenError);
        }
        await assert.rejects(visit('/d/other' + contest + '/domjudge-ui', 'post', proof), ForbiddenError);
    }
});

test('inline PDF document previews embed only the storage link returned by the authorized Hydro handler', () => {
    const { hooks } = leaseFixture();
    for (const hook of ['handler/after/ProblemFileDownload#get', 'handler/after/ContestFileDownload#get']) {
        const h = new Handler();
        h.context.request = { origin };
        h.request.path = '/p/1/file/statement.pdf';
        h.request.query = { noDisposition: '1' };
        h.request.headers['sec-fetch-dest'] = 'iframe';
        const storage = '/fs/storage?target=fixture.pdf&expire=123';
        for (const link of ['https://other.example/fs/file', '/manage', '']) {
            h.response.redirect = link;
            hooks[hook](h);
            assert.equal(h.response.redirect, link);
            assert.equal(h.response.body, undefined);
        }
        h.response.redirect = storage;
        h.request.headers['sec-fetch-dest'] = 'embed';
        hooks[hook](h);
        assert.equal(h.response.redirect, storage);
        h.request.headers['sec-fetch-dest'] = 'iframe';
        hooks[hook](h);
        assert.equal(h.response.redirect, '');
        assert.equal(h.response.type, 'text/html');
        assert.match(h.response.body, /<embed type="application\/pdf" src="\/fs\/storage\?target=fixture.pdf&amp;expire=123">/);
    }
});

test('protected contests require the client for monitored accounts and keep ordinary participants on Hydro permissions', async () => {
    const app = leaseFixture();
    const request = (uid, method, path) => {
        const handler = new Handler();
        handler.user = { _id: uid, hasPriv: () => false, hasPerm: () => false };
        handler.request = { ...handler.request, method, path, headers: {} };
        return handler;
    };
    for (const [method, path] of [
        ['get', `/contest/${tid}/scoreboard`],
        ['get', `/record/${rid}`],
        ['post', '/p/9/submit'],
    ]) {
        const ordinary = request(8, method, path);
        await app.http(ordinary);
        assert.equal(ordinary.headers['Cache-Control'], undefined);
        await assert.rejects(() => app.http(request(7, method, path)), ForbiddenError);
    }
    const anonymous = request(0, 'get', `/contest/${tid}`);
    await app.http(anonymous);
    assert.equal(anonymous.headers['Cache-Control'], undefined);
    const service = request(7, 'post', `/api/proctor/board-contest/${tid}`);
    service.service = true;
    await app.http(service);
    assert.equal(service.headers['Cache-Control'], undefined);

    const ordinarySocket = app.socket('/record-conn', undefined, { modify: connection => { connection.user._id = 8; } });
    await app.connect(ordinarySocket);
    assert.equal(ordinarySocket.closure, undefined);
    await assert.rejects(() => app.connect(app.socket('/record-conn', undefined)), ForbiddenError);
});

test('a legacy browser binding remains restricted on a new SID without restricting other accounts', async () => {
    const app = leaseFixture();
    app.state.restricted = false;
    const a = new Handler();
    a.user = { _id: 7, hasPriv: () => false, hasPerm: () => false };
    a.request.path = `/contest/${tid}`;
    await app.http(a);
    assert.equal(a.headers['Cache-Control'], 'no-store');
    a.session._id = 'new-sid';
    a.context.cookies.get = () => 'new-sid';
    await assert.rejects(() => app.http(a), ForbiddenError);

    const manager = new Handler();
    manager.user = { _id: 8, hasPriv: () => true, hasPerm: () => false };
    manager.request.path = `/contest/${tid}`;
    manager.request.headers = {};
    await app.http(manager);
    assert.equal(manager.headers['Cache-Control'], 'no-store');
});

test('independent CCS service calls need no browser session and do not exempt restricted users', async () => {
    const app = leaseFixture();
    const service = new Handler();
    service.request.path = `/d/school/api/ccs/contests/${tid}/event-feed`;
    service.request.headers = { 'x-ccs-api-key': 'a'.repeat(32) };
    service.args = { domainId: 'school', contestId: tid };
    service.user = { _id: 0 };
    await app.http(service); // The independent handler authenticates its own API key.
    service.user = { _id: 7 };
    await assert.rejects(() => app.http(service), ForbiddenError);
});

test('lease issuance requires exact origin, live Hydro session and original binding proof', async () => {
    const app = leaseFixture();
    for (const change of [
        h => { delete h.request.headers['x-hydro-proctor-key']; },
        h => { h.request.headers['x-hydro-proctor-key'] = 'b'.repeat(43); },
        h => { delete h.request.headers.origin; },
        h => { h.request.headers.origin = 'https://unrelated.example'; },
        h => { h.request.headers.origin += '/path'; },
        h => { h.request.host = 'hydro.example:8443'; },
        h => { h.context.cookies.get = () => 'unbound-session'; },
        h => { h.args.tid = otherTid; },
    ]) {
        const h = app.leaseRequest();
        change(h);
        await assert.rejects(() => h.post(h.args, new ObjectId(h.args.tid)), ForbiddenError);
        assert.equal(h.headers['Cache-Control'], 'no-store');
        assert.equal(h.response.body, undefined);
    }
    const successful = await app.issue();
    assert.ok(successful['/record-conn']);
    const h = app.leaseRequest();
    h.request.body.action = 'enable';
    await assert.rejects(() => h.post(h.args, new ObjectId(tid)), /service authorization required/);
    app.state.beforeUpdate = () => { app.state.binding.hash = digest('replacement'); };
    await assert.rejects(() => app.issue(), ForbiddenError);
});

test('WebSocket proof is scoped to the exact path, origin, domain, session and contest record', async () => {
    const app = leaseFixture();
    const values = await app.issue();
    for (const [path, token] of Object.entries(values)) await app.connect(app.socket(path, token));
    for (const [path, token, modify] of [
        ['/record-conn', undefined],
        ['/record-detail-conn', values['/record-conn']],
        ['/other-socket', values['/websocket']],
        ['/record-conn', values['/record-conn'], h => { h.request.headers.origin = 'https://other.example'; }],
        ['/record-conn', values['/record-conn'], h => { h.request.headers.origin = 'http://hydro.example'; }],
        ['/record-conn', values['/record-conn'], h => { h.request.host = 'hydro.example:8443'; }],
        ['/record-conn', values['/record-conn'], h => { h.request.originalPath = '/d/school/record-conn'; }],
        ['/record-conn', values['/record-conn'], h => { h.request.headers.upgrade = undefined; }],
        ['/record-conn', values['/record-conn'], h => { h.request.query.tid = otherTid; }],
        ['/record-conn', values['/record-conn'], h => { h.request.query.tid = [tid, tid]; }],
        ['/record-conn', values['/record-conn'], h => { h.request.query.allDomain = '1'; }],
        ['/record-conn', values['/record-conn'], h => { h.args.domainId = h.request.query.domainId = 'elsewhere'; }],
        ['/record-conn', values['/record-conn'], (h, cookies) => { cookies.sid = 'copied-other-session'; }],
        ['/record-detail-conn', values['/record-detail-conn'], h => { h.request.query.rid = otherRid; }],
        ['/websocket', values['/websocket'], h => { h.request.query.sid = 'session'; }],
    ]) await assert.rejects(() => app.connect(app.socket(path, token, { modify })), ForbiddenError, path);

    const ordinaryHttp = new Handler();
    delete ordinaryHttp.request.headers['x-hydro-proctor-key'];
    ordinaryHttp.context.cookies.get = name => name === 'sid' ? 'session' : values['/record-conn'];
    await assert.rejects(() => app.http(ordinaryHttp), ForbiddenError);

    await app.connect(app.socket('/record-conn', undefined, { modify: h => {
        delete h.request.headers.origin;
        h.request.headers['x-hydro-proctor-key'] = proof;
    } }));
});

test('renewal preserves existing sockets and expiry or rebinding revokes them', async () => {
    const app = leaseFixture();
    const initial = await app.issue();
    const connection = app.socket('/record-conn', initial['/record-conn']);
    await app.connect(connection);
    const renewed = await app.issue();
    assert.notEqual(initial['/record-conn'], renewed['/record-conn']);
    await app.connect(app.socket('/record-conn', initial['/record-conn']));
    app.state.binding.socketLease.previous.expiresAt = new Date(0);
    await assert.rejects(() => app.connect(app.socket('/record-conn', initial['/record-conn'])), ForbiddenError);
    connection.recheck();
    await new Promise(setImmediate);
    assert.equal(connection.closure, undefined);
    const current = app.socket('/record-conn', renewed['/record-conn']);
    await app.connect(current);
    app.state.binding.hash = digest('replaced');
    connection.recheck();
    await new Promise(setImmediate);
    assert.deepEqual(connection.closure, { code: 4003, reason: 'Proctored contest' });
    app.state.binding.hash = digest(proof);
    app.state.binding.socketLease.expiresAt = new Date(0);
    current.recheck();
    await new Promise(setImmediate);
    assert.deepEqual(current.closure, { code: 4003, reason: 'Proctored contest' });
    app.state.session.expireAt = new Date(0);
    await assert.rejects(() => app.issue(), ForbiddenError);
});

test('concurrent renewals preserve one current lease and one overlap proof', async () => {
    const app = leaseFixture();
    const initial = await app.issue();
    const attempts = await Promise.allSettled([app.issue(), app.issue()]);
    const successful = attempts.filter(attempt => attempt.status === 'fulfilled');
    assert.equal(successful.length, 1);
    assert.equal(app.state.binding.socketLease.previous.proofs['/record-conn'], digest(initial['/record-conn']));
    for (const token of [initial['/record-conn'], successful[0].value['/record-conn']]) {
        await app.connect(app.socket('/record-conn', token));
    }
});
