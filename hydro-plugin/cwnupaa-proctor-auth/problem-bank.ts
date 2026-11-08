import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Readable } from 'node:stream';
import { Context, Handler, ProblemModel, StorageModel, BadRequestError, NotFoundError, db } from 'hydrooj';
import { compileProblemDraft, validateProblemDraft, type ProblemDraft } from './problem-authoring';

type MutationLease = { domain: string; active: boolean; check: () => Promise<void> };
type BankCreationIdentity = { domain: string; syncId: string };
type AuthoringCreationIdentity = { domain: string; id: string; hash: string };
// Share re-entrancy across plugin reloads, including hooks spawned by a native
// write. A detached child must acquire its own lease once its parent finishes.
type ChecksumState = { cache: Map<string, string>; jobs: Map<string, Promise<string>>; retryAfter: Map<string, number> };
const shared = globalThis as typeof globalThis & {
    proctorBankMutationContext?: AsyncLocalStorage<MutationLease>;
    proctorBankNativeWaiters?: Map<string, number>;
    proctorBankChecksums?: ChecksumState;
    proctorBankCreationContext?: AsyncLocalStorage<BankCreationIdentity>;
    proctorBankAuthoringContext?: AsyncLocalStorage<AuthoringCreationIdentity>;
};
const mutationContext = shared.proctorBankMutationContext ??= new AsyncLocalStorage<MutationLease>();
const nativeWaiters = shared.proctorBankNativeWaiters ??= new Map<string, number>();
const checksumState = shared.proctorBankChecksums ??= { cache: new Map(), jobs: new Map(), retryAfter: new Map() };
// In-flight calls can outlive plugin disposal. New before-add hooks must see
// their original identity too, or a reload could leave an unmarked duplicate.
const creation = shared.proctorBankCreationContext ??= new AsyncLocalStorage<BankCreationIdentity>();
const authoringCreation = shared.proctorBankAuthoringContext ??= new AsyncLocalStorage<AuthoringCreationIdentity>();

export function matchesAuthoredProblemConfig(config: unknown, type: 'objective' | 'default', count: number) {
    if (!config || typeof config !== 'object') return false;
    const parsed = config as { type?: unknown; count?: unknown };
    // Older Hydro releases parse the configuration but leave the summary
    // count at zero. The draft and exact saved configuration are verified separately.
    return parsed.type === type && (parsed.count === count || parsed.count === 0);
}

// Every operation is confined to the configured domain. Transfers use immutable
// staging files; an interrupted upload must never overwrite the live bank.
export function registerProblemBank(ctx: Context, authorize: (handler: Handler, body: any) => void, domain: () => string, ensureDomain: () => Promise<unknown>) {
    const projection = [...ProblemModel.PROJECTION_PUBLIC, '_id', 'proctorSyncId', 'proctorSyncPending', 'proctorSyncSnapshot', 'proctorSyncTransfer'] as any;
    const locks = db.collection('proctor.sync.locks') as any;
    const lockHost = hostname();
    let lockScope = '';
    try { lockScope = `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${readlinkSync('/proc/self/ns/pid')}`; }
    catch { /* Without a verified Linux boot/PID namespace, keep expiry recovery. */ }
    const documents = db.collection('document') as any;
    const domainContext = new AsyncLocalStorage<string>();
    const selectedDomain = () => domainContext.getStore() || domain();
    const creations = db.collection('proctor.problem.creations') as any;
    // The identity is part of Hydro's initial document insert. A process crash
    // between add() and a later edit() must not leave an unidentifiable duplicate.
    ctx.on('problem/before-add', (target, _content, _owner, _id, doc) => {
        const identity = creation.getStore();
        if (identity?.domain === target) Object.assign(doc, { proctorSyncId: identity.syncId, proctorSyncPending: true, proctorSyncSnapshot: null });
        const authoring = authoringCreation.getStore();
        if (authoring?.domain === target) Object.assign(doc, { proctorCreateId: authoring.id, proctorCreateHash: authoring.hash, proctorCreatePending: true });
    });
    const canonical = (v: any): string => v === null || typeof v !== 'object' ? JSON.stringify(v) ?? 'null' : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    const hash = (v: any) => createHash('sha256').update(canonical(v)).digest('hex');
    function fileName(value: unknown) {
        const name = String(value || '');
        if (!name || name !== name.trim() || /[\\\u0000-\u001f]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new BadRequestError('file name');
        return name;
    }
    function manifest(value: any) {
        if (!value || typeof value.title !== 'string' || typeof value.content !== 'string') throw new BadRequestError('problem metadata');
        if (typeof value.html !== 'boolean' || typeof value.hidden !== 'boolean' || !Array.isArray(value.tags) || value.tags.some((t: unknown) => typeof t !== 'string') || !Number.isFinite(value.difficulty) || (typeof value.config !== 'string' && (!value.config || typeof value.config !== 'object'))) throw new BadRequestError('problem metadata');
        for (const area of ['data', 'files']) {
            if (!Array.isArray(value[area])) throw new BadRequestError('file manifest');
            const names = new Set();
            for (const f of value[area]) { const name = fileName(f.name); if (names.has(name) || !Number.isSafeInteger(f.size) || f.size < 0 || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new BadRequestError('file manifest'); names.add(name); }
        }
    }
    const areaPath = (area: string) => area === 'data' ? 'testdata' : area === 'files' ? 'additional_file' : '';
    const stagePath = (syncId: string, area: string, f: any) => `proctor-sync/${selectedDomain()}/${syncId}/${area}/${f.sha256}/${fileName(f.name)}`;
    const checksums = db.collection('proctor.sync.checksums') as any;
    function rememberChecksum(physical: string, sha256: string) {
        const cache = checksumState.cache;
        cache.delete(physical);
        if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
        cache.set(physical, sha256);
    }
    async function waitForChecksum(job: Promise<string>) {
        // A cold/slow storage object must not hold the domain mutation lease
        // for the entire hash. Retry the catalog after this bounded shared job.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([job, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new BadRequestError('file checksum pending')), 250);
                timer.unref();
            })]);
        } finally { if (timer) clearTimeout(timer); }
    }
    async function checksumPath(path: string) {
        // Hydro allocates a new physical object for every put(). ETags and
        // logical file names cannot safely identify immutable bytes.
        const object = await StorageModel.coll?.findOne({ path, autoDelete: null }, { projection: { _id: 1, link: 1 } });
        const physical = object ? String(object.link || object._id) : null;
        // Never cache a mutable logical name or hash a missing file as empty.
        if (!physical) throw new NotFoundError('file');
        return checksumObject(physical);
    }
    async function checksumObject(physical: string) {
        const memory = checksumState.cache.get(physical);
        if (memory) return memory;
        const running = checksumState.jobs.get(physical);
        if (running) return waitForChecksum(running);
        const cached = (await checksums.findOne({ _id: physical }))?.sha256;
        if (typeof cached === 'string' && /^[a-f0-9]{64}$/.test(cached)) { rememberChecksum(physical, cached); return cached; }
        // Another caller can start/finish the same object during the DB read.
        const completed = checksumState.cache.get(physical), duplicate = checksumState.jobs.get(physical);
        if (completed) return completed;
        if (duplicate) return waitForChecksum(duplicate);
        if ((checksumState.retryAfter.get(physical) || 0) > Date.now() || checksumState.jobs.size >= 2) throw new BadRequestError('file checksum pending');
        let expired = false, stream: Readable | undefined;
        const timer = setTimeout(() => { expired = true; stream?.destroy(); }, 300_000); timer.unref();
        const job = (async () => {
            try {
                stream = await StorageModel.get(physical);
                if (expired) { stream.destroy(); throw new Error('checksum read timed out'); }
                const sum = createHash('sha256');
                for await (const chunk of stream) sum.update(chunk);
                if (expired) throw new Error('checksum read timed out');
                const result = sum.digest('hex');
                await checksums.updateOne({ _id: physical }, { $set: { sha256: result } }, { upsert: true });
                rememberChecksum(physical, result);
                checksumState.retryAfter.delete(physical);
                return result;
            } finally { clearTimeout(timer); }
        })();
        // Keep the slot until the actual I/O settles, even if obtaining the
        // response headers hangs: StorageModel.get exposes no cancellation.
        // Thus repeated callers/reloads cannot create an unbounded read queue.
        checksumState.jobs.set(physical, job);
        void job.catch(() => {
            if (checksumState.retryAfter.size >= 2048) checksumState.retryAfter.delete(checksumState.retryAfter.keys().next().value!);
            checksumState.retryAfter.set(physical, Date.now() + 30_000);
        }).finally(() => { if (checksumState.jobs.get(physical) === job) checksumState.jobs.delete(physical); });
        return waitForChecksum(job);
    }
    async function fileMatches(path: string, f: any) { const meta = await StorageModel.getMeta(path); return !!meta && meta.size === f.size && await checksumPath(path) === f.sha256; }
    async function downloadFile(target: string, body: any) {
        const id = Number(body.id);
        if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestError('problem id');
        const area = areaPath(body.area), name = fileName(body.name);
        if (!area) throw new BadRequestError('file area');
        const p = await ProblemModel.get(target, id, ['data', 'additional_file'], true);
        const files = body.area === 'data' ? p?.data : p?.additional_file;
        if (!files?.some(f => f.name === name)) throw new NotFoundError('file revision');
        const path = `problem/${target}/${id}/${area}/${name}`;
        if (!body.sha256) return { url: await StorageModel.signDownloadLink(path, name, false, 'user') };

        // Pin the same immutable object for hashing and signing. A concurrent
        // replacement of the logical filename cannot substitute new bytes.
        const object = await StorageModel.coll.findOneAndUpdate(
            { path, autoDelete: null }, { $set: { lastUsage: new Date() } },
            { projection: { _id: 1, link: 1 } },
        );
        if (!object) throw new NotFoundError('file revision');
        const physical = String(object.link || object._id);
        if (await checksumObject(physical) !== body.sha256) throw new NotFoundError('file revision');
        return { url: await StorageModel.signDownloadLink(physical, name, false, 'user') };
    }
    async function metadata(p: any) {
        const files = async (items: any[], area: string) => {
            const result: Array<{ name: string; size: number; sha256: string }> = [];
            for (const f of items || []) result.push({ name: f.name, size: f.size || 0, sha256: await checksumPath(`problem/${selectedDomain()}/${p.docId}/${area}/${f.name}`) });
            return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        };
        return { id: String(p.docId), sourceId: String(p._id), syncId: p.proctorSyncId || null, title: p.title, content: p.content || '', html: !!p.html,
            config: p.config || '', tags: p.tag || [], difficulty: p.difficulty || 0, hidden: !!p.hidden, data: await files(p.data, 'testdata'), files: await files(p.additional_file, 'additional_file') };
    }
    function payload(p: any) { const { id, sourceId, syncId, ...value } = p; return value; }
    // Compare file sets independently of the locale/order used by an already
    // queued legacy snapshot, without rewriting that snapshot's version/hash.
    function comparablePayload(p: any) {
        const value = payload(p), order = (a: any, b: any) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        return { ...value, data: [...(value.data || [])].sort(order), files: [...(value.files || [])].sort(order) };
    }
    function sameSource(p: any, sourceId: unknown) { if (!sourceId || String(p._id) !== sourceId) throw new BadRequestError('problem source changed'); }
    const syncCondition = (p: any) => ({ _id: p._id, domainId: selectedDomain(), proctorSyncId: p.proctorSyncId || null, proctorSyncTransfer: p.proctorSyncTransfer || null });
    async function setSyncState(p: any, fields: any, expected: Record<string, unknown> = {}) {
        const changed = await documents.updateOne({ ...syncCondition(p), ...expected }, { $set: fields });
        if (!changed.matchedCount) throw new BadRequestError('transfer state changed');
        Object.assign(p, fields);
    }
    const sameTransfer = (p: any, body: any) => p.proctorSyncTransfer?.hash === body.hash && p.proctorSyncTransfer.revision === body.revision && p.proctorSyncTransfer.writer === body.writer;
    function syncVersion(body: any) {
        if (typeof body.syncId !== 'string' || !/^[a-zA-Z0-9_-]{1,191}$/.test(body.syncId) || !Number.isSafeInteger(body.revision) || body.revision < 1 || body.revision > 2147483647 || typeof body.writer !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.writer)) throw new BadRequestError('sync version');
    }
    async function locked<T>(work: (check: () => Promise<void>) => Promise<T>, waitUntil = 0) {
        const target = selectedDomain(), key = `bank:${target}`, token = randomUUID();
        let lost = false;
        for (;;) {
            try {
                const lock = await locks.findOneAndUpdate({ _id: key, $or: [{ until: { $lt: new Date() } }, { until: null }] }, { $set: { token, ownerHost: lockHost, ownerScope: lockScope, ownerPid: process.pid, until: new Date(Date.now() + 900_000) } }, { upsert: true, returnDocument: 'after' });
                if (lock?.token !== token) throw new Error('busy');
                break;
            } catch (error) {
                const busy = (error as {code?:number})?.code === 11000 || (error as Error)?.message === 'busy';
                if (busy) {
                    const previous = await locks.findOne({ _id: key });
                    // Only reclaim a proven dead process in this host's PID
                    // namespace. Live, remote, legacy and reused PIDs retain
                    // their lease; a hot reload cannot steal an active lock.
                    if (lockScope && previous?.ownerHost === lockHost && previous.ownerScope === lockScope && Number.isSafeInteger(previous.ownerPid) && previous.ownerPid > 0 && previous.ownerPid !== process.pid) {
                        let dead = false;
                        try { process.kill(previous.ownerPid, 0); } catch (probe) { dead = (probe as NodeJS.ErrnoException).code === 'ESRCH'; }
                        if (dead) {
                            const removed = await locks.deleteOne({ _id: key, token: previous.token, ownerHost: lockHost, ownerScope: lockScope, ownerPid: previous.ownerPid, until: previous.until });
                            if (removed.deletedCount) continue;
                        }
                    }
                }
                if (!busy || Date.now() >= waitUntil) throw new BadRequestError('bank synchronization busy');
                await new Promise(resolve => setTimeout(resolve, Math.min(waitUntil - Date.now(), 100 + Math.floor(Math.random() * 150))));
            }
        }
        const check = async () => { if (lost || !await locks.findOne({ _id: key, token, until: { $gt: new Date() } })) throw new BadRequestError('bank synchronization lease expired'); };
        let renewing = false;
        const timer = setInterval(() => {
            if (renewing || lost) return;
            renewing = true;
            void locks.updateOne({ _id: key, token, until: { $gt: new Date() } }, { $set: { until: new Date(Date.now() + 900_000) } })
                .then((r: any) => { if (!r.matchedCount) lost = true; }).catch(() => { lost = true; })
                .finally(() => { renewing = false; });
        }, 20_000); timer.unref();
        const lease: MutationLease = { domain: target, active: true, check };
        try { return await domainContext.run(target, () => mutationContext.run(lease, () => work(check))); }
        finally { lease.active = false; clearInterval(timer); await locks.deleteOne({ _id: key, token }); }
    }
    async function queuedWrite<T>(target: string, waitMs: number, work: (check: () => Promise<void>) => Promise<T>) {
        const waiting = nativeWaiters.get(target) || 0;
        if (waiting >= 64) throw new BadRequestError('bank synchronization busy');
        nativeWaiters.set(target, waiting + 1);
        try {
            return await domainContext.run(target, () => locked(work, Date.now() + waitMs));
        } finally {
            const remaining = (nativeWaiters.get(target) || 1) - 1;
            if (remaining) nativeWaiters.set(target, remaining);
            else nativeWaiters.delete(target);
        }
    }
    // Ordinary Hydro editors/file handlers do not take the synchronization
    // lease themselves. Serialize their writes too; a manifest check alone
    // cannot prevent a native upload between checking and replacing live files.
    ctx.effect(() => {
        const model = ProblemModel as unknown as Record<string, (...args: any[]) => any>;
        const restore: Array<() => void> = [];
        let enabled = true;
        for (const name of ['add', 'addWithId', 'edit', 'del', 'addTestdata', 'renameTestdata', 'delTestdata', 'addAdditionalFile', 'renameAdditionalFile', 'delAdditionalFile']) {
            const original = model[name];
            if (typeof original !== 'function') continue;
            const wrapped = async function (this: unknown, ...args: any[]) {
                const target = args[0];
                if (!enabled || target !== domain()) return Reflect.apply(original, this, args);
                const active = mutationContext.getStore();
                if (active?.active && active.domain === target) { await active.check(); return Reflect.apply(original, this, args); }
                // A normal multi-file upload can start several model writes at
                // once. Give these a bounded opportunity to acquire the lease
                // rather than rejecting all but its first file immediately.
                return queuedWrite(target, 10_000, async check => {
                    await check();
                    if ((name.includes('Testdata') || name.includes('AdditionalFile')) && !await ProblemModel.get(target, args[1], ['_id'] as any, true)) {
                        throw new NotFoundError('problem');
                    }
                    if (!['add', 'addWithId'].includes(name) && await documents.findOne({ domainId: target, docId: args[1],
                        $or: [{ proctorCreatePending: true }, { proctorSyncPending: true, $or: [{ proctorSyncSnapshot: null }, { 'proctorSyncTransfer.applying': true }] }] }, { projection: { _id: 1 } })) {
                        // An unfinished transfer may expose no preimage or a
                        // mixed file set. Wait for recovery before editing it.
                        throw new BadRequestError('problem transfer awaits recovery or acknowledgement');
                    }
                    const result = await Reflect.apply(original, this, args);
                    await check(); return result;
                });
            };
            model[name] = wrapped;
            restore.push(() => { if (model[name] === wrapped) model[name] = original; });
        }
        return () => { enabled = false; for (const undo of restore.reverse()) undo(); };
    });
    class BankHandler extends Handler {
        noCheckPermView = true;
        async post() {
            const body = this.request.body || {}; authorize(this, body); await ensureDomain();
            // A verified download can run while the bank catalog is scanned.
            if (body.action === 'file' && typeof body.sha256 === 'string' && /^[a-f0-9]{64}$/.test(body.sha256)) {
                this.response.body = { ok: true, data: await downloadFile(selectedDomain(), body) };
                return;
            }
            this.response.body = { ok: true, data: await locked(async check => {
                const target = selectedDomain();
                if (body.action === 'file') return downloadFile(target, body);
                if (body.action === 'create-step') {
                    if (body.domain !== target) throw new BadRequestError('题库域与系统设置不一致，请检查评测服务配置');
                    if (typeof body.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(body.requestId)) throw new BadRequestError('创建请求编号无效');
                    const key = `create:${target}:${body.requestId}`;
                    let record = await creations.findOne({ _id: key });
                    if (body.expectedSourceId && (!record || record.sourceId !== body.expectedSourceId || String(record.docId) !== body.expectedId)) throw new BadRequestError('原创建记录或原题身份已改变，请检查评测服务数据库是否已替换');
                    const draft = body.draft === undefined ? record?.draft : body.draft;
                    if (Buffer.byteLength(JSON.stringify(draft ?? null)) > 6 * 1024 * 1024) throw new BadRequestError('题目及测试数据总量不能超过 6 MiB');
                    const issues = validateProblemDraft(draft);
                    if (issues.length) throw new BadRequestError(issues[0].message);
                    const compiled = compileProblemDraft(draft as ProblemDraft), requestHash = hash(draft);
                    if (record && record.hash !== requestHash) throw new BadRequestError('本次创建内容已固定，请使用原内容继续保存');
                    if (!record) {
                        record = { _id: key, hash: requestHash, draft, state: 'pending', createdAt: new Date() };
                        await check(); await creations.insertOne(record);
                    }
                    const fields = [...projection, 'proctorCreateId', 'proctorCreateHash', 'proctorCreatePending', 'proctorCreateCompleted'] as any;
                    let p: any = record.docId ? await ProblemModel.get(target, record.docId, fields, true)
                        : (await ProblemModel.getMulti(target, { proctorCreateId: body.requestId } as any, fields).limit(1).toArray())[0];
                    if (!p && (record.docId || record.state === 'complete')) throw new BadRequestError('本次已创建的原题已被删除，不能通过重试重新创建');
                    if (!p) {
                        const id = await authoringCreation.run({ domain: target, id: body.requestId, hash: requestHash }, () =>
                            ProblemModel.add(target, '', compiled.title, compiled.content, 1, [], { hidden: true }));
                        p = await ProblemModel.get(target, id, fields, true);
                    }
                    if (!p || p.proctorCreateId !== body.requestId || p.proctorCreateHash !== requestHash || (record.sourceId && record.sourceId !== String(p._id))) throw new BadRequestError('创建记录与原题身份不一致，请核对题库');
                    await check();
                    await creations.updateOne({ _id: key, hash: requestHash }, { $set: { docId: p.docId, sourceId: String(p._id), updatedAt: new Date() } });
                    // The atomic completion marker survives a crash before the
                    // ledger acknowledgement, and must never replay later edits.
                    if (p.proctorCreateCompleted === requestHash && !p.proctorCreatePending) {
                        await creations.updateOne({ _id: key, hash: requestHash }, { $set: { state: 'complete' } });
                        return { complete: true, id: String(p.docId), sourceId: String(p._id), domain: target, total: compiled.total };
                    }
                    if (!p.proctorCreatePending) throw new BadRequestError('题目创建状态异常，请核对恢复记录');
                    let written = 0, ready = Number.isSafeInteger(record.ready) && record.ready >= 0 && record.ready <= compiled.files.length ? record.ready : 0;
                    let verified = Number.isSafeInteger(record.verified) && record.verified >= 0 && record.verified <= compiled.files.length ? record.verified : 0;
                    const pending = () => ({ complete: false, id: String(p.docId), sourceId: String(p._id), ready, verified, files: compiled.files.length });
                    const registered = new Set((p.data || []).map((file: any) => file.name));
                    const unfinished = compiled.files.slice(0, ready).findIndex(file => !registered.has(file.name) || (file.name === 'config.yaml' && p.config !== compiled.configText));
                    if (unfinished >= 0) {
                        ready = unfinished; verified = Math.min(verified, ready);
                        await creations.updateOne({ _id: key, hash: requestHash }, { $set: { ready, verified } });
                    }
                    const prepareUntil = Date.now() + 10_000;
                    let inspected = 0;
                    for (const file of compiled.files.slice(ready)) {
                        // Legacy/restored ledgers may lag many already-present
                        // files. Bound reuse checks as well as actual uploads.
                        if (inspected++ >= 16 || Date.now() >= prepareUntil) return pending();
                        const bytes = Buffer.from(file.content, 'utf8'), sha256 = createHash('sha256').update(bytes).digest('hex');
                        const path = `problem/${target}/${p.docId}/testdata/${file.name}`;
                        if (!registered.has(file.name) || (file.name === 'config.yaml' && p.config !== compiled.configText) || !await fileMatches(path, { size: bytes.length, sha256 })) {
                            if (written >= 2) return pending();
                            if (verified > ready) {
                                verified = ready;
                                await creations.updateOne({ _id: key, hash: requestHash }, { $min: { verified } });
                            }
                            await check(); await ProblemModel.addTestdata(target, p.docId, file.name, bytes);
                            const object = await StorageModel.coll.findOne({ path, autoDelete: null }, { projection: { _id: 1, link: 1 } });
                            if (!object) throw new BadRequestError('测试数据尚未保存完成，请继续重试');
                            const physical = String(object.link || object._id);
                            await checksums.updateOne({ _id: physical }, { $set: { sha256 } }, { upsert: true });
                            rememberChecksum(physical, sha256); written++;
                        }
                        ready++;
                        await creations.updateOne({ _id: key, hash: requestHash }, { $max: { ready } });
                    }
                    // Verification is resumable too. Hundreds of metadata reads
                    // in one request could otherwise exceed the bridge timeout
                    // and repeat the entire scan on every retry.
                    const verifyUntil = Date.now() + 10_000, verifyEnd = Math.min(verified + 16, compiled.files.length);
                    for (; verified < verifyEnd; verified++) {
                        if (Date.now() >= verifyUntil) break;
                        const file = compiled.files[verified];
                        const bytes = Buffer.from(file.content, 'utf8'), sha256 = createHash('sha256').update(bytes).digest('hex');
                        try {
                            if (!await fileMatches(`problem/${target}/${p.docId}/testdata/${file.name}`, { size: bytes.length, sha256 })) {
                                await creations.updateOne({ _id: key, hash: requestHash }, { $min: { ready: verified, verified } });
                                throw new BadRequestError('测试数据完整性检查未通过，请保留内容并重试');
                            }
                        } catch (error) {
                            // Preserve the successful prefix even when the next
                            // file is temporarily unreadable or hashing is pending.
                            await check();
                            await creations.updateOne({ _id: key, hash: requestHash }, { $max: { verified } });
                            throw error;
                        }
                    }
                    await check();
                    await creations.updateOne({ _id: key, hash: requestHash }, { $max: { verified } });
                    if (verified < compiled.files.length) return pending();
                    const saved: any = await ProblemModel.get(target, p.docId, fields, true);
                    if (!saved || saved.config !== compiled.configText || saved.content !== compiled.content || saved.title !== compiled.title) throw new BadRequestError('题面或评测配置尚未保存完整，请保留内容并重试');
                    // Also pass Hydro's native parser before exposing the row.
                    const parsed: any = await ProblemModel.get(target, p.docId, ProblemModel.PROJECTION_PUBLIC);
                    const authored = draft as ProblemDraft;
                    const type = authored.kind === 'objective' ? 'objective' : 'default';
                    const count = authored.kind === 'objective' ? authored.questions.length : authored.tests.length;
                    if (!matchesAuthoredProblemConfig(parsed?.config, type, count)) throw new BadRequestError('当前评测服务无法识别生成的评测配置，请检查插件版本');
                    await check();
                    const done = await documents.updateOne({ _id: p._id, domainId: target, proctorCreateId: body.requestId, proctorCreateHash: requestHash, proctorCreatePending: true },
                        { $set: { proctorCreatePending: false, proctorCreateCompleted: requestHash } });
                    if (!done.matchedCount) throw new BadRequestError('创建状态发生变化，请继续重试');
                    await creations.updateOne({ _id: key, hash: requestHash }, { $set: { state: 'complete', updatedAt: new Date() } });
                    return { complete: true, id: String(p.docId), sourceId: String(p._id), domain: target, total: compiled.total };
                }
                if (body.action === 'catalog') {
                    const after = Number(body.after || 0), limit = Number(body.limit || 20);
                    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestError('page size');
                    if (!Number.isSafeInteger(after) || after < 0) throw new BadRequestError('cursor');
                    // Mongo documents can each be megabytes. Page identities first
                    // and hold only the bounded response plus one document at a time.
                    const docs = await ProblemModel.getMulti(target, { docId: { $gt: after }, proctorCreatePending: { $ne: true } } as any, ['docId', '_id']).sort({ docId: 1 }).limit(limit).toArray();
                    const items = [], pending = [], errors = [];
                    let bytes = 0, cursor = after, processed = 0;
                    for (const ref of docs) {
                        let item: any, transfer: any, failure: { id: string; sourceId: string; message: string } | undefined;
                        let sourceId = String(ref._id);
                        try {
                            const p: any = await ProblemModel.get(target, ref.docId, projection, true);
                            if (!p) throw new NotFoundError('problem');
                            sourceId = String(p._id);
                            if (p.proctorSyncPending) {
                                // Applied transfers are acknowledged before the
                                // platform reads this page again; do not return
                                // both old and new large statements in one entry.
                                item = p.proctorSyncTransfer?.applied ? undefined : p.proctorSyncSnapshot || undefined;
                                transfer = { id: String(p.docId), sourceId: String(p._id), syncId: p.proctorSyncId, hash: p.proctorSyncTransfer?.hash, applied: p.proctorSyncTransfer?.applied,
                                    item: p.proctorSyncTransfer?.applied ? { id: p.proctorSyncId, scope: 'bank', kind: 'BANK', deleted: false, hash: p.proctorSyncTransfer.hash, revision: p.proctorSyncTransfer.revision, writer: p.proctorSyncTransfer.writer, payload: p.proctorSyncTransfer.value } : undefined };
                            } else item = await metadata(p);
                            if (Buffer.byteLength(JSON.stringify({ item, transfer })) > 16 * 1024 * 1024 - 4096) throw new BadRequestError('problem synchronization metadata too large');
                        } catch (error) {
                            // Older callers must still fail the catalog; silently
                            // omitting a problem would look like an authorized delete.
                            if (body.tolerateErrors !== true) throw error;
                            item = transfer = undefined;
                            failure = { id: String(ref.docId), sourceId, message: '题目或文件暂不可读取，已保留原题等待重试' };
                        }
                        const size = Buffer.byteLength(JSON.stringify({ item, transfer, failure }));
                        if (processed && bytes + size > 16 * 1024 * 1024 - 4096) break;
                        if (item) items.push(item);
                        if (transfer) pending.push(transfer);
                        if (failure) errors.push(failure);
                        bytes += size; cursor = ref.docId; processed++;
                    }
                    return { domain: target, items, pending, errors, after: processed < docs.length || docs.length === limit ? cursor : null };
                }
                if (body.action === 'prepare') {
                    syncVersion(body);
                    if (!/^[a-f0-9]{64}$/.test(body.hash)) throw new BadRequestError('sync hash');
                    manifest(body.value);
                    if (hash({ payload: body.value, deleted: false }) !== body.hash) throw new BadRequestError('manifest checksum');
                    let p = (await ProblemModel.getMulti(target, { proctorSyncId: body.syncId } as any, projection).limit(1).toArray())[0] as any;
                    if (!p && body.id) p = await ProblemModel.get(target, Number(body.id), projection, true);
                    if (p && body.id) { if (String(p.docId) !== String(body.id)) throw new BadRequestError('problem mapping changed'); sameSource(p, body.sourceId); }
                    if (p?.proctorSyncId && p.proctorSyncId !== body.syncId) throw new BadRequestError('problem already mapped');
                    const previous = p?.proctorSyncTransfer;
                    if (previous?.conflict) throw new BadRequestError('bank transfer conflict requires recovery');
                    if (p?.proctorSyncPending && previous?.applied && previous.hash !== body.hash) throw new BadRequestError('previous transfer awaits platform acknowledgement');
                    if (previous && (previous.revision > body.revision || (previous.revision === body.revision && previous.writer > body.writer))) throw new BadRequestError('stale transfer');
                    if (previous && previous.revision === body.revision && previous.writer === body.writer && previous.hash !== body.hash) throw new BadRequestError('conflicting transfer');
                    if (!p) {
                        const id = await creation.run({ domain: target, syncId: body.syncId }, () => ProblemModel.add(target, '', String(body.value.title), '', 1, [], { hidden: true }));
                        p = await ProblemModel.get(target, id, projection, true);
                    }
                    const current = p.proctorSyncPending ? p.proctorSyncSnapshot : await metadata(p);
                    // A local edit since capture wins a new logical revision on the next scan.
                    if (!p.proctorSyncPending && body.expectedHash && hash({ payload: payload(current), deleted: false }) !== body.expectedHash) throw new BadRequestError('local problem changed');
                    const same = previous?.hash === body.hash;
                    // An old applied marker describes its old transfer, not the
                    // current live problem after a later native edit (A -> B -> A).
                    const applied = same && previous.applied === true
                        && hash(comparablePayload(await metadata(p))) === hash(comparablePayload(body.value));
                    if (p.proctorSyncPending && previous?.applied && !applied) throw new BadRequestError('applied transfer has local changes awaiting platform acknowledgement');
                    const reuse = same && (!previous.applied || applied);
                    const expected = applied ? Object.fromEntries(['title','content','html','tag','difficulty','hidden','config','data','additional_file']
                        .map(key => [key, p[key] === undefined ? { $exists: false } : p[key]])) : {};
                    await check();
                    await setSyncState(p, { proctorSyncId: body.syncId, proctorSyncPending: true, proctorSyncSnapshot: current,
                        proctorSyncTransfer: reuse ? { ...previous, revision: body.revision, writer: body.writer } : { hash: body.hash, revision: body.revision, writer: body.writer, value: body.value, applied: false } }, expected);
                    if (applied) return { id: String(p.docId), sourceId: String(p._id), missing: [], applied: true };
                    const missing = [];
                    for (const area of ['data', 'files']) for (const f of body.value[area]) {
                        const stage = stagePath(body.syncId, area, f);
                        if (await fileMatches(stage, f)) continue;
                        const live = `problem/${target}/${p.docId}/${areaPath(area)}/${f.name}`;
                        if (await fileMatches(live, f)) { await check(); await StorageModel.copy(live, stage); } else missing.push({ area, name: f.name });
                    }
                    return { id: String(p.docId), sourceId: String(p._id), missing, applied };
                }
                if (['delete', 'apply', 'ack'].includes(body.action)) syncVersion(body);
                const pendingDelete = body.action === 'delete' && !body.id ? (await ProblemModel.getMulti(target, { proctorSyncId: body.syncId } as any, projection).limit(1).toArray())[0] as any : null;
                if (body.action === 'delete' && !body.id && !pendingDelete) return { deleted: true };
                const id = pendingDelete?.docId || Number(body.id);
                if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestError('problem id');
                const p: any = await ProblemModel.get(target, id, projection, true);
                if (!p && body.action === 'delete') return { deleted: true };
                if (!p) throw new NotFoundError('problem');
                if (body.action === 'delete') {
                    if (!pendingDelete) sameSource(p, body.sourceId);
                    const version = p.proctorSyncTransfer;
                    if (version && (version.revision > body.revision || (version.revision === body.revision && version.writer > body.writer))) throw new BadRequestError('stale deletion');
                    if (p.proctorSyncId && p.proctorSyncId !== body.syncId) throw new BadRequestError('problem mapping');
                    const current = await metadata(p);
                    if (body.expectedHash && hash({ payload: payload(current), deleted: false }) !== body.expectedHash) throw new BadRequestError('local problem changed');
                    await check(); await ProblemModel.del(target, id); return { deleted: true };
                }
                if (body.action === 'ack') {
                    if (p.proctorSyncId !== body.syncId || !sameTransfer(p, body)) return { acknowledged: false };
                    if (!p.proctorSyncTransfer.applied) throw new BadRequestError('transfer incomplete');
                    await check(); await setSyncState(p, { proctorSyncPending: false, proctorSyncSnapshot: null }); return { acknowledged: true };
                }
                if (p.proctorSyncId !== body.syncId || !sameTransfer(p, body)) throw new BadRequestError('transfer version changed');
                if (body.action === 'apply') {
                    const transfer = p.proctorSyncTransfer, value = transfer.value; manifest(value);
                    if (transfer.conflict) throw new BadRequestError('bank transfer conflict requires recovery');
                    if (transfer.applied) return metadata(p);
                    // Validate the entire immutable file set before touching any live file.
                    for (const area of ['data', 'files']) for (const f of value[area]) if (!await fileMatches(stagePath(body.syncId, area, f), f)) throw new BadRequestError('transfer incomplete');
                    const snapshot = p.proctorSyncSnapshot;
                    if (snapshot && !transfer.applying && hash(comparablePayload(await metadata(p))) !== hash(comparablePayload(snapshot))) {
                        await check();
                        await setSyncState(p, { proctorSyncPending: false, proctorSyncSnapshot: null, proctorSyncTransfer: { ...transfer, conflict: true } });
                        throw new BadRequestError('local problem changed during transfer');
                    }
                    await check();
                    await setSyncState(p, { proctorSyncTransfer: { ...transfer, applying: true } });
                    // Keep an immutable recovery copy of the replaced file set.
                    if (snapshot) for (const area of ['data', 'files']) for (const f of snapshot[area]) {
                        const backup = `proctor-sync-backup/${target}/${body.syncId}/${hash(payload(snapshot))}/${area}/${f.name}`;
                        if (!await StorageModel.exists(backup)) { const live = `problem/${target}/${id}/${areaPath(area)}/${f.name}`; if (!await fileMatches(live, f)) throw new BadRequestError('original backup incomplete'); await check(); await StorageModel.copy(live, backup); }
                    }
                    if (snapshot) await (db.collection('proctor.sync.backups') as any).updateOne({ _id: `${target}:${body.syncId}:${hash(payload(snapshot))}` }, { $setOnInsert: { snapshot, createdAt: new Date() } }, { upsert: true });
                    for (const area of ['data', 'files']) for (const f of value[area]) {
                        await check();
                        const path = `problem/${target}/${id}/${areaPath(area)}/${f.name}`;
                        if (await fileMatches(path, f)) continue;
                        const source = await StorageModel.get(stagePath(body.syncId, area, f));
                        if (area === 'data') await ProblemModel.addTestdata(target, id, f.name, source); else await ProblemModel.addAdditionalFile(target, id, f.name, source);
                    }
                    const fresh: any = await ProblemModel.get(target, id, projection, true);
                    await check();
                    await ProblemModel.delTestdata(target, id, (fresh.data || []).filter((f: any) => !value.data.some((v: any) => v.name === f.name)).map((f: any) => f.name));
                    await ProblemModel.delAdditionalFile(target, id, (fresh.additional_file || []).filter((f: any) => !value.files.some((v: any) => v.name === f.name)).map((f: any) => f.name));
                    const unchanged = Object.fromEntries(['title','content','html','tag','difficulty','hidden','config'].map(k => [k, p[k] === undefined ? { $exists: false } : p[k]]));
                    unchanged.config = { $in: [p.config ?? null, typeof value.config === 'string' ? value.config : JSON.stringify(value.config || {})] };
                    const written = await documents.updateOne({ ...syncCondition(p), ...unchanged }, { $set: {
                        title: value.title, content: value.content, html: !!value.html, tag: value.tags || [], difficulty: Number(value.difficulty || 0), hidden: !!value.hidden,
                        config: typeof value.config === 'string' ? value.config : JSON.stringify(value.config || {}), proctorSyncTransfer: { ...transfer, applied: true },
                    } });
                    if (!written.matchedCount) {
                        const conflict = await ProblemModel.get(target, id, projection, true);
                        await (db.collection('proctor.sync.backups') as any).updateOne({ _id: `${target}:${body.syncId}:conflict:${body.hash}` }, { $setOnInsert: { snapshot: conflict, createdAt: new Date() } }, { upsert: true });
                        await setSyncState(p, { proctorSyncTransfer: { ...transfer, applying: true, conflict: true } });
                        throw new BadRequestError('local problem changed during apply; recovery backup retained');
                    }
                    // Emit Hydro's ordinary edit event after the conditional metadata commit.
                    await ctx.parallel('problem/edit', (await ProblemModel.get(target, id, projection, true))!);
                    return metadata(await ProblemModel.get(target, id, projection, true));
                }
                throw new BadRequestError('action');
            }) };
        }
    }
    class BankUploadHandler extends Handler {
        noCheckPermView = true;
        async post() {
            const body = this.request.body || {}; authorize(this, body); await ensureDomain();
            // A short catalog/write overlap should not abort a whole file batch.
            this.response.body = { ok: true, data: await queuedWrite(selectedDomain(), 2_000, async check => {
                const id = Number(body.id), p: any = Number.isSafeInteger(id) && id > 0 && await ProblemModel.get(selectedDomain(), id, projection, true);
                if (!p || p.proctorSyncId !== body.syncId || p.proctorSyncTransfer?.hash !== body.hash || p.proctorSyncTransfer.applied) throw new BadRequestError('transfer version changed');
                const name = fileName(body.name), area = String(body.area), f = p.proctorSyncTransfer.value[area]?.find((f: any) => f.name === name);
                if (!areaPath(area) || !f || !this.request.files?.file) throw new BadRequestError('file');
                const path = stagePath(body.syncId, area, f), source = this.request.files.file.filepath;
                const sum = createHash('sha256'); let size = 0;
                for await (const chunk of createReadStream(source)) { size += chunk.length; sum.update(chunk); }
                if (size !== f.size || sum.digest('hex') !== f.sha256) throw new BadRequestError('file checksum');
                await check();
                if (!await fileMatches(path, f)) {
                    await StorageModel.put(path, source);
                    // These bytes were already hashed before put(). Copies
                    // retain the same immutable physical object, so apply()
                    // need not download the newly uploaded file to hash again.
                    const object = await StorageModel.coll.findOne({ path, autoDelete: null }, { projection: { _id: 1, link: 1 } });
                    if (object) {
                        const physical = String(object.link || object._id);
                        await checksums.updateOne({ _id: physical }, { $set: { sha256: f.sha256 } }, { upsert: true });
                        rememberChecksum(physical, f.sha256);
                    }
                }
                return { uploaded: true };
            }) };
        }
    }
    ctx.Route('cwnupaa_proctor_problem_bank', '/api/proctor/problem-bank', BankHandler);
    ctx.Route('cwnupaa_proctor_problem_bank_upload', '/api/proctor/problem-bank/upload', BankUploadHandler);
}
