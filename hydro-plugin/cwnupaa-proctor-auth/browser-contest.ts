import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
    BadRequestError, ConnectionHandler, ContestModel, ContestScoreboardHiddenError, Context, CreateError, db, ForbiddenError, Handler,
    NotFoundError, ObjectId, param, PERM, PermissionError, PRIV, RecordModel, TokenModel, Types, UserModel,
} from 'hydrooj';

const proofHeader = 'x-hydro-proctor-key';
const socketCookie = 'proctor_ws';
const httpCookie = 'proctor_http';
const socketPaths = ['/record-conn', '/record-detail-conn', '/websocket'] as const;
type SocketPath = typeof socketPaths[number];
type SocketProofs = Record<SocketPath, string>;
interface SocketLease {
    origin: string;
    domainId: string;
    contestId: string;
    expiresAt: Date;
    proofs: SocketProofs;
    previous?: { proofs: SocketProofs; expiresAt: Date };
}
interface HttpProofs { proofs: Record<string, string>; expiresAt: Date }
interface HttpLease extends HttpProofs {
    origin: string;
    domainId: string;
    basePath: string;
    contestId: string;
    bindingHash: string;
    previous?: HttpProofs;
}

const socketLeaseSeconds = 90;
const socketRenewalOverlapMs = 5_000;
const ProctorBrowserRequiredError = CreateError('ProctorBrowserRequiredError', ForbiddenError, '比赛进行期间请使用监考客户端进入 HydroOJ。');
declare module 'hydrooj' {
    interface Collections {
        'cwnupaa.proctor.browser.contest': { _id: string; enabledAt: Date };
        'cwnupaa.proctor.browser.binding': { _id: string; sid: string; hash: string; socketLease?: SocketLease; httpLease?: HttpLease };
        'cwnupaa.proctor.browser.account': { _id: string; uid: number; domainId: string; tid: ObjectId; examId: string; endAt: Date };
    }
}

const protectedContests = db.collection('cwnupaa.proctor.browser.contest');
const bindings = db.collection('cwnupaa.proctor.browser.binding');
const accounts = db.collection('cwnupaa.proctor.browser.account');
const objectId = /^[a-f\d]{24}$/i;
const packedProof = /^[A-Za-z\d_-]{43}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const contestKey = (domainId: string, tid: ObjectId) => `${domainId}/${tid.toHexString()}`;
// The lease can renew without dropping an open socket. A replacement browser
// binding always revokes the socket, even if the Hydro session ID is reused.
const verifiedSockets = new WeakMap<ConnectionHandler, { key: string; hash: string }>();
const verifiedHttp = new WeakMap<Handler, string>();

function examWindow(body: Record<string, unknown>, contest: { endAt: Date }) {
    if (typeof body.examId !== 'string' || !/^[\w-]{1,128}$/.test(body.examId)
        || typeof body.endAt !== 'string' || !Number.isFinite(Date.parse(body.endAt))) throw new BadRequestError('examId/endAt');
    return { examId: body.examId, endAt: new Date(Math.min(Date.parse(body.endAt), +contest.endAt)) };
}

function validDigest(expected: string | undefined, computed: string) {
    return Boolean(expected && /^[a-f\d]{64}$/i.test(expected)
        && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(computed, 'hex')));
}

function browserSession(handler: Handler | ConnectionHandler) {
    const sid = handler.session._id;
    return handler.user._id && typeof sid === 'string' && handler.context.cookies.get('sid') === sid ? sid : null;
}

async function browserBinding(handler: Handler | ConnectionHandler, key: string) {
    const sid = browserSession(handler);
    const proof = handler.request.headers[proofHeader];
    if (!sid || typeof proof !== 'string' || !packedProof.test(proof)) return null;
    const binding = await bindings.findOne({ _id: `${key}/${handler.user._id}`, sid });
    return binding && validDigest(binding.hash, hash(proof)) ? binding : null;
}

function requestOrigin(handler: Handler | ConnectionHandler) {
    const origin = handler.request.headers.origin;
    if (typeof origin !== 'string') return null;
    try {
        const parsed = new URL(origin);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) return null;
        // Hydro's host field already applies its configured reverse proxy header.
        const host = new URL(`${parsed.protocol}//${handler.request.host}`);
        return host.href === `${origin}/` ? origin : null;
    } catch {
        return null;
    }
}

async function sessionIsCurrent(sid: string, uid: number) {
    const session = await TokenModel.get(sid, TokenModel.TYPE_SESSION);
    return session?.uid === uid && +session.expireAt > Date.now();
}

async function socketMatchesContest(connection: ConnectionHandler, path: SocketPath, lease: SocketLease) {
    const query = connection.request.query;
    const { domainId, tid, rid } = query;
    if (['all', 'allDomain', 'sid'].some(name => Object.hasOwn(query, name))
        || (domainId !== undefined && domainId !== lease.domainId)
        || (tid !== undefined && tid !== lease.contestId)) return false;
    if (path === '/websocket') return true;
    if (connection.args.domainId !== lease.domainId) return false;
    if (path === '/record-conn') return tid === lease.contestId;
    if (typeof rid !== 'string' || !/^[a-f\d]{24}$/.test(rid)) return false;
    const record = await RecordModel.get(lease.domainId, new ObjectId(rid));
    return String(record?.contest) === lease.contestId;
}

async function validSocketProof(connection: ConnectionHandler, key: string) {
    const sid = browserSession(connection);
    const path = socketPaths.find(value => value === (connection.request.originalPath || connection.request.path));
    const origin = requestOrigin(connection);
    const cookie = connection.context.cookies.get(socketCookie);
    const established = verifiedSockets.get(connection);
    const digest = typeof cookie === 'string' && packedProof.test(cookie) ? hash(cookie) : null;
    if (!sid || !path || !origin || (established && established.key !== key)) return false;
    if (!established && !digest) return false;
    const bindingId = `${key}/${connection.user._id}`;
    const binding = await bindings.findOne({ _id: bindingId, sid });
    const lease = binding?.socketLease;
    const now = Date.now();
    if (!binding || !lease || lease.origin !== origin || +lease.expiresAt <= now) return false;
    if (established) {
        return established.hash === binding.hash && sessionIsCurrent(sid, connection.user._id);
    }
    if (!digest) return false;
    if (!validDigest(lease.proofs[path], digest)
        && (!lease.previous || +lease.previous.expiresAt <= now || !validDigest(lease.previous.proofs[path], digest))) return false;
    if (!await socketMatchesContest(connection, path, lease) || !await sessionIsCurrent(sid, connection.user._id)) return false;
    verifiedSockets.set(connection, { key, hash: binding.hash });
    return true;
}

function requestUsesHttps(handler: Handler) {
    return handler.context.request.secure === true;
}

function httpPaths(basePath: string, contestId: string) {
    return [`${basePath}/contest/${contestId}`, `${basePath}/p`, `${basePath}/record`, '/resource', '/fs'];
}

function requestHttpScope(handler: Handler, lease: HttpLease): { path: string; recordId?: string } | null {
    const { headers, method, query, body } = handler.request;
    const isRead = method === 'get' || method === 'head';
    // Browser cookies are sent automatically. Enforce the expected host and
    // request origin, including same-origin checks for state-changing actions.
    if (!requestUsesHttps(handler) || requestOriginForHost(handler) !== lease.origin
        || (headers.origin !== undefined && headers.origin !== lease.origin)
        || (headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(headers['sec-fetch-site'])))
        || (!isRead && headers.origin !== lease.origin && headers['sec-fetch-site'] !== 'same-origin')) return null;

    const [contest, problem, record, resource, file] = httpPaths(lease.basePath, lease.contestId);
    let path = handler.request.originalPath || handler.request.path;
    if (isRead && (path.startsWith(resource + '/') || path.startsWith(file + '/'))) {
        if (headers['sec-fetch-mode'] === 'navigate' && !path.startsWith(file + '/')) return null;
        return { path: path.startsWith(resource + '/') ? resource : file };
    }

    const domainQuery = lease.basePath ? lease.domainId : 'system';
    if (handler.domain._id !== lease.domainId || [query, body].some(params => params && (
        ['all', 'allDomain', 'sid'].some(name => Object.hasOwn(params, name))
        || (params.domainId !== undefined && params.domainId !== domainQuery)
        || (params.tid !== undefined && params.tid !== lease.contestId)))) return null;
    if (lease.domainId === 'system') {
        // Match the cookie proof against the same path used at issuance.
        if (!lease.basePath && path.startsWith('/d/system/')) path = path.slice('/d/system'.length);
        else if (lease.basePath === '/d/system' && !path.startsWith('/d/')) path = lease.basePath + path;
    }
    if (path === contest || path === contest + '/') return { path: contest };
    const ui = contest + '/domjudge-ui';
    if (method === 'post' && path === ui) return { path: contest };
    if (isRead && path.startsWith(ui + '/') && /^(?:booklet\.pdf|samples|runs\/-?\d+\/[1-9]\d*|school-logos\/[a-f0-9]{64}\.(?:png|jpg|webp|gif|svg))$/
        .test(path.slice(ui.length + 1))) return { path: contest };
    if (path.startsWith(contest + '/') && /^\/(?:problems|print|clarification|scoreboard(?:\/[\w-]+)?|file\/(?:public|private)\/[^/]+)$/
        .test(path.slice(contest.length))) return { path: contest };
    if (query?.tid === lease.contestId && path === record) return { path: record };
    if (query?.tid === lease.contestId && path.startsWith(problem + '/') && /^\/[\w.-]+(?:\/submit|\/file\/[^/]+)?$/
        .test(path.slice(problem.length))) return { path: problem };
    if (path.startsWith(record + '/')) {
        const recordId = path.slice(record.length + 1);
        if (/^[a-f\d]{24}$/.test(recordId)) return { path: record, recordId };
    }
    return null;
}

function requestOriginForHost(handler: Handler) {
    try {
        const parsed = new URL(`https://${handler.request.host}`);
        return parsed.href === `${parsed.origin}/` ? parsed.origin : null;
    } catch { return null; }
}

function keepHttpSessionCookie(handler: Handler) {
    const cookies = handler.context.cookies;
    const setCookie = cookies.set.bind(cookies);
    // Hydro's base layer refreshes sid after the handler, sometimes without
    // HttpOnly. Keep the restricted client's native-installed cookie intact.
    cookies.set = (name, value, options) => name === 'sid' ? cookies : setCookie(name, value, options);
}

async function validHttpProof(handler: Handler, key: string) {
    if (verifiedHttp.get(handler) === key) return true;
    if (handler.request.websocket || handler.request.headers.upgrade !== undefined) return false;
    const sid = browserSession(handler);
    const cookie = handler.context.cookies.get(httpCookie);
    if (!sid || typeof cookie !== 'string' || !packedProof.test(cookie)) return false;
    const binding = await bindings.findOne({ _id: `${key}/${handler.user._id}`, sid });
    const lease = binding?.httpLease;
    const now = Date.now();
    if (!binding || !lease || lease.bindingHash !== binding.hash || +lease.expiresAt <= now) return false;
    const route = requestHttpScope(handler, lease);
    if (!route) return false;
    const digest = hash(cookie);
    if (!validDigest(lease.proofs[route.path], digest)
        && (!lease.previous || +lease.previous.expiresAt <= now || !validDigest(lease.previous.proofs[route.path], digest))) return false;
    if (route.recordId) {
        const record = await RecordModel.get(lease.domainId, new ObjectId(route.recordId));
        if (String(record?.contest) !== lease.contestId) return false;
    }
    if (!await sessionIsCurrent(sid, handler.user._id)) return false;
    verifiedHttp.set(handler, key);
    keepHttpSessionCookie(handler);
    return true;
}

async function validBrowserProof(handler: Handler | ConnectionHandler, key: string) {
    if (handler.request.headers[proofHeader] !== undefined) return Boolean(await browserBinding(handler, key));
    if (handler instanceof Handler) return validHttpProof(handler, key);
    // Hydro also creates ConnectionHandler instances for an HTTP event stream.
    // A socket cookie does not grant access to that HTTP path.
    return handler instanceof ConnectionHandler && handler.request.headers.upgrade === 'websocket'
        && validSocketProof(handler, key);
}

async function issueSocketLease(handler: Handler, domainId: string, tid: ObjectId, body: Record<string, unknown>) {
    handler.response.addHeader('Cache-Control', 'no-store');
    const origin = requestOrigin(handler);
    if (!origin) throw new ProctorBrowserRequiredError();
    const useHttpLease = body.transport === 'wkwebview';
    const contestId = tid.toHexString();
    const requestedPath = handler.request.originalPath || handler.request.path;
    const suffix = `/api/proctor/browser-contest/${contestId}`;
    const basePath = requestedPath.endsWith(suffix) ? requestedPath.slice(0, -suffix.length) : null;
    if (useHttpLease && (!requestUsesHttps(handler) || !origin.startsWith('https://') || basePath === null
        || (basePath !== '' && (!/^[\w-]+$/.test(domainId) || basePath !== `/d/${domainId}`))
        || body.basePath !== basePath || handler.domain._id !== domainId)) throw new ProctorBrowserRequiredError();
    const key = contestKey(domainId, tid);
    const binding = await browserBinding(handler, key);
    if (!binding || !await sessionIsCurrent(binding.sid, handler.user._id)) throw new ProctorBrowserRequiredError();
    const contest = await ContestModel.get(domainId, tid);
    if (!ContestModel.isOngoing(contest) || !await protectedContests.findOne({ _id: key })) throw new ProctorBrowserRequiredError();

    const now = Date.now();
    const cookies = socketPaths.map(path => ({ path, name: socketCookie, value: randomBytes(32).toString('base64url') }));
    const socketLease: SocketLease = {
        origin,
        domainId,
        contestId,
        expiresAt: new Date(now + socketLeaseSeconds * 1000),
        proofs: Object.fromEntries(cookies.map(({ path, value }) => [path, hash(value)])) as SocketProofs,
    };
    const previous = binding.socketLease;
    if (previous?.origin === origin && +previous.expiresAt > now) {
        socketLease.previous = { proofs: previous.proofs, expiresAt: new Date(Math.min(+previous.expiresAt, now + socketRenewalOverlapMs)) };
    }
    const httpCookies = !useHttpLease || basePath === null ? [] : httpPaths(basePath, contestId)
        .map(path => ({ path, name: httpCookie, value: randomBytes(32).toString('base64url') }));
    const httpLease: HttpLease | undefined = !useHttpLease || basePath === null ? undefined : {
        origin, domainId, basePath, contestId, bindingHash: binding.hash, expiresAt: socketLease.expiresAt,
        proofs: Object.fromEntries(httpCookies.map(({ path, value }) => [path, hash(value)])),
    };
    const previousHttp = binding.httpLease;
    if (httpLease && previousHttp?.origin === origin && previousHttp.basePath === httpLease.basePath
        && previousHttp.bindingHash === binding.hash && +previousHttp.expiresAt > now) {
        httpLease.previous = { proofs: previousHttp.proofs, expiresAt: new Date(Math.min(+previousHttp.expiresAt, now + socketRenewalOverlapMs)) };
    }
    // Update on the binding itself so a competing login cannot install a lease
    // for credentials that have already been superseded.
    const result = await bindings.updateOne({
        _id: binding._id, sid: binding.sid, hash: binding.hash,
        'socketLease.proofs./record-conn': previous ? previous.proofs['/record-conn'] : { $exists: false },
    }, { $set: { socketLease, ...(httpLease ? { httpLease } : {}) } });
    if (!result.matchedCount) throw new ProctorBrowserRequiredError();
    handler.response.body = { ok: true, data: { expiresInSeconds: socketLeaseSeconds, cookies, ...(httpLease ? { httpCookies } : {}) } };
}

async function requireAccountBrowser(handler: Handler | ConnectionHandler) {
    const uid = handler.user._id;
    if (!uid) return false;
    const active = await accounts.find({ uid, endAt: { $gt: new Date() } }).toArray();
    let restricted = false;
    for (const account of active) {
        // Check the live contest deadline too: ending a contest early restores access.
        const contest = await ContestModel.get(account.domainId, account.tid).catch(error => {
            if (error instanceof NotFoundError) return null;
            throw error;
        });
        if (!contest || ContestModel.isDone(contest)) continue;
        restricted = true;
        if (await validBrowserProof(handler, contestKey(account.domainId, account.tid))) return true;
    }
    if (restricted) throw new ProctorBrowserRequiredError();
    return false;
}

function domainRelativePath(handler: Handler | ConnectionHandler) {
    return handler.request.path.replace(/^\/d\/[^/]+(?=\/)/, '');
}

function inlineContestPdf(handler: Handler) {
    const { request, response } = handler;
    if (!response.redirect || request.json || request.query.noDisposition !== '1' || !/\.pdf$/i.test(request.path)
        || (!request.headers[proofHeader] && !verifiedHttp.has(handler))
        || !['document', 'iframe', 'frame'].includes(String(request.headers['sec-fetch-dest']))) return;
    // Run after Hydro authorizes the attachment and signs its storage URL. Keep
    // the frame on the contest route and let the embedded PDF consume the stream.
    const origin = handler.context.request.origin;
    const file = new URL(response.redirect, origin);
    if (file.origin !== origin || !file.pathname.startsWith('/fs/')) return;
    const src = (file.pathname + file.search).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    response.redirect = '';
    response.type = 'text/html';
    response.addHeader('Cache-Control', 'private, no-store');
    response.addHeader('Content-Security-Policy', "default-src 'none'; object-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'");
    response.body = '<!doctype html><meta charset="utf-8"><title>PDF</title>'
        + '<style>html,body,embed{margin:0;width:100%;height:100%;display:block}</style>'
        + '<embed type="application/pdf" src="' + src + '">';
}

function contestRequest(handler: Handler | ConnectionHandler) {
    const path = domainRelativePath(handler);
    const routeRid = /^\/record\/([a-f\d]{24})(?:\/|$)/i.exec(path)?.[1];
    const rid = routeRid || (path === '/record-detail-conn' ? handler.args.rid : null);
    if (typeof rid === 'string' && objectId.test(rid)) return { rid: new ObjectId(rid) };
    const routeTid = /^\/(?:contest|api\/contest|api\/proctor\/contest)\/([a-f\d]{24})(?:\/|$)/i.exec(path)?.[1];
    const tid = routeTid || handler.args.tid;
    return typeof tid === 'string' && objectId.test(tid) ? { tid: new ObjectId(tid) } : null;
}

async function targetContest(handler: Handler | ConnectionHandler) {
    const target = contestRequest(handler);
    if (!target) return null;
    const domainId = handler.args.domainId || handler.domain._id;
    const tid = 'tid' in target ? target.tid : (await RecordModel.get(domainId, target.rid))?.contest;
    if (!tid || String(tid).startsWith('0'.repeat(23))) return null;
    const key = contestKey(domainId, tid);
    if (!await protectedContests.findOne({ _id: key })) return null;
    const contest = await ContestModel.get(domainId, tid);
    return { domainId, key, tid, contest };
}

async function redirectDeniedContestPage(handler: Handler, error: Error) {
    if (!(error instanceof PermissionError || error instanceof ContestScoreboardHiddenError)) return;
    const { method, json, headers, query } = handler.request;
    if (method !== 'get' || json || !handler.user?._id || (!headers[proofHeader] && !verifiedHttp.has(handler))
        || (headers['sec-fetch-mode'] && headers['sec-fetch-mode'] !== 'navigate')
        || !headers.accept?.includes('text/html') || query?.pjax || query?.noTemplate || query?.download
        || !handler.user.hasPerm(PERM.PERM_VIEW) || !handler.user.hasPerm(PERM.PERM_VIEW_CONTEST)) return;
    const path = domainRelativePath(handler).replace(/\/$/, '');
    // In particular, exclude the destination, API calls and file downloads.
    if (!/^\/(?:record(?:\/[a-f\d]{24})?|p\/[\w.-]+(?:\/submit)?|contest\/[a-f\d]{24}(?:\/(?:print|clarification|scoreboard(?:\/[\w-]+)?))?)$/i.test(path)) return;
    const target = await targetContest(handler);
    if (!target || !ContestModel.isOngoing(target.contest) || !await validBrowserProof(handler, target.key)) return;
    if (!(await ContestModel.getStatus(target.domainId, target.tid, handler.user._id))?.attend) return;
    handler.response.addHeader('Cache-Control', 'no-store');
    const requestedPath = handler.request.originalPath || handler.request.path;
    const domainArgs = requestedPath.startsWith(`/d/${target.domainId}/`) ? { domainId: target.domainId } : {};
    handler.response.redirect = handler.url('contest_problemlist', { tid: target.tid, ...domainArgs });
}

async function requireMonitoredBrowser(handler: Handler | ConnectionHandler) {
    // Account restrictions apply to every page/API/domain, not only contest URLs.
    // A verified desktop also avoids the old record -> contest -> binding lookup.
    if (await requireAccountBrowser(handler)) return true;
    const user = handler.user;
    if (!user._id) return false;
    const target = await targetContest(handler);
    if (!target) return false;
    const { key, contest } = target;
    if (!ContestModel.isOngoing(contest)) return true;
    // Contest managers need the native Hydro management pages during the event.
    if (user._id === contest.owner || user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) || user.hasPerm(PERM.PERM_EDIT_CONTEST)) return true;
    // Deployments predating account restrictions still have per-user browser
    // bindings. The binding determines scope even when the current SID is new.
    if (!await bindings.findOne({ _id: `${key}/${user._id}` }, { projection: { _id: 1 } })) return false;
    if (!await validBrowserProof(handler, key)) throw new ProctorBrowserRequiredError();
    return true;
}

export function registerBrowserContest(ctx: Context, authorize: (handler: Handler, body: Record<string, unknown>) => void,
    isServiceRequest: (handler: Handler) => boolean = () => false) {
    void accounts.createIndex({ uid: 1, endAt: 1 }).catch(error => ctx.logger.error(error));
    class ProctorBrowserContestHandler extends Handler {
        noCheckPermView = true;

        @param('tid', Types.ObjectId)
        async post({ domainId }, tid: ObjectId) {
            const body = this.request.body || {};
            if (body.action === 'socket-lease') return issueSocketLease(this, domainId, tid, body);
            authorize(this, body);
            const contest = await ContestModel.get(domainId, tid);
            if (ContestModel.RULES[contest.rule]?.hidden) throw new BadRequestError('当前比赛类型不能接入监考');
            const key = contestKey(domainId, tid);
            if (body.action === 'enable') {
                if (body.examId !== undefined || body.endAt !== undefined) {
                    const window = examWindow(body, contest);
                    await accounts.updateMany({ examId: window.examId, domainId, tid }, { $set: { endAt: window.endAt } });
                }
                await protectedContests.updateOne({ _id: key }, { $setOnInsert: { enabledAt: new Date() } }, { upsert: true });
                this.response.body = { ok: true, data: { contestId: String(tid) } };
                return;
            }
            if (body.action === 'restrict') {
                const window = examWindow(body, contest);
                if (window.endAt.getTime() <= Date.now()) throw new BadRequestError('考试已结束');
                if (typeof body.username !== 'string' || !body.username.trim()) throw new BadRequestError('username');
                const user = await UserModel.getByUname(domainId, body.username);
                if (!user || !user._id || user._id === contest.owner || user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
                    || user.hasPerm(PERM.PERM_EDIT_CONTEST)) throw new ForbiddenError('请使用本场比赛的普通选手账号登录');
                await accounts.updateOne({ _id: `${window.examId}/${user._id}` }, {
                    $set: { ...window, uid: user._id, domainId, tid },
                }, { upsert: true });
                this.response.addHeader('Cache-Control', 'no-store');
                this.response.body = { ok: true, data: { contestId: String(tid), restricted: true } };
                return;
            }
            if (body.action !== 'bind') throw new BadRequestError('action');
            if (ContestModel.isNotStarted(contest)) {
                this.response.status = 409;
                this.response.body = { ok: false, code: 'NOT_STARTED' };
                return;
            }
            if (ContestModel.isDone(contest)) throw new BadRequestError('HydroOJ 比赛已结束');
            const uid = this.user._id;
            const sid = this.session._id;
            if (!uid || typeof sid !== 'string' || this.context.cookies.get('sid') !== sid
                || typeof body.username !== 'string' || body.username.toLowerCase() !== this.user.uname.toLowerCase()
                || !this.user.hasPerm(PERM.PERM_VIEW_CONTEST) || !this.user.hasPerm(PERM.PERM_SUBMIT_PROBLEM)
                || uid === contest.owner || this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) || this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) {
                throw new ForbiddenError('请使用本场比赛的普通选手账号登录');
            }
            const session = await TokenModel.get(sid, TokenModel.TYPE_SESSION);
            const enrolled = await ContestModel.getStatus(domainId, tid, uid);
            const assignedGroups = contest.assign;
            const groups = assignedGroups?.length ? await UserModel.listGroup(domainId, uid) : [];
            if (!session || session.uid !== uid || +session.expireAt <= Date.now() || !enrolled?.attend
                || (assignedGroups?.length && !groups.some(group => assignedGroups.includes(group.name)))) {
                throw new ForbiddenError('请确认该 HydroOJ 账号已加入本场比赛');
            }
            const proctoringKey = randomBytes(32).toString('base64url');
            await bindings.updateOne({ _id: `${key}/${uid}` }, {
                $set: { sid, hash: hash(proctoringKey) }, $unset: { socketLease: '', httpLease: '' },
            }, { upsert: true });
            await protectedContests.updateOne({ _id: key }, { $setOnInsert: { enabledAt: new Date() } }, { upsert: true });
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.body = { ok: true, data: { contestId: String(tid), proctoringKey } };
        }
    }

    ctx.Route('cwnupaa_proctor_browser_contest', '/api/proctor/browser-contest/:tid', ProctorBrowserContestHandler);
    ctx.on('handler/after/ProblemFileDownload#get', inlineContestPdf);
    ctx.on('handler/after/ContestFileDownload#get', inlineContestPdf);
    ctx.on('handler/create/http', async handler => {
        // Service handlers enforce API-Key authentication themselves. They do
        // not have a candidate's browser session or proctoring proof header.
        if (handler instanceof ProctorBrowserContestHandler || isServiceRequest(handler)) return;
        try {
            if (await requireMonitoredBrowser(handler)) handler.response.addHeader('Cache-Control', 'no-store');
        } catch (error) {
            handler.response.addHeader('Cache-Control', 'no-store');
            throw error;
        }
    });
    ctx.on('handler/error', async (handler, error) => {
        if (!(handler instanceof Handler) || isServiceRequest(handler)) return;
        try {
            await redirectDeniedContestPage(handler, error);
        } catch (redirectError) {
            // Leave Hydro's original permission response intact if recovery fails.
            ctx.logger.error(redirectError);
        }
    });
    ctx.on('handler/create/ws', async connection => {
        await requireMonitoredBrowser(connection);
        // A previously opened record socket must also stop at the start of the
        // protected window or when a new desktop login replaces its binding.
        connection.ctx.interval(() => {
            void requireMonitoredBrowser(connection).catch(() => connection.close(4003, 'Proctored contest'));
        }, 2_000);
    });
}
