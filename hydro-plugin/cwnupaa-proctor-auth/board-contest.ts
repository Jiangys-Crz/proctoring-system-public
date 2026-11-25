import yaml from 'js-yaml';
import { BadRequestError, ContestModel, Context, getAlphabeticId, Handler, NotFoundError, ObjectId, param, ProblemModel, RecordModel, Types, UserModel } from 'hydrooj';
import { problemFullScore } from './problem-score';

const PAGE_SIZE = 50;
const BROADCAST_PAGE_SIZE = 250;
const PAGE_BYTES = 900_000;
const objectId = /^[a-f\d]{24}$/;

function configOf(value: unknown): Record<string, any> {
    const parsed = typeof value === 'string' ? yaml.load(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
}

function limit(value: unknown, kind: 'time' | 'memory') {
    const match = String(value ?? '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
    if (!match) return kind === 'time' ? 1000 : 256;
    const multiplier = kind === 'time' ? /^(s|sec|secs)$/.test(match[2]) ? 1000 : /^(m|min|mins)$/.test(match[2]) ? 60_000 : 1
        : /^(g|gb|gib)$/.test(match[2]) ? 1024 : /^(k|kb|kib)$/.test(match[2]) ? 1 / 1024 : /^(b|byte|bytes)$/.test(match[2]) ? 1 / 1048576 : 1;
    return Math.max(1, Math.round(Number(match[1]) * multiplier));
}

function maxLimit(config: Record<string, any>, kind: 'time' | 'memory') {
    const base = config[`${kind}Max`] ?? config[`${kind}Limit`] ?? config[kind];
    if (!Array.isArray(config.subtasks) || !config.subtasks.length) return limit(base, kind);
    let maximum = 0;
    for (const subtask of config.subtasks) {
        const inherited = subtask?.[kind] ?? base;
        if (!Array.isArray(subtask?.cases) || !subtask.cases.length) maximum = Math.max(maximum, limit(inherited, kind));
        else for (const item of subtask.cases) maximum = Math.max(maximum, limit(item?.[kind] ?? inherited, kind));
    }
    return maximum;
}

async function sourceProblem(problem: any) {
    let current = problem;
    const visited = new Set<string>();
    while (current.reference) {
        const { domainId, pid } = current.reference;
        const key = `${domainId}/${pid}`;
        if (visited.has(key) || visited.size >= 8) throw new BadRequestError('circular problem reference');
        visited.add(key);
        current = await ProblemModel.get(domainId, pid, ['config', 'score', 'reference'], true);
        if (!current) throw new NotFoundError('referenced problem');
    }
    return current;
}

/** Source for the explicitly enabled external-board export. Unlike public CCS,
 * this API-key-only service includes source code for the selected exam accounts.
 * Pagination scans by immutable record ID and repeats from the start so old
 * rejudges/ignored records are observed without relying on a missing updatedAt. */
export function registerBoardContest(ctx: Context, authorize: (handler: Handler, body: Record<string, unknown>) => void) {
    class ProctorBoardContestHandler extends Handler {
        noCheckPermView = true;

        @param('tid', Types.ObjectId)
        async post({ domainId }, tid: ObjectId) {
            const body = this.request.body || {};
            authorize(this, body);
            const broadcast = body.broadcast === true;
            const statistics = broadcast && body.statistics === true;
            const pageSize = broadcast ? BROADCAST_PAGE_SIZE : PAGE_SIZE;
            const since = new Date(typeof body.since === 'string' ? body.since : NaN);
            const until = new Date(typeof body.until === 'string' ? body.until : NaN);
            const after = body.after ?? null;
            if (![since, until].every(date => Number.isFinite(+date) && +date >= 0 && +date / 1000 < 0xffffffff)
                || (after !== null && (typeof after !== 'string' || !objectId.test(after)))
                || !Array.isArray(body.usernames) || body.usernames.length > 10_000
                || body.usernames.some(name => typeof name !== 'string' || !name || name.length > 256)) throw new BadRequestError('external board cursor or accounts');
            const contest = await ContestModel.get(domainId, tid);
            if (!contest) throw new NotFoundError('contest');
            if (!['acm', 'oi', 'ioi', 'strictioi'].includes(contest.rule) || contest.duration) throw new BadRequestError('external board requires a fixed-time ACM/OI/IOI contest');
            const pdocs = await ProblemModel.getMulti(domainId, { docId: { $in: contest.pids } }, ['docId', 'title', 'config', 'score', 'reference']).toArray();
            const problems = await Promise.all(contest.pids.map(async (pid, index) => {
                const problem = pdocs.find(row => row.docId === pid);
                if (!problem) throw new NotFoundError('contest problem');
                const source = await sourceProblem(problem);
                const config = configOf(source.config);
                const balloon = contest.balloon?.[pid];
                const color = typeof balloon === 'string' ? balloon : balloon?.color;
                return { id: String(pid), label: getAlphabeticId(index), title: problem.title,
                    score: contest.score?.[pid] ?? 100, hydroScore: problemFullScore({ ...source, config }) ?? 100,
                    timeLimitMs: maxLimit(config, 'time'), memoryLimitMb: maxLimit(config, 'memory'),
                    ...(broadcast ? { color: typeof color === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color) ? color : null } : {}) };
            }));
            const start = Math.max(+since, +contest.beginAt), end = Math.min(+until, +contest.endAt);
            // Before the contest starts, publish its manifest with no records.
            // Construct ObjectIds only for a non-empty, validated intersection.
            const lower = end > start ? new ObjectId(Math.floor(start / 1000).toString(16).padStart(8, '0') + '0'.repeat(16)) : null;
            const upper = end > start ? new ObjectId(Math.ceil(end / 1000).toString(16).padStart(8, '0') + '0'.repeat(16)) : null;
            const rows = end > start && body.usernames.length ? await RecordModel.getMulti(domainId, {
                contest: tid, _id: { $gte: lower, $lt: upper, ...(after ? { $gt: new ObjectId(after) } : {}) },
            }).project({ _id: 1, uid: 1, pid: 1, status: 1, score: 1, lang: 1, ...(!broadcast ? { code: 1 } : {}),
                ...(statistics ? { judgeAt: 1 } : {}), time: 1, memory: 1 })
                .sort({ _id: 1 }).limit(pageSize + 1).toArray() : [];
            const users = rows.length ? await UserModel.getList(domainId, [...new Set(rows.map(row => row.uid))]) : {};
            const usernames = new Set(body.usernames), records: any[] = [];
            const maintainers = new Set(contest.maintainer || []);
            // The director can reveal this authenticated feed without unlocking Hydro's public scoreboard.
            const frozenAt = broadcast && body.reveal !== true && contest.lockAt && !contest.unlocked ? +contest.lockAt : null;
            let consumed = 0, bytes = 0;
            for (const row of rows.slice(0, pageSize)) {
                const username = users[row.uid]?.uname, createdAt = row._id.getTimestamp();
                if (username && usernames.has(username) && contest.pids.includes(row.pid) && +createdAt >= start && +createdAt < end
                    && (!broadcast || !maintainers.has(row.uid))) {
                    const hidden = frozenAt !== null && +createdAt > frozenAt;
                    const record = { id: row._id.toHexString(), username, problemId: String(row.pid), status: hidden ? 0 : row.status,
                        score: hidden ? 0 : row.score ?? 0, language: broadcast && !statistics ? '' : row.lang || '', code: broadcast ? '' : row.code || '', runtime: row.time || 0,
                        ...(statistics ? { judgedAt: !hidden && row.judgeAt instanceof Date && Number.isFinite(+row.judgeAt) ? row.judgeAt.toISOString() : null } : {}),
                        memory: row.memory || 0, createdAt: createdAt.toISOString() };
                    const size = Buffer.byteLength(JSON.stringify(record));
                    if (size > 4_000_000) throw new BadRequestError('external board record is too large');
                    if (records.length && bytes + size > PAGE_BYTES) break;
                    records.push(record); bytes += size;
                }
                consumed++;
            }
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.body = { ok: true, data: { contestId: tid.toHexString(), rule: contest.rule, problems, records,
                ...(broadcast ? { broadcast: { frozenAt: frozenAt === null ? null : new Date(frozenAt).toISOString() } } : {}),
                nextAfter: consumed < rows.length ? rows[consumed - 1]._id.toHexString() : null } };
        }
    }
    ctx.Route('cwnupaa_proctor_board_contest', '/api/proctor/board-contest/:tid', ProctorBoardContestHandler);
    return ProctorBoardContestHandler;
}
