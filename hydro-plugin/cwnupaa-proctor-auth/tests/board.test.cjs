const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../../../apps/web/node_modules/typescript');

function load(name, hydro) {
    const filename = path.resolve(__dirname, '..', name);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, esModuleInterop: true,
    } }).outputText;
    const mod = new Module(filename, module);
    mod.filename = filename; mod.paths = module.paths;
    const original = mod.require.bind(mod);
    mod.require = name => name === 'hydrooj' ? hydro : name === './problem-score' ? load('problem-score.ts', hydro)
        : name === 'js-yaml' ? { load: JSON.parse } : original(name);
    mod._compile(compiled, filename);
    return mod.exports;
}
class ObjectId {
    constructor(value) { assert.match(value, /^[a-f\d]{24}$/); this.value = value; }
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
    const stamp = Math.floor(Date.parse('2026-11-09T03:00:00Z') / 1000).toString(16);
    const rows = Array.from({ length: 55 }, (_, index) => ({ _id: new ObjectId(`${stamp}${index.toString(16).padStart(16, '0')}`),
        uid: 7, pid: 9, status: 1, score: 200, lang: 'cpp', code: '// source', time: 12, memory: 4096, compilerText: 'private log' }));
    const contest = { rule: 'acm', pids: [9, 10], beginAt: new Date('2026-11-09T02:00:00Z'), endAt: new Date('2026-11-09T07:00:00Z') };
    const problems = [{ docId: 9, title: 'Same title', config: { time: '2s', memory: '1gb', subtasks: [{ score: 120 }, { score: 80 }] } },
        { docId: 10, title: 'Same title', config: JSON.stringify({ time: '500ms', memory: '65536kb' }) }];
    const calls = [], hooks = {};
    let available = true;
    const hydro = { Handler, ObjectId, Context: class {}, ConnectionHandler: class {}, Types: { ObjectId: {} }, param: () => () => {},
        BadRequestError: Error, NotFoundError: Error, ForbiddenError: Error, CreateError: () => Error, PERM: {}, PRIV: {},
        getAlphabeticId: index => String.fromCharCode(65 + index),
        db: { collection: () => ({ createIndex: async () => {}, findOne: async () => { throw new Error('browser protection intercepted service'); } }) },
        ContestModel: { get: async (domain, id) => { calls.push(['contest', domain, id]); return available ? contest : null; } },
        ProblemModel: { getMulti: (domain, filter) => { calls.push(['problems', domain, filter]); return { toArray: async () => problems }; },
            get: async (domain, pid, projection, raw) => { assert.equal(raw, true); calls.push(['reference', domain, pid]); return problems.find(p => p.docId === pid); } },
        UserModel: { getList: async () => ({ 7: { uname: 'team01', password: 'private password' }, 8: { uname: 'maintainer' } }) },
        RecordModel: { getMulti: (domain, filter) => {
            calls.push(['records', domain, filter]);
            let found = rows.filter(row => String(row._id) >= String(filter._id.$gte) && String(row._id) < String(filter._id.$lt)
                && (!filter._id.$gt || String(row._id) > String(filter._id.$gt)));
            return { project(fields) { calls.push(['projection', fields]); return this; }, sort(order) { assert.deepEqual(order, { _id: 1 }); return this; },
            limit(size) { assert.ok([51, 251].includes(size)); found = found.slice(0, size); return this; }, toArray: async () => found };
        } },
    };
    const ctx = { Route: () => {}, on: (name, cb) => { hooks[name] = cb; } };
    const authorize = handler => { if (handler.request.headers['x-proctor-api-key'] !== 'key') throw new Error('invalid api key'); };
    const BoardHandler = load('board-contest.ts', hydro).registerBoardContest(ctx, authorize);
    load('browser-contest.ts', hydro).registerBrowserContest(ctx, authorize, handler => handler instanceof BoardHandler);
    const handler = new BoardHandler();
    handler.request.headers['x-proctor-api-key'] = 'key';
    handler.request.body = { since: '2026-11-09T01:00:00Z', until: '2026-11-09T08:00:00Z', after: null, usernames: ['team01'] };
    const read = async () => { await handler.post({ domainId: 'xcpc' }, tid); return handler.response.body.data; };
    return { handler, rows, contest, problems, calls, hooks, read, unavailable: () => { available = false; } };
}
test('authenticated native export preserves code, units and full score, and paginates with stable IDs', async () => {
    const { handler, calls, hooks, read } = fixture();
    await hooks['handler/create/http'](handler);
    const first = await read();
    assert.equal(first.records.length, 50); assert.equal(first.nextAfter, first.records[49].id);
    assert.deepEqual(first.problems.map(p => [p.label, p.hydroScore, p.timeLimitMs, p.memoryLimitMb]), [['A', 200, 2000, 1024], ['B', 100, 500, 64]]);
    assert.equal(first.records[0].code, '// source'); assert.equal(first.records[0].memory, 4096);
    assert.doesNotMatch(JSON.stringify(first), /private log|private password/);
    assert.equal(calls.find(c => c[0] === 'records')[1], 'xcpc');
    assert.deepEqual(calls.find(c => c[0] === 'problems')[2], { docId: { $in: [9, 10] } });
    handler.request.body.after = first.nextAfter;
    const last = await read(); assert.equal(last.records.length, 5); assert.equal(last.nextAfter, null);
});
test('contest live reads pending runs and colors and withholds frozen verdicts and source code', async () => {
    const { handler, contest, calls, read } = fixture();
    contest.balloon = { 9: { name: 'blue', color: '#2563eb' } };
    contest.lockAt = new Date('2026-11-09T02:30:00Z');
    handler.request.body.broadcast = true;
    const frozen = await read();
    assert.equal(frozen.problems[0].color, '#2563eb');
    assert.equal(frozen.broadcast.frozenAt, contest.lockAt.toISOString());
    assert.equal(frozen.records.length, 55);
    assert.ok(frozen.records.every(run => run.status === 0 && run.score === 0 && run.code === ''));
    assert.equal(calls.find(call => call[0] === 'projection')[1].code, undefined);

    handler.request.body.broadcast = false;
    const exported = await read();
    assert.equal(exported.broadcast, undefined);
    assert.equal(exported.records[0].status, 1);
    assert.equal(exported.records[0].score, 200);
    handler.request.body.broadcast = true;

    contest.unlocked = true;
    const unlocked = await read();
    assert.equal(unlocked.broadcast.frozenAt, null);
    assert.equal(unlocked.records[0].status, 1);
});
test('authenticated broadcast reveal returns actual verdicts without changing Hydro freeze or exporting code', async () => {
    const { handler, contest, rows, calls, read } = fixture();
    contest.lockAt = new Date('2026-11-09T02:30:00Z');
    contest.maintainer = [8];
    rows[1].uid = 8;
    Object.assign(handler.request.body, { broadcast: true, reveal: true, usernames: ['team01', 'maintainer'] });
    handler.request.headers = {};
    await assert.rejects(read(), /api key/);
    assert.equal(calls.length, 0);
    handler.request.headers['x-proctor-api-key'] = 'key';

    const revealed = await read();
    assert.equal(revealed.broadcast.frozenAt, null);
    assert.equal(revealed.records.length, 54);
    assert.ok(revealed.records.every(run => run.username === 'team01' && run.status === 1 && run.score === 200 && run.code === ''));
    assert.equal(calls.find(call => call[0] === 'projection')[1].code, undefined);

    handler.request.body.reveal = 'true';
    const frozen = await read();
    assert.equal(frozen.broadcast.frozenAt, contest.lockAt.toISOString());
    assert.ok(frozen.records.every(run => run.status === 0 && run.score === 0));
});

test('broadcast statistics expose language but withhold frozen judgement timestamps', async () => {
    const { handler, contest, rows, read } = fixture();
    contest.lockAt = new Date('2026-11-09T02:30:00Z');
    rows[0].judgeAt = new Date('2026-11-09T03:01:00Z');
    Object.assign(handler.request.body, { broadcast: true, statistics: true });
    const masked = (await read()).records[0];
    assert.equal(masked.status, 0);
    assert.equal(masked.judgedAt, null);
    assert.equal(masked.language, rows[0].lang);
    assert.equal(masked.code, '');
    handler.request.body.reveal = true;
    const released = (await read()).records[0];
    assert.equal(released.judgedAt, rows[0].judgeAt.toISOString());
    assert.equal(released.status, 1);
    assert.equal(released.code, '');
});
test('authorization and malformed cursors are rejected before database reads', async () => {
    const { handler, calls, read } = fixture();
    handler.request.headers = {}; await assert.rejects(read(), /api key/); assert.equal(calls.length, 0);
    handler.request.headers['x-proctor-api-key'] = 'key'; handler.request.body.after = { $gt: '' };
    await assert.rejects(read(), /cursor/); assert.equal(calls.length, 0);
    handler.request.body.after = null; handler.request.body.since = '2200-01-01';
    await assert.rejects(read(), /cursor/); assert.equal(calls.length, 0);
});
test('account filtering advances empty pages; pre-contest export returns only a manifest', async () => {
    const { handler, read, calls } = fixture();
    handler.request.body.usernames = ['another-account'];
    const page = await read(); assert.equal(page.records.length, 0); assert.ok(page.nextAfter);
    handler.request.body.until = '2026-11-08T01:00:00Z';
    const queryCount = calls.filter(c => c[0] === 'records').length;
    const early = await read(); assert.equal(early.records.length, 0); assert.equal(early.problems.length, 2); assert.equal(early.nextAfter, null);
    assert.equal(calls.filter(c => c[0] === 'records').length, queryCount);
});
test('byte-bounded pages never truncate code or skip records; later scans observe old rejudges', async () => {
    const { handler, rows, read } = fixture();
    rows[0].code = 'a'.repeat(600_000); rows[1].code = 'b'.repeat(600_000);
    const first = await read(); assert.equal(first.records.length, 1); assert.equal(first.records[0].code.length, 600_000);
    handler.request.body.after = first.nextAfter;
    const next = await read(); assert.equal(next.records[0].id, String(rows[1]._id));
    rows[0].status = 2; handler.request.body.after = null;
    assert.equal((await read()).records[0].status, 2);
});
test('missing source resources and unsupported variable-duration contests are errors', async () => {
    const first = fixture(); first.unavailable(); await assert.rejects(first.read(), /contest/);
    const second = fixture(); second.problems.pop(); await assert.rejects(second.read(), /problem/);
    const third = fixture(); third.contest.duration = 60; await assert.rejects(third.read(), /fixed-time/);
});
test('referenced problem configurations and per-case limits retain the contest identity', async () => {
    const { problems, read } = fixture();
    problems[1].reference = { domainId: 'bank', pid: 9 };
    problems[0].config.subtasks[0].cases = [{ time: '4s', memory: '2gb' }];
    const page = await read();
    assert.equal(page.problems[1].id, '10'); assert.equal(page.problems[1].label, 'B');
    assert.equal(page.problems[1].hydroScore, 200); assert.equal(page.problems[1].timeLimitMs, 4000); assert.equal(page.problems[1].memoryLimitMb, 2048);
    problems[0].reference = { domainId: 'bank', pid: 10 };
    await assert.rejects(read(), /circular/);
});
