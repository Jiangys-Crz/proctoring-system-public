import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReactionRankContext, computeNovaJudgeStandings, parseReactionRankContext, reconstructHistoricalReactionRankContext, type RankingEvent } from '../src/lib/reaction-ranking';

const start = Date.parse('2026-01-01T00:00:00.000Z');
const at = (seconds: number) => new Date(start + seconds * 1000);
const row = (type: string, id: string, payload: Record<string, unknown>, seconds = 0): RankingEvent => ({ type, remoteId: id, payload: { id, ...payload }, observedAt: at(seconds) });
function baseline(): RankingEvent[] {
  return [row('contests', 'c1', { start_time: at(0).toISOString(), end_time: at(18000).toISOString(), penalty_time: 20 }),
    row('teams', 'one', {}), row('teams', 'two', {}), row('problems', 'A', {}), row('problems', 'B', {})];
}
const submit = (id: string, team: string, problem: string, minutes: number) => row('submissions', id, { team_id: team, problem_id: problem, time: at(minutes * 60).toISOString(), contest_time: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:00.000` }, minutes * 60);
const judge = (id: string, verdict: string | null, seconds: number) => row('judgements', 'j-' + id, { submission_id: id, judgement_type_id: verdict }, seconds);
function effect(before: RankingEvent[], after: RankingEvent[], extra = {}) {
  return buildReactionRankContext({ before, after, contestId: 'c1', teamId: 'one', submissionId: 's', judgementId: 'j-s', verdict: 'AC', observedAt: at(700), baseline: { ready: true, observedAt: at(0).toISOString() }, ...extra });
}

test('observed AC changes rank from 2 to 1 using the exact team username', () => {
  const before = [...baseline(), submit('prior', 'two', 'A', 12), judge('prior', 'AC', 750), submit('s', 'one', 'A', 10), judge('s', null, 650)];
  const after = [...before.filter(value => value.remoteId !== 'j-s'), judge('s', 'AC', 800)];
  const context = effect(before, after);
  assert.equal(context.status, 'AVAILABLE'); assert.equal(context.beforeRank, 2); assert.equal(context.afterRank, 1);
  assert.notEqual(context.provenance.beforeStateHash, context.provenance.afterStateHash);
});

test('Nova penalty excludes CE/SE, includes pending attempts before AC, ignores post-AC attempts', () => {
  const rows = [...baseline(), submit('ce', 'one', 'A', 1), judge('ce', 'CE', 61), submit('se', 'one', 'A', 2), judge('se', 'SE', 121),
    submit('wa', 'one', 'A', 3), judge('wa', 'WA', 181), submit('pending', 'one', 'A', 4), judge('pending', null, 241),
    submit('s', 'one', 'A', 5), judge('s', 'AC', 301), submit('later', 'one', 'A', 6), judge('later', 'WA', 361)];
  const result = computeNovaJudgeStandings(rows, 'c1').find(value => value.teamId === 'one')!;
  assert.equal(result.solved, 1); assert.equal(result.penaltyMinutes, 45);
});

test('equal solved and penalty use competition ties and WA alone has no score', () => {
  const before = [...baseline(), submit('s', 'one', 'A', 10)];
  const result = effect(before, [...before, judge('s', 'WA', 601)], { verdict: 'WA' });
  assert.equal(result.beforeRank, 1); assert.equal(result.afterRank, 1);
  assert.deepEqual(computeNovaJudgeStandings(baseline(), 'c1').map(value => value.rank), [1, 1]);
});

test('delete tombstones remove accepted submissions and removed teams from standings', () => {
  const rows = [...baseline(), submit('s', 'one', 'A', 10), judge('s', 'AC', 601)];
  const deleted = rows.map(value => value.type === 'submissions' ? { ...value, payload: { ...(value.payload as object), __reactionDeleted: true } } : value);
  assert.equal(computeNovaJudgeStandings(deleted, 'c1').find(value => value.teamId === 'one')!.solved, 0);
  const roster = deleted.map(value => value.type === 'teams' && value.remoteId === 'two' ? { ...value, payload: { id: 'two', __reactionDeleted: true } } : value);
  assert.equal(computeNovaJudgeStandings(roster, 'c1').length, 1);
});

test('incomplete baseline, other contest and unsupported star rank cannot show numbers', () => {
  assert.equal(effect(baseline(), baseline(), { baseline: { ready: false } }).status, 'UNAVAILABLE');
  assert.equal(effect(baseline(), baseline(), { contestId: 'another' }).status, 'UNAVAILABLE');
  const star = baseline().map(value => value.type === 'teams' && value.remoteId === 'two' ? { ...value, payload: { id: 'two', group_ids: ['1'] } } : value);
  assert.equal(effect(star, star).status, 'UNAVAILABLE');
});

test('mismatched event clock and unknown same-millisecond attempt ordering fail closed', () => {
  const wrongTime = submit('s', 'one', 'A', 10); (wrongTime.payload as Record<string, unknown>).contest_time = '0:09:00.000';
  assert.equal(effect([...baseline(), wrongTime], [...baseline(), wrongTime]).status, 'UNAVAILABLE');
  const tied = [...baseline(), submit('a', 'one', 'A', 10), judge('a', 'WA', 601), submit('s', 'one', 'A', 10), judge('s', 'AC', 602)];
  assert.equal(effect(tied, tied).status, 'UNAVAILABLE');
});

test('nontransactional snapshot and a newly introduced team/problem cannot silently alter ranks', () => {
  const orphan = [...baseline(), judge('unseen', 'AC', 601)];
  assert.equal(effect(orphan, orphan).reason, 'SNAPSHOT_HAS_ORPHAN_JUDGEMENT');
  const unknownTeam = [...baseline(), submit('s', 'new-team', 'A', 10)];
  assert.equal(effect(unknownTeam, unknownTeam).reason, 'TEAM_ROSTER_OUT_OF_DATE');
  const unknownProblem = [...baseline(), submit('s', 'one', 'new-problem', 10)];
  assert.equal(effect(unknownProblem, unknownProblem).reason, 'PROBLEM_SET_OUT_OF_DATE');
});

test('presentation context is bound to contest, team, submission, and original verdict', () => {
  const context = effect(baseline(), baseline());
  assert(parseReactionRankContext(context, { contestId: 'c1', teamId: 'one', submissionId: 's', verdict: 'AC' }));
  assert.equal(parseReactionRankContext(context, { contestId: 'c1', teamId: 'one', submissionId: 's', verdict: 'WA' }), null);
  assert.equal(parseReactionRankContext({ ...context, beforeRank: 0 }), null);
});

test('historical reconstruction uses captured verdict history, not current final verdict as history', () => {
  const proof = { observedAt: at(1000).toISOString(), source: 'LOCAL_NOVAJUDGE_READ_ONLY_DATABASE' as const,
    contest: { id: 1, startTime: at(0).toISOString(), endTime: at(18000).toISOString(), createdAt: at(-100).toISOString() },
    teams: [{ id: 'user-one', username: 'one', category: null, createdAt: at(-10).toISOString() }],
    problems: [{ problemId: 1, displayId: 'A' }], submissions: [{ id: 's', userId: 'user-one', problemId: 1, submittedAt: at(600).toISOString(), verdict: 'ACCEPTED' }] };
  const target = { submissionId: 's', teamId: 'one', problemId: '1', sourceSubmittedAt: at(600), judgementObservedAt: at(610), originalVerdict: 'AC', verdictHistory: [{ judgementId: 'j-s', verdict: 'AC', op: 'create', observedAt: at(610).toISOString() }] };
  const context = reconstructHistoricalReactionRankContext(proof, [target], target);
  assert.equal(context.status, 'AVAILABLE'); assert.equal(context.beforeRank, 1); assert.equal(context.afterRank, 1);
  assert.equal(context.source, 'HISTORICAL_CCS_RECONSTRUCTION'); assert.equal(context.provenance.currentVerdictsUsedAsHistory, false);
  assert.equal(reconstructHistoricalReactionRankContext(proof, [{ ...target, verdictHistory: [] }], target).status, 'UNAVAILABLE');
  assert.equal(reconstructHistoricalReactionRankContext({ ...proof, submissions: [{ ...proof.submissions[0], verdict: 'WRONG_ANSWER' }] }, [target], target).status, 'UNAVAILABLE');
});
