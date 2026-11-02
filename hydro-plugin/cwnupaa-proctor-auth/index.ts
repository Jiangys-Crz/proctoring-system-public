import crypto from 'node:crypto';
import yaml from 'js-yaml';
import {
    Context, ContestModel, DomainModel, Handler, PERM, PRIV, ProblemModel, RecordModel, Schema, Service, SettingModel, SystemModel, db,
    StorageModel, UserModel, getAlphabeticId, param, STATUS_TEXTS, Types,
    BadRequestError, ForbiddenError, NotFoundError,
} from 'hydrooj';
import {
    DEFAULT_API_KEY, DEFAULT_CONFIG, DEFAULT_RULE_MAPPINGS, DEFAULT_SECRET, DisplayRule, ProctorConfig,
    ProctorConfigError, publicProctorConfig, resolveProctorConfig, RuleMapping,
} from './config';
import { registerProctorSystemSettings } from './settings';
import { resolveJudgeLanguage } from './judge-language';
import { judgeLanguageList } from './judge-language-list';
import { problemFullScore } from './problem-score';

export { registerProctorSystemSettings } from './settings';

interface TicketRecord {
    uid: number;
    redirect: string;
    expiresAt: number;
}

// Hydro's record schema requires a numeric UID; this internal value is not an authentication account.
const INTERNAL_RECORD_UID = 1;

const tickets = new Map<string, TicketRecord>();

let legacyConfig: ProctorConfig = DEFAULT_CONFIG;

function runtimeConfig() {
    try {
        return resolveProctorConfig((key) => SystemModel.get(key), legacyConfig);
    } catch (error) {
        if (error instanceof ProctorConfigError) throw new BadRequestError(`${error.key}: ${error.message}`);
        throw error;
    }
}

function mapContestRule(hydroRule: string): DisplayRule {
    const source = `${hydroRule || ''}`.trim().toLowerCase();
    const configured = runtimeConfig().ruleMappings.find((item) => item.hydroRule.trim().toLowerCase() === source);
    // 未知赛制使用最保守的 OI 展示策略，避免在比赛中泄露分数或测试点。
    return configured?.displayRule || 'oi';
}

function problemDomain() { return runtimeConfig().problemDomainId || 'Problems'; }

async function ensureProblemDomain() {
    const id = problemDomain();
    if (!(await DomainModel.get(id))) {
        await DomainModel.add(id, INTERNAL_RECORD_UID, 'Problems', 'CWNUPAA 题库专用域，仅超级管理员通过平台访问。');
        await DomainModel.setRoles(id, { guest: '0', default: '0' });
    }
}

function timingSafeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signatureFor(secret: string, timestamp: string, bodyText: string) {
    return crypto.createHmac('sha256', secret).update(`${timestamp}.${bodyText}`).digest('hex');
}

function assertConfigured() {
    if (!runtimeConfig().apiKey || runtimeConfig().apiKey === DEFAULT_API_KEY) {
        throw new ForbiddenError('Hydro proctor API key is not configured.');
    }
}

function addCors(handler: Handler) {
    const origin = `${handler.request.headers.origin || ''}`;
    let websiteOrigin = runtimeConfig().websiteUrl.replace(/\/$/, '');
    try {
        websiteOrigin = new URL(runtimeConfig().websiteUrl).origin;
    } catch {
        // Leave legacy host-only configuration unchanged.
    }
    if (!origin || !websiteOrigin || origin !== websiteOrigin) return;
    handler.response.addHeader('Access-Control-Allow-Origin', origin);
    handler.response.addHeader('Access-Control-Allow-Credentials', 'true');
    handler.response.addHeader('Access-Control-Allow-Headers', 'content-type,x-proctor-api-key,x-proctor-account,x-proctor-signature,x-proctor-timestamp');
}

function requestOrigin(handler: Handler) {
    const forwarded = `${handler.request.headers['x-forwarded-proto'] || ''}`.split(',')[0].trim().toLowerCase();
    const protocol = forwarded === 'https' || forwarded === 'http' ? forwarded : 'http';
    return `${protocol}://${handler.request.host}`;
}

function assertApiRequest(handler: Handler, body: Record<string, any>) {
    assertConfigured();
    addCors(handler);
    const apiKey = `${handler.request.headers['x-proctor-api-key'] || ''}`;
    if (!timingSafeEqual(apiKey, runtimeConfig().apiKey)) throw new ForbiddenError('invalid proctor api key');
}

class ProctorConfigCheckHandler extends Handler {
    noCheckPermView = true;

    async post() {
        assertApiRequest(this, this.request.body || {});
        // Checking correspondence must not create a domain, user, login ticket or judge record.
        this.response.body = { ok: true, data: publicProctorConfig(runtimeConfig()) };
    }
}

async function authenticateApi(handler: Handler, body: Record<string, any>) {
    assertApiRequest(handler, body);
    const account = `${body.account || handler.request.headers['x-proctor-account'] || runtimeConfig().judgeAccount || ''}`.trim();
    if (!account) throw new BadRequestError('account');
    const udoc = await ensureUserByAccount(handler.args.domainId || 'system', account, handler.request.ip);
    if (!udoc) throw new NotFoundError('user');
    // Run model calls with the same user context as a normal Hydro session. This
    // keeps contest attendance, permissions and record ownership consistent.
    await loginAs(handler, udoc._id);
    return { account, udoc, domainId: handler.args.domainId || 'system' };
}

async function contestFor(handler: Handler, tid: any, body: Record<string, any>) {
    const auth = await authenticateApi(handler, body);
    const tdoc = await ContestModel.get(auth.domainId, tid);
    if (!tdoc) throw new NotFoundError('contest');
    if (!tdoc.pids?.length) throw new BadRequestError('contest has no problems');
    let tsdoc = await ContestModel.getStatus(auth.domainId, tid, auth.udoc._id);
    if (!tsdoc?.attend) {
        try {
            await ContestModel.attend(auth.domainId, tid, auth.udoc._id, { subscribe: 1 });
        } catch {
            // Another request may have attended the contest at the same time.
        }
        tsdoc = await ContestModel.getStatus(auth.domainId, tid, auth.udoc._id);
    }
    // Hydro's duration contests normally set startAt when the native problem list
    // opens. The standalone contest page bypasses that handler, so initialize it here.
    if (tdoc.duration && tsdoc?.attend && !tsdoc.startAt && ContestModel.isOngoing(tdoc, tsdoc)) {
        await ContestModel.setStatus(auth.domainId, tid, auth.udoc._id, { startAt: new Date() });
        tsdoc = await ContestModel.getStatus(auth.domainId, tid, auth.udoc._id);
    }
    return { ...auth, tdoc, tsdoc };
}

function contestEndAt(tdoc: any, tsdoc?: any) {
    if (!tdoc.duration || !tsdoc?.startAt) return tdoc.endAt;
    const personalEnd = new Date(new Date(tsdoc.startAt).getTime() + Number(tdoc.duration) * 60 * 60 * 1000);
    return personalEnd < tdoc.endAt ? personalEnd : tdoc.endAt;
}

function languageList(tdoc: any, pdocs: any[]) {
    const ids = tdoc.langs?.length
        ? tdoc.langs
        : Array.from(new Set(pdocs.flatMap((pdoc) => (typeof pdoc.config === 'object' && pdoc.config?.langs) || [])));
    const source = ids.length
        ? ids
        : Object.keys(SettingModel.langs || {}).filter((id) => !SettingModel.langs[id]?.disabled);
    return source.map((id) => ({ id, name: SettingModel.langs[id]?.display || id }));
}

function publicUser(udoc: any) {
    return {
        uid: udoc._id,
        username: udoc.uname,
        displayName: udoc.displayName || udoc.uname,
        school: udoc.school || '',
        studentId: udoc.studentId || '',
    };
}

function publicRecord(rdoc: any, tdoc: any, pdocs: any[], displayRule: DisplayRule, udoc?: any) {
    const problemIndex = tdoc.pids.indexOf(rdoc.pid);
    const createdAt = rdoc._id?.getTimestamp?.() || new Date();
    const projected = udoc ? ContestModel.applyProjection(tdoc, { ...rdoc }, udoc) : { ...rdoc };
    const status = Number.isFinite(projected.status) ? projected.status : 0;
    const statusText = displayRule === 'oi' ? '已提交' : STATUS_TEXTS[status] || 'Waiting';
    return {
        id: rdoc._id.toHexString(),
        problemIndex: problemIndex >= 0 ? getAlphabeticId(problemIndex) : '?',
        problemTitle: pdocs.find((pdoc) => pdoc.docId === rdoc.pid)?.title || `题目 ${rdoc.pid}`,
        status,
        statusText,
        score: displayRule === 'ioi' ? projected.score || 0 : 0,
        time: displayRule === 'ioi' ? projected.time || 0 : 0,
        memory: displayRule === 'ioi' ? projected.memory || 0 : 0,
        lang: rdoc.lang,
        code: rdoc.code || '',
        submittedBy: udoc ? publicUser(udoc) : undefined,
        testCases: displayRule === 'ioi' ? projected.testCases || [] : [],
        subtasks: displayRule === 'ioi' ? projected.subtasks || {} : {},
        createdAt: new Date(createdAt).toISOString(),
    };
}

async function contestProblemPayload(domainId: string, tdoc: any, pdocs: any[], started: boolean, assetBaseUrl: string) {
    return await Promise.all(tdoc.pids.map(async (pid: number, index: number) => {
        const pdoc = pdocs.find((item) => item.docId === pid) || {};
        const config = parseProblemConfig(pdoc.config);
        let content = started ? String(pdoc.content || '') : '';
        if (started && content && pdoc.additional_file?.length) {
            const links = Object.fromEntries(await Promise.all(pdoc.additional_file.map(async (file: any) => [
                file.name,
                new URL(
                    await StorageModel.signDownloadLink(`problem/${domainId}/${pid}/additional_file/${file.name}`, file.name, false, 'user'),
                    assetBaseUrl,
                ).toString(),
            ])));
            content = content.replace(/file:\/\/([^ \n)\\"]+)/g, (source: string, fileinfo: string) => {
                let filename = fileinfo.split('?')[0];
                try { filename = decodeURIComponent(filename); } catch { /* keep the original file name */ }
                return links[filename] || source;
            });
        }
        return {
            index: getAlphabeticId(index),
            pid,
            title: started ? pdoc.title || `题目 ${getAlphabeticId(index)}` : `题目 ${getAlphabeticId(index)}`,
            score: started ? tdoc.score?.[pid] || 100 : 0,
            content,
            html: Boolean(pdoc.html),
            timeLimit: limitNumber(config.timeMax ?? config.timeLimit ?? config.time, 'time'),
            memoryLimit: limitNumber(config.memoryMax ?? config.memoryLimit ?? config.memory, 'memory'),
            languages: config.langs || [],
        };
    }));
}

class ProctorContestDataHandler extends Handler {
    noCheckPermView = true;

    @param('tid', Types.ObjectId)
    async post({ domainId }, tid: any) {
        const { tdoc, tsdoc, udoc } = await contestFor(this, tid, this.request.body || {});
        const pdocs = Object.values(await ProblemModel.getList(domainId, tdoc.pids, true, true, ProblemModel.PROJECTION_CONTEST_DETAIL));
        const started = Date.now() >= tdoc.beginAt.getTime();
        const records = await RecordModel.getMulti(domainId, { contest: tid, uid: udoc._id })
            .sort({ _id: -1 }).limit(100).toArray();
        const assetBaseUrl = requestOrigin(this);
        const problems = await contestProblemPayload(domainId, tdoc, pdocs, started, assetBaseUrl);
        const displayRule = mapContestRule(tdoc.rule);
        this.response.body = {
            ok: true,
            data: {
                contest: {
                    id: tid.toHexString(),
                    title: tdoc.title,
                    rule: displayRule,
                    sourceRule: tdoc.rule,
                    content: tdoc.content || '',
                    beginAt: tdoc.beginAt.toISOString(),
                    endAt: contestEndAt(tdoc, tsdoc).toISOString(),
                    langs: languageList(tdoc, pdocs),
                },
                problems,
                files: (tdoc.files || []).concat(tdoc.privateFiles || []).map((file: any) => ({
                    name: file.name,
                    size: file.size,
                    type: (tdoc.privateFiles || []).includes(file) ? 'private' : 'public',
                })),
                user: publicUser(udoc),
                submissions: records.map((record) => publicRecord(record, tdoc, pdocs, displayRule, udoc)),
            },
        };
    }
}

class ProctorContestSubmitHandler extends Handler {
    noCheckPermView = true;

    @param('tid', Types.ObjectId)
    async post({ domainId }, tid: any) {
        const body = this.request.body || {};
        const { tdoc, tsdoc, udoc } = await contestFor(this, tid, body);
        if (!ContestModel.isOngoing(tdoc, tsdoc)) throw new BadRequestError('contest is not running');
        const pid = Number(body.pid);
        const lang = `${body.lang || ''}`.trim();
        const code = `${body.code || ''}`.replace(/\r\n/g, '\n');
        if (!tdoc.pids.includes(pid)) throw new BadRequestError('problem');
        if (!code) throw new BadRequestError('code');
        if (code.length > 512 * 1024) throw new BadRequestError('code too long');
        const pdoc: any = await ProblemModel.get(domainId, pid);
        const config = pdoc?.config;
        if (!pdoc || typeof config !== 'object') throw new BadRequestError('problem config');
        if (config.type === 'objective' || config.type === 'submit_answer') {
            if (lang !== '_') throw new BadRequestError('language');
        } else if ((config.langs?.length && !config.langs.includes(lang)) || !SettingModel.langs[lang] || SettingModel.langs[lang].disabled) {
            throw new BadRequestError('language');
        }
        await this.limitRate('cwnupaa_proctor_submit', 60, 20, `${udoc._id}`);
        const rid = await RecordModel.add(domainId, pid, udoc._id, lang, code, true, { contest: tid, type: 'judge' });
        await Promise.all([
            ProblemModel.inc(domainId, pid, 'nSubmit', 1),
            ContestModel.updateStatus(domainId, tid, udoc._id, rid, pid, { lang }),
        ]);
        const record = await RecordModel.get(domainId, rid);
        const displayRule = mapContestRule(tdoc.rule);
        const visibleRecord = publicRecord(record || {
            _id: rid, pid, lang, code, status: 0,
        }, tdoc, [pdoc], displayRule, udoc);
        this.response.body = {
            ok: true,
            data: {
                ...visibleRecord,
                submissionId: rid.toHexString(),
                codeLength: code.length,
            },
        };
    }
}

class ProctorContestSubmissionsHandler extends Handler {
    noCheckPermView = true;

    @param('tid', Types.ObjectId)
    async post({ domainId }, tid: any) {
        const { tdoc, udoc } = await contestFor(this, tid, this.request.body || {});
        const pdocs = Object.values(await ProblemModel.getList(domainId, tdoc.pids, true, true, ProblemModel.PROJECTION_CONTEST_DETAIL));
        const records = await RecordModel.getMulti(domainId, { contest: tid, uid: udoc._id })
            .sort({ _id: -1 }).limit(100).toArray();
        const displayRule = mapContestRule(tdoc.rule);
        this.response.body = { ok: true, data: records.map((record) => publicRecord(record, tdoc, pdocs, displayRule, udoc)) };
    }
}

class ProctorContestLeaderboardHandler extends Handler {
    noCheckPermView = true;

    @param('tid', Types.ObjectId)
    async post({ domainId }, tid: any) {
        const { tdoc } = await contestFor(this, tid, this.request.body || {});
        const displayRule = mapContestRule(tdoc.rule);
        const now = new Date();
        if (now < tdoc.beginAt || (displayRule === 'oi' && now < tdoc.endAt)
            || !ContestModel.canShowScoreboard.call(this, tdoc, false)) {
            this.response.body = { ok: true, data: { available: false, rows: [] } };
            return;
        }
        const tsdocs = await ContestModel.getMultiStatus(domainId, { docId: tid }).toArray();
        const rows = [];
        for (const tsdoc of tsdocs.filter((item: any) => item.attend && !item.unrank)) {
            const rule = (ContestModel as any).RULES?.[tdoc.rule];
            const stats: any = rule?.stat
                ? rule.stat(tdoc, tsdoc.journal || [])
                : { score: tsdoc.score || 0, accept: tsdoc.accept || 0, time: tsdoc.time || 0 };
            const udoc = await UserModel.getById(domainId, tsdoc.uid);
            if (!udoc) continue;
            rows.push({
                username: udoc.uname,
                displayName: udoc.displayName || udoc.uname,
                score: Number(stats.score || 0),
                solved: Number(stats.accept || 0),
                penalty: Number(stats.time || 0),
                problemScores: tdoc.pids.map((pid: number) => {
                    const raw = stats.display?.[pid]?.score ?? stats.detail?.[pid]?.score;
                    return typeof raw === 'number' ? raw * ((tdoc.score?.[pid] || 100) / 100) : null;
                }),
            });
        }
        rows.sort((a, b) => displayRule === 'acm'
            ? b.solved - a.solved || a.penalty - b.penalty || a.username.localeCompare(b.username)
            : b.score - a.score || a.penalty - b.penalty || a.username.localeCompare(b.username));
        this.response.body = {
            ok: true,
            data: {
                available: true,
                rows: rows.slice(0, 200).map((row, index) => ({ rank: index + 1, ...row })),
            },
        };
    }
}

class ProctorContestFileHandler extends Handler {
    noCheckPermView = true;

    @param('tid', Types.ObjectId)
    async post({ domainId }, tid: any) {
        const body = this.request.body || {};
        const { tdoc, tsdoc } = await contestFor(this, tid, body);
        const type = body.type === 'private' ? 'private' : 'public';
        const name = `${body.name || ''}`;
        if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) throw new BadRequestError('file name');
        const files = type === 'private' ? tdoc.privateFiles || [] : tdoc.files || [];
        if (!files.some((file: any) => file.name === name)) throw new NotFoundError('file');
        if (type === 'private' && !tsdoc?.attend) throw new ForbiddenError('contest not attended');
        const target = `contest/${domainId}/${tid}/${type}/${name}`;
        const url = await StorageModel.signDownloadLink(target, name, false, 'user');
        this.response.body = { ok: true, data: { url } };
    }
}

function consumeToken(token: string) {
    const record = tickets.get(token);
    if (!record) return null;
    tickets.delete(token);
    if (record.expiresAt < Date.now()) return null;
    return record;
}

async function findUserByAccount(domainId: string, account: string) {
    let udoc = await UserModel.getByUname(domainId, account);
    udoc ||= await UserModel.getByEmail(domainId, account);
    if (!udoc) {
        const raw = await UserModel.getMulti({ studentId: account }).limit(1).toArray();
        if (raw[0]) udoc = await UserModel.getById(domainId, raw[0]._id);
    }
    return udoc;
}

async function ensureUserByAccount(domainId: string, account: string, regip = '127.0.0.1') {
    const normalized = account.trim();
    let udoc = await findUserByAccount(domainId, normalized);
    if (udoc) return udoc;
    const slug = normalized.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 48) || 'candidate';
    const suffix = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
    const mail = `${slug}-${suffix}@proctor.local`;
    try {
        const uid = await UserModel.create(mail, normalized, crypto.randomBytes(24).toString('base64url'), undefined, regip);
        udoc = await UserModel.getById(domainId, uid);
    } catch {
        // A concurrent request may have created the same account. Resolve it
        // from the database before reporting a genuine missing-user error.
        udoc = await findUserByAccount(domainId, normalized);
    }
    return udoc;
}

async function loginAs(handler: Handler, uid: number) {
    const udoc = await UserModel.getById(handler.args.domainId || 'system', uid);
    if (!udoc) throw new NotFoundError('user');
    await UserModel.setById(udoc._id, { loginat: new Date(), loginip: handler.request.ip });
    handler.context.HydroContext.user = udoc;
    handler.user = udoc;
    handler.session.viewLang = '';
    handler.session.uid = udoc._id;
    handler.session.sudo = null;
    handler.session.sudoUid = null;
    handler.session.scope = PERM.PERM_ALL.toString();
    handler.session.oauthBind = null;
    handler.session.recreate = true;
    handler.session.save = false;
}

class ProctorLoginTicketHandler extends Handler {
    noCheckPermView = true;

    async post({ domainId }) {
        assertConfigured();
        if (!runtimeConfig().sharedSecret || runtimeConfig().sharedSecret === DEFAULT_SECRET) throw new ForbiddenError('legacy login ticket signing secret is not configured');
        const apiKey = `${this.request.headers['x-proctor-api-key'] || ''}`;
        if (!timingSafeEqual(apiKey, runtimeConfig().apiKey)) {
            throw new ForbiddenError('invalid proctor api key');
        }
        const timestamp = `${this.request.headers['x-proctor-timestamp'] || ''}`;
        const signature = `${this.request.headers['x-proctor-signature'] || ''}`;
        const now = Date.now();
        const time = Number(timestamp);
        if (!timestamp || !signature || !Number.isFinite(time) || Math.abs(now - time) > 5 * 60 * 1000) {
            throw new ForbiddenError('invalid proctor signature timestamp');
        }

        const body = this.request.body || {};
        const bodyText = JSON.stringify(body);
        const expected = signatureFor(runtimeConfig().sharedSecret, timestamp, bodyText);
        if (!timingSafeEqual(signature, expected)) throw new ForbiddenError('invalid proctor signature');

        const account = (`${body.account || ''}` || runtimeConfig().judgeAccount).trim();
        const redirect = `${body.redirect || `/contest/${body.contestId || ''}`}`.trim();
        if (!account) throw new BadRequestError('account');
        if (!redirect.startsWith(runtimeConfig().allowedRedirectPrefix)) throw new BadRequestError('redirect');

        const udoc = await ensureUserByAccount(domainId || 'system', account, this.request.ip);
        if (!udoc) throw new NotFoundError('user');

        const token = crypto.randomBytes(32).toString('base64url');
        tickets.set(token, {
            uid: udoc._id,
            redirect,
            expiresAt: Date.now() + runtimeConfig().ticketTtlSeconds * 1000,
        });
        this.response.body = {
            ok: true,
            loginUrl: `/proctor/consume-ticket?token=${encodeURIComponent(token)}`,
            expiresAt: new Date(Date.now() + runtimeConfig().ticketTtlSeconds * 1000).toISOString(),
        };
    }
}

class ProctorConsumeTicketHandler extends Handler {
    noCheckPermView = true;

    async get() {
        const token = `${this.request.query.token || ''}`;
        const record = consumeToken(token);
        if (!record) throw new ForbiddenError('ticket expired or consumed');
        await loginAs(this, record.uid);
        this.response.redirect = record.redirect;
    }
}

function parseProblemConfig(source: unknown) {
    if (source && typeof source === 'object') return source as Record<string, any>;
    if (typeof source !== 'string' || !source.trim()) return {};
    try {
        const parsed = yaml.load(source);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {};
    } catch {
        return {};
    }
}

function limitNumber(value: unknown, kind: 'time' | 'memory') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return 0;
    const match = value.trim().toLowerCase().replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)([a-z]*)$/);
    if (!match) return 0;
    const amount = Number(match[1]);
    const unit = match[2];
    if (kind === 'time') {
        if (['s', 'sec', 'secs'].includes(unit)) return Math.round(amount * 1000);
        if (['m', 'min', 'mins'].includes(unit)) return Math.round(amount * 60_000);
        return Math.round(amount);
    }
    if (['g', 'gb', 'gib'].includes(unit)) return Math.round(amount * 1024);
    if (['k', 'kb', 'kib'].includes(unit)) return Math.max(1, Math.round(amount / 1024));
    if (['b', 'byte', 'bytes'].includes(unit)) return Math.max(1, Math.round(amount / 1024 / 1024));
    return Math.round(amount);
}

function publicProblem(pdoc: any) {
    const config = parseProblemConfig(pdoc.config);
    // Never expose objective answers to the proctoring frontend. The full
    // configuration is read only so the bridge can calculate the real score.
    const publicConfig = { ...config };
    delete publicConfig.answers;
    return {
        id: String(pdoc.docId),
        pid: pdoc.pid || String(pdoc.docId),
        title: pdoc.title || '',
        content: pdoc.content || '',
        html: Boolean(pdoc.html),
        config: publicConfig,
        data: pdoc.data || [],
        files: pdoc.additional_file || [],
        tags: pdoc.tag || [],
        difficulty: pdoc.difficulty || 0,
        score: problemFullScore({ score: pdoc.score, config }) ?? 100,
    };
}

class ProctorProblemGetHandler extends Handler {
    noCheckPermView = true;

    @param('pid', Types.UnsignedInt)
    async post({ domainId }, pid: number) {
        const body = this.request.body || {};
        assertApiRequest(this, body);
        await ensureProblemDomain();
        const pdoc = await ProblemModel.get(problemDomain(), pid, ProblemModel.PROJECTION_PUBLIC, true);
        if (!pdoc) throw new NotFoundError('problem');
        this.response.body = { ok: true, data: publicProblem(pdoc) };
    }
}

class ProctorProblemAnswerKeyHandler extends Handler {
    noCheckPermView = true;

    @param('pid', Types.UnsignedInt)
    async post({ domainId }, pid: number) {
        const body = this.request.body || {};
        assertApiRequest(this, body);
        await ensureProblemDomain();
        const pdoc = await ProblemModel.get(problemDomain(), pid, ProblemModel.PROJECTION_PUBLIC, true);
        if (!pdoc) throw new NotFoundError('problem');
        const config = parseProblemConfig(pdoc.config);
        this.response.body = { ok: true, data: { answers: config.answers && typeof config.answers === 'object' ? config.answers : {} } };
    }
}

class ProctorProblemFileHandler extends Handler {
    noCheckPermView = true;

    @param('pid', Types.UnsignedInt)
    async post({ domainId }, pid: number) {
        const body = this.request.body || {};
        assertApiRequest(this, body);
        const name = `${body.name || ''}`;
        if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) throw new BadRequestError('file name');
        await ensureProblemDomain();
        const targetDomain = problemDomain();
        const pdoc = await ProblemModel.get(targetDomain, pid, ProblemModel.PROJECTION_PUBLIC);
        if (!pdoc) throw new NotFoundError('problem');
        const files = Array.isArray(pdoc.additional_file) ? pdoc.additional_file : [];
        if (!files.some((file: any) => file?.name === name)) throw new NotFoundError('file');
        const url = await StorageModel.signDownloadLink(`problem/${targetDomain}/${pid}/additional_file/${name}`, name, false, 'user');
        this.response.body = { ok: true, data: { url } };
    }
}

class ProctorLanguageListHandler extends Handler {
    noCheckPermView = true;

    async post() {
        assertApiRequest(this, this.request.body || {});
        const judgeStatuses: any[] = await db.collection('status')
            .find({ compilers: { $exists: true } }).toArray();
        const data = judgeLanguageList(SettingModel.langs || {}, judgeStatuses.map(item => item.compilers));
        this.response.body = { ok: true, data };
    }
}

class ProctorProblemListHandler extends Handler {
    noCheckPermView = true;

    async post({ domainId }) {
        const body = this.request.body || {};
        assertApiRequest(this, body);
        await ensureProblemDomain();
        const targetDomain = problemDomain();
        const queryText = `${body.query || ''}`.trim();
        const exactPid = typeof body.exactPid === 'string' ? body.exactPid.trim() : '';
        const escapedQuery = queryText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const query: any = exactPid ? { pid: exactPid } : queryText
            ? { $or: [{ title: { $regex: escapedQuery, $options: 'i' } }, { pid: { $regex: escapedQuery, $options: 'i' } }, ...( /^\d+$/.test(queryText) ? [{ docId: Number(queryText) }] : [])] }
            : {};
        const limit = Math.min(100, Math.max(1, Number(body.limit || 30)));
        const docs = await ProblemModel.getMulti(targetDomain, query, ProblemModel.PROJECTION_PUBLIC).limit(limit).toArray();
        this.response.body = { ok: true, data: docs.map(publicProblem) };
    }
}

class ProctorProblemSyncHandler extends Handler {
    noCheckPermView = true;

    async post({ domainId }) {
        const body = this.request.body || {};
        assertApiRequest(this, body);
        await ensureProblemDomain();
        const targetDomain = problemDomain();
        const owner = INTERNAL_RECORD_UID;
        const title = `${body.title || ''}`.trim();
        const content = `${body.content || ''}`;
        if (!title || !content) throw new BadRequestError('title/content');
        const requestedId = Number(body.id || body.hydroProblemId || 0);
        let pdoc = requestedId ? await ProblemModel.get(targetDomain, requestedId, ProblemModel.PROJECTION_PUBLIC, true) : null;
        if (pdoc) {
            await ProblemModel.edit(targetDomain, requestedId, {
                title,
                content,
                html: Boolean(body.html),
                tag: Array.isArray(body.tags) ? body.tags : pdoc.tag,
                difficulty: Number(body.difficulty || pdoc.difficulty || 0),
                hidden: Boolean(body.hidden),
                ...(body.config !== undefined ? { config: typeof body.config === 'string' ? body.config : JSON.stringify(body.config) } : {}),
            } as any);
            pdoc = await ProblemModel.get(targetDomain, requestedId, ProblemModel.PROJECTION_PUBLIC, true);
        } else {
            const createdId = await ProblemModel.add(
                targetDomain,
                `${body.pid || ''}`,
                title,
                content,
                owner,
                Array.isArray(body.tags) ? body.tags : [],
                {
                    difficulty: Number(body.difficulty || 0),
                    hidden: Boolean(body.hidden),
                },
            );
            pdoc = await ProblemModel.get(targetDomain, createdId, ProblemModel.PROJECTION_PUBLIC, true);
            if (body.config !== undefined) {
                await ProblemModel.edit(targetDomain, createdId, {
                    config: typeof body.config === 'string' ? body.config : JSON.stringify(body.config),
                } as any);
            }
            if (body.testdata && typeof body.testdata === 'object') {
                for (const [name, value] of Object.entries(body.testdata)) {
                    await ProblemModel.addTestdata(targetDomain, createdId, name, Buffer.from(String(value)));
                }
            }
            pdoc = await ProblemModel.get(targetDomain, createdId, ProblemModel.PROJECTION_PUBLIC, true);
        }
        this.response.body = { ok: true, data: pdoc ? publicProblem(pdoc) : { id: requestedId } };
    }
}

function publicRecordForApi(rdoc: any) {
    return {
        id: rdoc._id?.toHexString?.() || String(rdoc._id),
        pid: rdoc.pid,
        lang: rdoc.lang,
        code: rdoc.code || '',
        status: Number(rdoc.status || 0),
        statusText: STATUS_TEXTS[rdoc.status] || 'Waiting',
        score: Number(rdoc.score || 0),
        time: Number(rdoc.time || 0),
        memory: Number(rdoc.memory || 0),
        testCases: rdoc.testCases || [],
        subtasks: rdoc.subtasks || {},
        judgeAt: rdoc.judgeAt ? new Date(rdoc.judgeAt).toISOString() : null,
        createdAt: rdoc._id?.getTimestamp?.()?.toISOString?.() || new Date().toISOString(),
    };
}

class ProctorJudgeSubmitHandler extends Handler {
    noCheckPermView = true;

    async post({ domainId }) {
        const body = this.request.body || {};
        assertApiRequest(this, body);
        const pid = Number(body.pid);
        let lang = `${body.lang || ''}`.trim();
        const code = `${body.code || ''}`.replace(/\r\n/g, '\n');
        if (!Number.isSafeInteger(pid) || pid <= 0 || !lang || !code) throw new BadRequestError('pid/lang/code');
        await ensureProblemDomain();
        const pdoc = await ProblemModel.get(problemDomain(), pid, ProblemModel.PROJECTION_PUBLIC);
        if (!pdoc) throw new NotFoundError('problem');
        const config = parseProblemConfig(pdoc.config);
        if (['objective', 'submit_answer'].includes(config.type)) {
            if (lang !== '_') throw new BadRequestError('language');
        } else {
            const enabled = Object.keys(SettingModel.langs || {}).filter(id => !SettingModel.langs[id]?.disabled && id !== '_');
            const resolved = resolveJudgeLanguage(lang, enabled, Array.isArray(config.langs) ? config.langs : undefined);
            if (!resolved) throw new BadRequestError('评测语言未启用或题目不支持，请刷新语言列表后重试');
            lang = resolved;
        }
        // Create the record without going through a Hydro login account or the
        // per-user submission-priority limiter. The API key is the
        // authority here; enqueue the task directly for Hydro Judger instead.
        const judgeUid = INTERNAL_RECORD_UID;
        const rid = await RecordModel.add(problemDomain(), pid, judgeUid, lang, code, false, { type: 'judge' });
        const record = await RecordModel.get(problemDomain(), rid);
        if (!record) throw new NotFoundError('record');
        await RecordModel.judge(problemDomain(), record, 50, {}, { type: 'judge' });
        this.response.body = { ok: true, data: publicRecordForApi(record) };
    }
}

class ProctorJudgeStatusHandler extends Handler {
    noCheckPermView = true;

    @param('rid', Types.ObjectId)
    async post({ domainId }, rid: any) {
        const body = this.request.body || {};
        assertApiRequest(this, body);
        const record = await RecordModel.get(problemDomain(), rid);
        if (!record) throw new NotFoundError('record');
        this.response.body = { ok: true, data: publicRecordForApi(record) };
    }
}

class ProctorJudgeBatchStatusHandler extends Handler {
    noCheckPermView = true;

    async post({ domainId }) {
        const body = this.request.body || {};
        assertApiRequest(this, body);
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
        const convert = (Types.ObjectId as readonly any[])[0];
        const records = await Promise.all(ids.map(async (value: unknown) => {
            try {
                const rid = convert(`${value || ''}`);
                return await RecordModel.get(problemDomain(), rid);
            } catch {
                return null;
            }
        }));
        this.response.body = { ok: true, data: records.filter(Boolean).map(publicRecordForApi) };
    }
}

export default class CwnupaaProctorAuthService extends Service {
    static Config = Schema.object({
        sharedSecret: Schema.string().description('仅兼容旧登录票据签名；题库与判题接口无需此项').role('password').hidden().default(DEFAULT_SECRET),
        apiKey: Schema.string().description('兼容旧配置：接口 API Key；系统设置优先').role('password').default(DEFAULT_API_KEY),
        websiteUrl: Schema.string().description('旧字段兼容保留，仅用于原比赛页的跨域行为；当前后台 API-Key 判题无需网站地址').role('url').hidden().default(''),
        ticketTtlSeconds: Schema.number().description('One-time login ticket TTL').default(120),
        domainId: Schema.string().description('Fixed Hydro domain used as the problem bank and judge').default('system'),
        problemDomainId: Schema.string().description('Private Hydro domain used for the synchronized problem bank and judge').default('Problems'),
        ownerUid: Schema.number().hidden().description('Hydro user ID used when creating synchronized problems').default(1),
        judgeAccount: Schema.string().description('仅兼容旧登录票据/比赛页；题库判题不使用此账号').hidden().default('proctor-judge'),
        judgePassword: Schema.string().description('旧字段兼容保留；当前 API-Key 判题接口不使用账号密码').role('password').hidden().default(''),
        allowedRedirectPrefix: Schema.string().description('Allowed redirect path prefix').default('/contest/'),
        ruleMappings: Schema.array(Schema.object({
            hydroRule: Schema.string().description('Hydro rule id').required(),
            displayRule: Schema.union(['acm', 'oi', 'ioi']).description('Contest website display policy').required(),
        })).role('table').description('Map Hydro rules to ACM, OI or IOI display policies').default(DEFAULT_RULE_MAPPINGS),
    });

    constructor(ctx: Context, config: ReturnType<typeof CwnupaaProctorAuthService.Config>) {
        super(ctx, 'cwnupaa.proctorAuth');
        legacyConfig = {
            sharedSecret: config.sharedSecret,
            apiKey: config.apiKey,
            websiteUrl: config.websiteUrl,
            ticketTtlSeconds: config.ticketTtlSeconds,
            domainId: config.domainId,
            problemDomainId: config.problemDomainId || 'Problems',
            ownerUid: config.ownerUid,
            judgeAccount: config.judgeAccount,
            judgePassword: config.judgePassword || '',
            allowedRedirectPrefix: config.allowedRedirectPrefix,
            ruleMappings: (config.ruleMappings || DEFAULT_RULE_MAPPINGS) as RuleMapping[],
        };
        registerProctorSystemSettings(ctx, legacyConfig);
        void ensureProblemDomain().catch((error) => ctx.logger.error(error));
        ctx.Route('cwnupaa_proctor_config_check', '/api/proctor/config-check', ProctorConfigCheckHandler);
        ctx.Route('cwnupaa_proctor_login_ticket', '/api/proctor/login-ticket', ProctorLoginTicketHandler);
        ctx.Route('cwnupaa_proctor_consume_ticket', '/proctor/consume-ticket', ProctorConsumeTicketHandler, PRIV.PRIV_NONE);
        ctx.Route('cwnupaa_proctor_contest_data', '/api/proctor/contest/:tid', ProctorContestDataHandler);
        ctx.Route('cwnupaa_proctor_contest_submit', '/api/proctor/contest/:tid/submit', ProctorContestSubmitHandler);
        ctx.Route('cwnupaa_proctor_contest_submissions', '/api/proctor/contest/:tid/submissions', ProctorContestSubmissionsHandler);
        ctx.Route('cwnupaa_proctor_contest_leaderboard', '/api/proctor/contest/:tid/leaderboard', ProctorContestLeaderboardHandler);
        ctx.Route('cwnupaa_proctor_contest_file', '/api/proctor/contest/:tid/file', ProctorContestFileHandler);
        ctx.Route('cwnupaa_proctor_problem_sync', '/api/proctor/problem/sync', ProctorProblemSyncHandler);
        ctx.Route('cwnupaa_proctor_languages', '/api/proctor/languages', ProctorLanguageListHandler);
        ctx.Route('cwnupaa_proctor_problem_list', '/api/proctor/problems', ProctorProblemListHandler);
        ctx.Route('cwnupaa_proctor_problem_file', '/api/proctor/problem/:pid/file', ProctorProblemFileHandler);
        ctx.Route('cwnupaa_proctor_problem_answer_key', '/api/proctor/problem/:pid/answer-key', ProctorProblemAnswerKeyHandler);
        ctx.Route('cwnupaa_proctor_problem_get', '/api/proctor/problem/:pid', ProctorProblemGetHandler);
        ctx.Route('cwnupaa_proctor_judge_submit', '/api/proctor/judge', ProctorJudgeSubmitHandler);
        ctx.Route('cwnupaa_proctor_judge_batch_status', '/api/proctor/judge-status', ProctorJudgeBatchStatusHandler);
        ctx.Route('cwnupaa_proctor_judge_status', '/api/proctor/judge/:rid', ProctorJudgeStatusHandler);
    }
}
