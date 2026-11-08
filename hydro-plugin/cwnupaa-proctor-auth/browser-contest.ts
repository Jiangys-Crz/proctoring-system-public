import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
    BadRequestError, ConnectionHandler, ContestModel, Context, CreateError, db, ForbiddenError, Handler,
    ObjectId, param, PERM, PRIV, RecordModel, TokenModel, Types, UserModel,
} from 'hydrooj';

const proofHeader = 'x-hydro-proctor-key';
const ProctorBrowserRequiredError = CreateError('ProctorBrowserRequiredError', ForbiddenError, '比赛进行期间请使用监考客户端进入 HydroOJ。');
declare module 'hydrooj' {
    interface Collections {
        'cwnupaa.proctor.browser.contest': { _id: string; enabledAt: Date };
        'cwnupaa.proctor.browser.binding': { _id: string; sid: string; hash: string };
    }
}

const protectedContests = db.collection('cwnupaa.proctor.browser.contest');
const bindings = db.collection('cwnupaa.proctor.browser.binding');
const objectId = /^[a-f\d]{24}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const contestKey = (domainId: string, tid: ObjectId) => `${domainId}/${tid.toHexString()}`;

function contestRequest(handler: Handler | ConnectionHandler) {
    const path = handler.request.path.replace(/^\/d\/[^/]+(?=\/)/, '');
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
    return { key, contest };
}

async function requireMonitoredBrowser(handler: Handler | ConnectionHandler) {
    const target = await targetContest(handler);
    if (!target) return false;
    const { key, contest } = target;
    if (!ContestModel.isOngoing(contest)) return true;
    const user = handler.user;
    // Contest managers need the native Hydro management pages during the event.
    if (user._id === contest.owner || user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) || user.hasPerm(PERM.PERM_EDIT_CONTEST)) return true;
    const sid = handler.session._id;
    const proof = handler.request.headers[proofHeader];
    if (!user._id || typeof sid !== 'string' || typeof proof !== 'string' || !/^[\w-]{43}$/.test(proof)
        || handler.context.cookies.get('sid') !== sid) throw new ProctorBrowserRequiredError();
    const binding = await bindings.findOne({ _id: `${key}/${user._id}`, sid });
    if (!binding || !timingSafeEqual(Buffer.from(binding.hash, 'hex'), Buffer.from(hash(proof), 'hex'))) {
        throw new ProctorBrowserRequiredError();
    }
    return true;
}

export function registerBrowserContest(ctx: Context, authorize: (handler: Handler, body: Record<string, unknown>) => void) {
    class ProctorBrowserContestHandler extends Handler {
        noCheckPermView = true;

        @param('tid', Types.ObjectId)
        async post({ domainId }, tid: ObjectId) {
            const body = this.request.body || {};
            authorize(this, body);
            const contest = await ContestModel.get(domainId, tid);
            if (ContestModel.RULES[contest.rule]?.hidden) throw new BadRequestError('当前比赛类型不能接入监考');
            const key = contestKey(domainId, tid);
            if (body.action === 'enable') {
                await protectedContests.updateOne({ _id: key }, { $setOnInsert: { enabledAt: new Date() } }, { upsert: true });
                this.response.body = { ok: true, data: { contestId: String(tid) } };
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
            const groups = contest.assign?.length ? await UserModel.listGroup(domainId, uid) : [];
            if (!session || session.uid !== uid || +session.expireAt <= Date.now() || !enrolled?.attend
                || (contest.assign?.length && !groups.some(group => contest.assign.includes(group.name)))) {
                throw new ForbiddenError('请确认该 HydroOJ 账号已加入本场比赛');
            }
            const proctoringKey = randomBytes(32).toString('base64url');
            await bindings.updateOne({ _id: `${key}/${uid}` }, { $set: { sid, hash: hash(proctoringKey) } }, { upsert: true });
            await protectedContests.updateOne({ _id: key }, { $setOnInsert: { enabledAt: new Date() } }, { upsert: true });
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.body = { ok: true, data: { contestId: String(tid), proctoringKey } };
        }
    }

    ctx.Route('cwnupaa_proctor_browser_contest', '/api/proctor/browser-contest/:tid', ProctorBrowserContestHandler);
    ctx.on('handler/create/http', async handler => {
        if (handler instanceof ProctorBrowserContestHandler) return;
        if (await requireMonitoredBrowser(handler)) handler.response.addHeader('Cache-Control', 'no-store');
    });
    ctx.on('handler/create/ws', async connection => {
        if (!await requireMonitoredBrowser(connection)) return;
        // A previously opened record socket must also stop at the start of the
        // protected window or when a new desktop login replaces its binding.
        connection.ctx.interval(() => {
            void requireMonitoredBrowser(connection).catch(() => connection.close(4003, 'Proctored contest'));
        }, 10_000);
    });
}
