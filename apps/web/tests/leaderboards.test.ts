import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateLeaderboards } from '../src/lib/leaderboards';
import { scoreRows, type Rule, type RankingCandidate, type ScoreRecord } from '../src/lib/contest-rules';
import { GPLT_GROUPS, LANQIAO_GROUPS, filterLeaderboardRows, leaderboardScoreClass, normalizeParticipationGroup, participationOptions } from '@cwnupaa/proctor-shared/leaderboard';

const start = new Date('2026-10-09T00:00:00Z'), end = new Date('2026-10-09T02:00:00Z');
const exam = (contestRule: Rule) => ({ contestRule, contestType: 'INDIVIDUAL' as const, startAt: start, latestStartAt: start, endAt: end, durationMinutes: 120 });
const user = (id: string, groupName = 'official', ranked = true): RankingCandidate => ({ id, examNumber: id, name: id, teamName: null, groupName, ranked, school: '大学', college: '计算机学院' });
const run = (id: string, candidateId: string, problemId: string, seconds: number, score = 100, status = 1): ScoreRecord => ({ id, candidateId, problemId, score, status, createdAt: new Date(+start + seconds * 1000) });
const problems = [{ id: 'a', score: 100 }, { id: 'b', score: 100 }];

test('XCPC uses one global ranking, keeps stars, and filters without renumbering', () => {
  const board = calculateLeaderboards(exam('XCPC'), problems, [user('star', '打星参赛'), user('girl', '女生队伍'), user('official')], [
    run('s1', 'star', 'a', 10), run('s2', 'star', 'b', 20), run('g', 'girl', 'a', 30), run('o', 'official', 'a', 40)
  ], end, true);
  assert.deepEqual(board.groups, []);
  assert.deepEqual(board.rows.map(row => [row.username, row.rank]), [['star', -1], ['girl', 1], ['official', 2]]);
  assert.deepEqual(filterLeaderboardRows(board.rows, 'XCPC', '', 'official', '').map(row => row.rank), [1, 2]);
  assert.deepEqual(filterLeaderboardRows(board.rows, 'XCPC', '', 'girl', '').map(row => row.username), ['girl']);
  assert.deepEqual(filterLeaderboardRows(board.rows, 'XCPC', '', 'star', '').map(row => row.username), ['star']);
  assert.equal(board.rows[0].institution, '计算机学院');
});

test('XCPC compares the exact cumulative penalty, with no last-AC tiebreak', () => {
  const board = calculateLeaderboards(exam('XCPC'), problems, [user('late'), user('early')], [
    run('la', 'late', 'a', 600), run('lb', 'late', 'b', 1800),
    run('ea', 'early', 'a', 1200), run('eb', 'early', 'b', 1200)
  ], end, true);
  assert.deepEqual(board.rows.map(row => row.rank), [1, 1]);
  const millis = scoreRows(exam('XCPC'), problems, [user('late'), user('early')], [run('l', 'late', 'a', 61.9), run('e', 'early', 'a', 61.1)], end, true).rows;
  assert.deepEqual(millis.map(row => [row.username, row.rank, row.penalty]), [['early', 1, 60], ['late', 2, 60]]);
});

test('first AC includes tied timestamps and ignores nonparticipants', () => {
  const board = scoreRows(exam('XCPC'), problems, [user('a'), user('b')], [run('outside', 'outsider', 'a', 1), run('aa', 'a', 'a', 10), run('ba', 'b', 'a', 10)], end, true);
  assert.ok(board.rows.every(row => row.cells[0].firstBlood));
});

test('GPLT best score uses ceiling and earliest time at the rounded score, excluding CE', () => {
  const rows = scoreRows(exam('GPLT'), [{ id: 'a', score: 10 }], [user('a', GPLT_GROUPS[0]), user('b', GPLT_GROUPS[0])], [
    run('a1', 'a', 'a', 10.1, 31, 2), run('a2', 'a', 'a', 20, 39, 2), run('ace', 'a', 'a', 30, 100, 7), run('b1', 'b', 'a', 10.9, 39, 2)
  ], end, true).rows;
  assert.deepEqual(rows.map(row => [row.username, row.score, row.rank, row.penaltyMillis]), [['a', 4, 1, 10100], ['b', 4, 2, 10900]]);
});

test('LANQIAO is live, keeps fixed language groups and uses the highest rounded score', () => {
  const board = calculateLeaderboards(exam('LANQIAO'), [{ id: 'a', score: 80 }], [user('a', LANQIAO_GROUPS[0])], [run('best', 'a', 'a', 10, 33, 2), run('lower', 'a', 'a', 20, 10, 2), run('ce', 'a', 'a', 30, 100, 7)], new Date(+start + 60_000));
  assert.equal(board.available, true);
  assert.equal(board.rows[0].score, 26);
  assert.deepEqual(board.groups, [...LANQIAO_GROUPS]);
  assert.deepEqual(filterLeaderboardRows(board.rows, 'LANQIAO', '', 'all', ''), []);
  assert.equal(filterLeaderboardRows(board.rows, 'LANQIAO', LANQIAO_GROUPS[0], 'all', '计算机').length, 1);
});

test('leaderboards normalize non-100 Hydro points before applying exam weights and contest rounding', () => {
  // Hydro points must be normalized; the exam maximum remains independent.
  const weighted = [
    { id: 'small', hydroScore: 24, scorePercent: 10, score: 10 },
    { id: 'large', hydroScore: 200, scorePercent: 40, score: 40 },
    { id: 'uneven', hydroScore: 60, scorePercent: 33, score: 33 },
    { id: 'zero', hydroScore: 50, scorePercent: 0, score: 0 },
  ];
  const records = [run('s', 'u', 'small', 10, 23, 2), run('l', 'u', 'large', 20, 150, 2),
    run('u', 'u', 'uneven', 30, 59, 2), run('z', 'u', 'zero', 40, 50)];
  for (const rule of ['IOI', 'OI', 'KS', 'GPLT', 'LANQIAO'] as const) {
    const row = calculateLeaderboards(exam(rule), weighted, [user('u')], records, end, true).rows[0];
    const expected = rule === 'GPLT' ? [10, 30, 33, 0] : rule === 'LANQIAO' ? [10, 30, 32, 0] : [9.58, 30, 32.45, 0];
    assert.deepEqual(row.problemScores, expected, rule);
    assert.deepEqual(row.cells.map(cell => cell.score), expected, rule);
    assert.equal(row.score, expected.reduce((total, score) => total + score, 0), rule);
  }
});

test('non-100 Hydro full scores still scale legacy problems without an explicit percentage', () => {
  const row = calculateLeaderboards(exam('IOI'), [{ id: 'a', score: 80, hydroScore: 200 }], [user('u')],
    [run('r', 'u', 'a', 10, 150, 2)], end, true).rows[0];
  assert.equal(row.score, 60);
});

test('manual scores remain final exam points when Hydro full scores are not 100', () => {
  const row = calculateLeaderboards(exam('KS'), [{ id: 'a', hydroScore: 200, scorePercent: 40, score: 80 }], [user('u')],
    [{ ...run('r', 'u', 'a', 10, 150, 2), manualScore: 72 }], end, true).rows[0];
  assert.equal(row.score, 72);
});

test('GPLT teams include all member scores, preserve stars and rank independently by group', () => {
  const candidates = [user('a', GPLT_GROUPS[0]), user('b', GPLT_GROUPS[0]), user('c', GPLT_GROUPS[1]), user('star', GPLT_GROUPS[0], false)];
  candidates[0].teamName = candidates[1].teamName = '一队'; candidates[2].teamName = '二队'; candidates[3].teamName = '打星队';
  const board = calculateLeaderboards({ ...exam('GPLT'), contestType: 'TEAM' }, problems, candidates, candidates.map((candidate, index) => run(`r${index}`, candidate.id, 'a', 10, 50)), end, true);
  const teams = board.boards.find(item => item.key === 'team')!.rows;
  assert.equal(teams.find(row => row.username === '一队')!.score, 100);
  assert.equal(teams.find(row => row.username === '一队')!.members, 'a, b');
  assert.equal(teams.find(row => row.username === '二队')!.rank, 1);
  assert.equal(teams.find(row => row.username === '打星队')!.rank, -1);
  assert.deepEqual(board.groups, [...GPLT_GROUPS]);
});

test('GPLT team totals sum member scores rounded after applying non-100 Hydro percentages', () => {
  const candidates = [user('a', GPLT_GROUPS[0]), user('b', GPLT_GROUPS[0])].map(candidate => ({ ...candidate, teamName: '一队' }));
  const board = calculateLeaderboards({ ...exam('GPLT'), contestType: 'TEAM' },
    [{ id: 'a', hydroScore: 24, scorePercent: 10, score: 10 }], candidates,
    [run('a', 'a', 'a', 10, 11, 2), run('b', 'b', 'a', 20, 10, 2)], end, true);
  assert.deepEqual(board.rows.map(row => row.score), [5, 5]);
  assert.equal(board.boards.find(item => item.key === 'team')!.rows[0].score, 10);
});

test('GPLT medals use 10%, 20%, 30% quotas of official entries, excluding stars', () => {
  const candidates = Array.from({ length: 12 }, (_, index) => user(String(index).padStart(2, '0'), GPLT_GROUPS[0]));
  candidates.unshift(user('star', GPLT_GROUPS[0], false));
  const rows = scoreRows(exam('GPLT'), problems, candidates, candidates.map((candidate, index) => run(`r${index}`, candidate.id, 'a', index + 1)), end, true).rows;
  assert.equal(rows[0].rank, -1); assert.equal(rows[0].medal, undefined);
  assert.deepEqual(rows.filter(row => row.medal).map(row => row.medal), ['Gold', 'Silver', 'Silver', 'Bronze', 'Bronze', 'Bronze']);
});

test('XCPC team submissions merge and all-female teams participate in the girl filter', () => {
  const candidates = [user('a'), user('b')].map(candidate => ({ ...candidate, teamName: '女生队', gender: '女' }));
  const board = calculateLeaderboards({ ...exam('XCPC'), contestType: 'TEAM' }, problems, candidates, [run('ra', 'a', 'a', 30), run('rb', 'b', 'b', 60)], end, true);
  assert.equal(board.rows.length, 1); assert.equal(board.rows[0].solved, 2);
  assert.equal(filterLeaderboardRows(board.rows, 'XCPC', '', 'girl', '').length, 1);
});

test('snapshots and frozen cells retain visible errors and the last pending submission time', () => {
  const frozenExam = { ...exam('XCPC'), scoreboardFrozenAt: new Date(+start + 60_000) };
  const records = [run('wa', 'a', 'a', 30, 0, 2), run('ac', 'a', 'a', 90)];
  const board = scoreRows(frozenExam, problems, [user('a')], records, new Date(+start + 100_000), true);
  assert.equal(board.frozen, true); assert.equal(board.rows[0].cells[0].wrong, 1);
  assert.equal(board.rows[0].cells[0].pending, 1); assert.equal(board.rows[0].cells[0].seconds, 90);
  assert.equal(board.rows[0].solved, 0);
  assert.equal(scoreRows(frozenExam, problems, [user('a')], records, end, true).rows[0].solved, 1);
  assert.equal(scoreRows(exam('XCPC'), problems, [user('a')], records, new Date(+start + 40_000), true).rows[0].solved, 0);
});

test('participation options and zero-score cells match the reference', () => {
  assert.deepEqual(participationOptions('XCPC').map(option => option.label), ['正式参赛', '女生队伍', '打星参赛']);
  assert.equal(normalizeParticipationGroup('XCPC', '正式队伍'), 'official');
  assert.equal(normalizeParticipationGroup('XCPC', ''), 'official');
  assert.equal(leaderboardScoreClass(null, 100), 'cell-problem-empty');
  assert.equal(leaderboardScoreClass(0, 100), 'cell-score-level-1');
  assert.equal(leaderboardScoreClass(75, 100), 'cell-score-level-3');
});
