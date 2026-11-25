import { BadRequestError, ContestModel, Context, getAlphabeticId, Handler, NotFoundError, ObjectId, param, RecordModel, Types, UserModel } from 'hydrooj';

/** A read-only, API-key-only snapshot, deliberately separate from student APIs
 * (which project hidden verdicts and only return the student's last 100 runs). */
export function registerReactionContest(ctx: Context, authorize: (handler: Handler, body: Record<string, unknown>) => void) {
    class ProctorReactionContestHandler extends Handler {
        noCheckPermView = true;

        @param('tid', Types.ObjectId)
        async post({ domainId }, tid: ObjectId) {
            const body = this.request.body || {};
            authorize(this, body);
            const since = typeof body.since === 'string' ? new Date(body.since) : new Date(NaN);
            const after = body.after;
            if (!Number.isFinite(+since) || +since < 0 || +since / 1000 > 0xffffffff
                || (after != null && (typeof after !== 'string' || !/^[a-f\d]{24}$/.test(after)))) throw new BadRequestError('reaction cursor');
            const contest = await ContestModel.get(domainId, tid);
            if (!contest) throw new NotFoundError('contest');
            const lower = new ObjectId(Math.floor(+since / 1000).toString(16).padStart(8, '0') + '0'.repeat(16));
            const records = await RecordModel.getMulti(domainId, { contest: tid, _id: { $gte: lower, ...(after ? { $gt: new ObjectId(after) } : {}) } })
                .project({ _id: 1, uid: 1, pid: 1, status: 1, judgeAt: 1 }).sort({ _id: 1 }).limit(201).toArray();
            const page = records.slice(0, 200);
            const users = await UserModel.getList(domainId, [...new Set(page.map(row => row.uid))]);
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.body = { ok: true, data: {
                contestId: tid.toHexString(),
                nextAfter: records.length > 200 ? page[page.length - 1]._id.toHexString() : null,
                records: page.map(row => ({
                    id: row._id.toHexString(), username: users[row.uid]?.uname || `#deleted-hydro-user:${row.uid}`,
                    problemId: String(row.pid), problemLabel: contest.pids.includes(row.pid) ? getAlphabeticId(contest.pids.indexOf(row.pid)) : String(row.pid),
                    status: row.status, createdAt: row._id.getTimestamp().toISOString(), judgeAt: row.judgeAt?.toISOString() || null,
                })),
            } };
        }
    }
    ctx.Route('cwnupaa_proctor_reaction_contest', '/api/proctor/reaction-contest/:tid', ProctorReactionContestHandler);
    return ProctorReactionContestHandler;
}
