const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../../../apps/web/node_modules/typescript');

// Compile the actual plugin handlers with model doubles: no Hydro installation,
// MongoDB connection, user enrollment or contest mutation is needed.
function load(name, hydro) {
    const filename = path.resolve(__dirname, '..', name);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
    }).outputText;
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = module.paths;
    const original = mod.require.bind(mod);
    mod.require = name => name === 'hydrooj' ? hydro : original(name);
    mod._compile(compiled, filename);
    return mod.exports;
}

class ObjectId {
    constructor(value) { this.value = value; }
    toHexString() { return this.value; }
    toString() { return this.value; }
    getTimestamp() { return new Date(parseInt(this.value.slice(0, 8), 16) * 1000); }
}
class Handler {
    request = { body: {}, headers: {} };
    response = { addHeader() {} };
}

function fixture() {
    const tid = new ObjectId('691000000000000000000001');
    const stamp = Math.floor(Date.parse('2026-11-09T03:00:00.000Z') / 1000).toString(16);
    const records = Array.from({ length: 205 }, (_, n) => ({ _id: new ObjectId(`${stamp}${n.toString(16).padStart(16, '0')}`), uid: 7, pid: 9,
        status: n ? 0 : 1, judgeAt: n ? null : new Date('2026-11-10T00:00:00.000Z'), code: 'private source', compilerText: 'private log' }));
    const calls = [], hooks = {};
    let available = true;
    const hydro = { Handler, ObjectId, Context: class {}, ConnectionHandler: class {}, Types: { ObjectId: {} }, param: () => () => {},
        BadRequestError: Error, NotFoundError: Error, ForbiddenError: Error, CreateError: () => Error,
        PERM: {}, PRIV: {}, getAlphabeticId: index => String.fromCharCode(65 + index),
        db: { collection: () => ({ createIndex: async () => {}, findOne: async () => { throw new Error('candidate protection must not intercept the service handler'); } }) },
        ContestModel: { get: async (domain, id) => { calls.push(['contest', domain, String(id)]); return available ? { pids: [9] } : null; } },
        UserModel: { getList: async (domain, ids) => { calls.push(['users', domain, ids]); return { 7: { uname: 'team01', displayName: 'Untrusted display name' } }; } },
        RecordModel: { getMulti: (domain, filter) => {
            calls.push(['records', domain, filter]);
            let projected = records.filter(row => String(row._id) >= String(filter._id.$gte) && (!filter._id.$gt || String(row._id) > String(filter._id.$gt)));
            return { project(fields) { calls.push(['projection', fields]); projected = projected.map(row => Object.fromEntries(Object.keys(fields).map(key => [key, row[key]]))); return this; },
                sort(order) { assert.deepEqual(order, { _id: 1 }); return this; },
                limit(size) { assert.equal(size, 201); projected = projected.slice(0, size); return this; }, toArray: async () => projected };
        } },
    };
    const ctx = { Route: () => {}, on: (name, callback) => { hooks[name] = callback; } };
    const authorize = handler => { if (handler.request.headers['x-proctor-api-key'] !== 'test-key') throw new Error('invalid proctor api key'); };
    const { registerReactionContest } = load('reaction-contest.ts', hydro);
    const ReactionHandler = registerReactionContest(ctx, authorize);
    const { registerBrowserContest } = load('browser-contest.ts', hydro);
    registerBrowserContest(ctx, authorize, handler => handler instanceof ReactionHandler);
    const handler = new ReactionHandler();
    handler.request.headers['x-proctor-api-key'] = 'test-key';
    handler.request.body = { since: '2026-11-09T00:00:00.000Z', after: null };
    return { tid, handler, calls, hooks, unavailable: () => { available = false; } };
}

test('native snapshot is API-key-only, domain scoped, paginated and exposes metadata only', async () => {
    const { handler, tid, calls, hooks } = fixture();
    await hooks['handler/create/http'](handler);
    await handler.post({ domainId: 'acm' }, tid);
    const page = handler.response.body.data;
    assert.equal(page.contestId, String(tid));
    assert.equal(page.records.length, 200);
    assert.equal(page.nextAfter, page.records[199].id);
    assert.equal(page.records[0].username, 'team01');
    assert.equal(page.records[0].problemLabel, 'A');
    assert.equal(page.records[0].status, 1, 'admin feed is not subject to student verdict projections');
    assert.doesNotMatch(JSON.stringify(page), /private source|private log|Untrusted display name/);
    const query = calls.find(call => call[0] === 'records');
    assert.equal(query[1], 'acm');
    assert.equal(query[2].contest, tid);
    assert.deepEqual(calls.find(call => call[0] === 'projection')[1], { _id: 1, uid: 1, pid: 1, status: 1, judgeAt: 1 });
    handler.request.body.after = page.nextAfter;
    await handler.post({ domainId: 'acm' }, tid);
    assert.equal(handler.response.body.data.records.length, 5);
    assert.equal(handler.response.body.data.nextAfter, null);
});

test('invalid credentials and cursor data fail before reading Hydro records', async () => {
    const { handler, tid, calls } = fixture();
    handler.request.headers = {};
    await assert.rejects(handler.post({ domainId: 'acm' }, tid), /api key/);
    assert.equal(calls.length, 0);
    handler.request.headers['x-proctor-api-key'] = 'test-key';
    handler.request.body.after = { $gt: '' };
    await assert.rejects(handler.post({ domainId: 'acm' }, tid), /cursor/);
    handler.request.body = { since: 'invalid', after: null };
    await assert.rejects(handler.post({ domainId: 'acm' }, tid), /cursor/);
    assert.equal(calls.length, 0);
});

test('a missing contest is an error rather than an empty authoritative snapshot', async () => {
    const { handler, tid, unavailable, calls } = fixture();
    unavailable();
    await assert.rejects(handler.post({ domainId: 'acm' }, tid), /contest/);
    assert.equal(calls.some(call => call[0] === 'records'), false);
});
