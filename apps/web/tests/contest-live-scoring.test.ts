import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isContestLiveSupported } from '../src/lib/contest-live-contract';
import { contestLiveSceneSchema } from '../src/lib/contest-live-presets';
import { contestLivePresentation, liveRoster, type LiveExam, type LiveRosterEntry, type LiveSnapshot } from '../src/lib/contest-live-scoring';
import { contestLiveSettingsPatchSchema, defaultContestLiveSettings, mergeContestLiveSettings, readContestLiveSettings } from '../src/lib/contest-live-settings';

const startAt = new Date('2026-11-17T01:00:00Z');
const at = (minutes: number) => new Date(+startAt + minutes * 60_000);
const exam: LiveExam = {
  id: 'exam', name: '测试赛', startAt, latestStartAt: startAt, endAt: at(180), durationMinutes: 180,
  contestType: 'TEAM', contestRule: 'XCPC', scoreboardFrozenAt: at(120), showObjectiveScore: false,
};
const candidate = (id: string, examNumber: string, teamName: string, hydroAccount: string | null,
  memberOrder = 1): LiveRosterEntry => ({ id, examNumber, teamName, hydroAccount, name: examNumber, school: '学校', memberOrder });
const entries = [candidate('first', '001', '蓝队', 'blue'), candidate('second', '002', '蓝队', null, 2),
  candidate('third', '003', '红队', 'red')];
const snapshot: LiveSnapshot = {
  capturedAt: at(150), problems: [{ id: 'A', label: 'A', name: '一题', color: '#325678', maxScore: 100, hydroScore: 100 }],
  runs: [
    { id: 'mismatch', candidateId: 'other', problemId: 'A', createdAt: at(5), status: 1, verdict: 'Accepted', score: 100 },
    { id: 'wrong', candidateId: 'second', problemId: 'A', createdAt: at(10), status: 2, verdict: 'Wrong Answer', score: 0 },
    { id: 'ac', candidateId: 'first', problemId: 'A', createdAt: at(12), status: 1, verdict: 'Accepted', score: 100 },
    { id: 'hidden', candidateId: 'third', problemId: 'A', createdAt: at(121), status: 1, verdict: 'Accepted', score: 100 },
  ],
};

test('contest live is available to browser contests and local XCPC contests', () => {
  assert.equal(isContestLiveSupported('HYDRO_BROWSER', 'IOI'), true);
  assert.equal(isContestLiveSupported('NOVAJUDGE', 'XCPC'), true);
  assert.equal(isContestLiveSupported('HYDRO', 'XCPC'), true);
  assert.equal(isContestLiveSupported('HYDRO', 'ACM'), true);
  assert.equal(isContestLiveSupported('HYDRO', 'IOI'), false);
});

test('the pre-start scoreboard lists the roster and releases problem data at the scheduled start', () => {
  const before = new Date(+startAt - 1);
  const participants = entries.map(entry => ({ ...entry, ranked: entry.id !== 'third' }));
  const roster = liveRoster(exam, participants, 'hydro');
  const feed = { ...snapshot, capturedAt: before };
  const scenes = ['problemDetailChart', 'scoreboardChart'] as const;
  const waiting = contestLivePresentation(exam, 'hydro', roster, feed, null, before, 'all', 'optimistic', undefined, scenes);
  assert.equal(waiting.exam.beforeStart, true);
  assert.deepEqual(waiting.teams.map(team => [team.id, team.isOutOfContest]), [['first', false], ['third', true]]);
  assert.deepEqual(waiting.standings.map(row => [row.teamId, row.rank, row.medal, row.cells]), [
    ['first', null, null, []], ['third', null, null, []],
  ]);
  assert.deepEqual([waiting.problems, waiting.submissions, waiting.timeline, waiting.statistics], [[], [], [], []]);
  assert.equal(waiting.displayCharts, undefined);
  assert.equal(JSON.stringify(waiting).includes(feed.problems[0].name), false);
  const offline = contestLivePresentation(exam, 'hydro', roster, null, '同步失败', before);
  assert.deepEqual(offline.standings, waiting.standings);
  assert.equal(offline.sourceError, '同步失败');

  const started = contestLivePresentation(exam, 'hydro', roster, feed, null, startAt, 'all', 'normal', undefined, scenes);
  assert.equal(started.exam.beforeStart, false);
  assert.deepEqual(started.problems.map(problem => problem.name), [feed.problems[0].name]);
  assert.deepEqual(started.standings.map(row => [row.teamId, row.rank, row.cells.length]), [['first', 1, 1], ['third', null, 1]]);
  assert.equal(started.statistics.length, 1);
  assert.equal(started.submissions.length, 0);
  assert.equal(started.displayCharts?.problems.length, 1);
});

test('external submissions from roster accounts with no sessions appear under the same team as other member accounts', () => {
  const roster = liveRoster(exam, entries, 'hydro');
  assert.equal(roster.byAccount.get('blue'), 'first');
  assert.equal(roster.byCandidate.get('second'), 'first');
  assert.deepEqual(roster.teams[0].accounts, ['001', '002', 'blue']);
  const data = contestLivePresentation(exam, 'hydro', roster, snapshot, null, at(119));
  assert.deepEqual(data.submissions.map(run => [run.id, run.teamId]), [['ac', 'first'], ['wrong', 'first']]);
  assert.equal(data.submissions[0].firstBlood, true);
  assert.equal(data.standings[0].solved, 1);
  assert.equal(data.standings[0].penaltySeconds, 32 * 60);
});

test('conflicting aliases are ignored and roster account names retain their exact identities', () => {
  const roster = liveRoster(exam, [...entries, candidate('fourth', '004', '黄队', 'blue'), candidate('fifth', '005', '绿队', '001')], 'hydro');
  assert.equal(roster.byAccount.has('blue'), false);
  assert.equal(roster.byAccount.get('001'), 'first');
  assert.equal(roster.byAccount.has('1'), false);
});

test('broadcast labels follow the exam organization field and keep team membership and standings stable', () => {
  const members = entries.map(entry => ({ ...entry, school: '西华师范大学', college: '计算机学院' }));
  const collegeExam = { ...exam, reactionLogoMatchBy: 'COLLEGE' } as const;
  const school = liveRoster(exam, members, 'hydro');
  const college = liveRoster(collegeExam, members, 'hydro');
  const custom = liveRoster(collegeExam, members, 'hydro', '{team.name}（{school.name} / {college.name}）');
  assert.equal(school.teams[0].name, '西华师范大学: 蓝队');
  assert.equal(college.teams[0].name, '计算机学院: 蓝队');
  assert.equal(custom.teams[0].name, '蓝队（西华师范大学 / 计算机学院）');
  assert.equal(custom.teams[0].organization, '计算机学院');
  assert.deepEqual(custom.teams[0].members, ['001', '002']);
  assert.deepEqual(custom.byAccount, school.byAccount);
  assert.deepEqual(custom.byCandidate, school.byCandidate);
  assert.deepEqual(contestLivePresentation(exam, 'hydro', school, snapshot, null, at(150)).standings,
    contestLivePresentation(collegeExam, 'hydro', custom, snapshot, null, at(150)).standings);
});

test('individual display names use the selected field exactly and handle missing affiliations and literal names', () => {
  const personal = { ...exam, contestType: 'INDIVIDUAL' } as const;
  const entry = { ...entries[0], teamName: null, name: '张三', school: '  ', college: '计算机学院' };
  assert.equal(liveRoster(personal, [entry], 'nova').teams[0].name, '张三');
  assert.equal(liveRoster(personal, [entry], 'nova', '{college.name} · {team.name}').teams[0].name, '计算机学院 · 张三');
  const literal = { ...entry, name: '$&{org.name}', school: '西华师范大学' };
  assert.equal(liveRoster(personal, [literal], 'local', '【{team.name}】{school.name}').teams[0].name, '【$&{org.name}】西华师范大学');
  assert.equal(liveRoster({ ...exam, contestRule: 'GPLT' }, entries, 'local', '{team.name}').teams[0].name, '001');
  assert.equal(liveRoster(personal, [{ ...entry, name: null, college: null }], 'nova').teams[0].name, entry.examNumber);
});

test('existing contests get the default template and scene presets preserve the contest-wide choice', () => {
  const legacy = readContestLiveSettings({ widgets: { queue: false } });
  assert.equal(legacy.teamNameTemplate, '{org.name}: {team.name}');
  assert.equal(legacy.widgets.queue, false);
  const patch = contestLiveSettingsPatchSchema.parse({ teamNameTemplate: '  {team.name} @ {college.name}  ' });
  const saved = readContestLiveSettings(JSON.parse(JSON.stringify(mergeContestLiveSettings(legacy, patch))));
  assert.equal(saved.teamNameTemplate, '{team.name} @ {college.name}');
  const scene = contestLiveSceneSchema.strip().parse(legacy);
  assert.equal('teamNameTemplate' in scene, false);
  assert.equal(mergeContestLiveSettings(saved, scene).teamNameTemplate, saved.teamNameTemplate);
  for (const template of ['', '{unknown.name}', '{org.name', '{{team.name}}', '{team.name}\n{org.name}', 'x'.repeat(181)]) {
    assert.equal(contestLiveSettingsPatchSchema.safeParse({ teamNameTemplate: template }).success, false);
  }
});

test('display timeline retains older roster runs without expanding the live queue or revealing frozen verdicts', () => {
  const roster = liveRoster(exam, entries, 'hydro');
  const wrong = snapshot.runs[1];
  const extended = {
    ...snapshot,
    runs: [...snapshot.runs, ...Array.from({ length: 300 }, (_, index) => ({
      ...wrong, id: `recent-${index}`, createdAt: new Date(+at(20) + 1000 * index),
    }))],
  };
  const display = contestLivePresentation(exam, 'hydro', roster, extended, null, at(150), 'all');
  assert.equal(display.submissions.length, 250);
  assert.equal(display.submissions.some(run => run.id === 'wrong'), false);
  assert.equal(display.timeline.length, 303);
  assert.equal(display.timeline[0].id, 'wrong');
  assert.equal(display.timeline.some(run => run.id === 'mismatch'), false);
  assert.deepEqual(display.timeline.map(run => run.verdict).slice(-1), [null]);
});

test('display charts keep frozen verdicts and judgement times out until reveal', () => {
  const roster = liveRoster(exam, entries, 'local');
  const timed = { ...snapshot, runs: snapshot.runs.map(run => ({
    ...run, language: 'C++', judgedAt: new Date(+run.createdAt + (run.id === 'hidden' ? 12_000 : 3000)),
  })) };
  const scenes = ['languageSummaryChart', 'judgementChart', 'judgeQueueDepthChart'] as const;
  const freezeAt = at(120).toISOString();
  const frozen = contestLivePresentation(exam, 'local', roster, timed, null, at(150), [], 'normal', { at: freezeAt, revealed: false }, scenes).displayCharts!;
  assert.equal(frozen.problems[0].frozen?.reduce((sum, value) => sum + value, 0), 1);
  assert.deepEqual(frozen.problems[0].judgement, { solvedMs: 3000, failedMs: 3000 });
  assert.deepEqual(frozen.languages, [{ name: 'C++', attempts: 3, solved: 1 }]);
  assert.equal(frozen.queueDepth?.values[121 * 60], 0);
  const revealed = contestLivePresentation(exam, 'local', roster, timed, null, at(150), [], 'normal', { at: freezeAt, revealed: true }, scenes).displayCharts!;
  assert.equal(revealed.problems[0].frozen?.reduce((sum, value) => sum + value, 0), 0);
  assert.equal(revealed.problems[0].judgement?.solvedMs, 7500);
  assert.equal(revealed.languages?.[0].solved, 2);
  assert.equal(revealed.queueDepth?.values[121 * 60], 1);
});

test('live queues, rankings and statistics hide frozen verdicts until the applicable source releases them', () => {
  const roster = liveRoster(exam, entries, 'hydro');
  const frozenSource = { ...snapshot, remoteFrozenAt: at(120).toISOString() };
  const frozen = contestLivePresentation(exam, 'hydro', roster, frozenSource, null, at(181));
  assert.equal(frozen.exam.frozen, true);
  assert.deepEqual([frozen.submissions[0].verdict, frozen.submissions[0].score], [null, null]);
  assert.equal(frozen.submissions[0].frozen, true);
  assert.equal(frozen.submissions[1].frozen, undefined);
  assert.equal(frozen.standings[1].cells[0].frozen, true);
  assert.equal(frozen.standings[1].solved, 0);
  assert.deepEqual(frozen.statistics, [{ problemId: 'A', accepted: 1, rejected: 1, pending: 1,
    teamsAccepted: 1, teamsRejected: 0, teamsPending: 1 }]);
  const unlocked = contestLivePresentation(exam, 'hydro', roster, snapshot, null, at(181));
  assert.equal(unlocked.exam.frozen, false);
  assert.equal(unlocked.submissions[0].verdict, 'Accepted');
  assert.equal(unlocked.standings[1].solved, 1);
});

test('frozen scoreboard projections are independent of the actual verdict and leave the queue masked', () => {
  const roster = liveRoster(exam, entries, 'nova');
  const changed = { ...snapshot, runs: snapshot.runs.map(run => run.id === 'hidden'
    ? { ...run, status: 2, verdict: 'Wrong Answer', score: 0 } : run) };
  for (const mode of ['optimistic', 'pessimistic'] as const) {
    const a = contestLivePresentation(exam, 'nova', roster, snapshot, null, at(150), ['third'], mode);
    const b = contestLivePresentation(exam, 'nova', roster, changed, null, at(150), ['third'], mode);
    assert.deepEqual(a, b);
    assert.equal(a.standings.find(row => row.teamId === 'third')?.solved, mode === 'optimistic' ? 1 : 0);
    assert.equal(a.timeline[0].verdict, null);
  }
});

test('manual freeze replaces automatic scheduling, persists after end and can be released separately from native Hydro', () => {
  const roster = liveRoster(exam, entries, 'hydro');
  const at = '2026-11-17T02:00:00.000Z';
  const awaiting = mergeContestLiveSettings(defaultContestLiveSettings, { freeze: { at } });
  const revealed = mergeContestLiveSettings(awaiting, { freeze: { revealed: true } });
  assert.deepEqual(readContestLiveSettings(revealed).freeze, { at, revealed: true });
  const later = new Date(+exam.endAt + 1000);
  const manual = contestLivePresentation(exam, 'hydro', roster, snapshot, null, later, [], 'normal', awaiting.freeze);
  assert.deepEqual([manual.exam.freezeAt, manual.exam.frozen, manual.submissions[0].verdict], [at, true, null]);
  const visible = contestLivePresentation(exam, 'hydro', roster, snapshot, null, later, [], 'normal', revealed.freeze);
  assert.equal(visible.submissions[0].verdict, 'Accepted');
  const native = contestLivePresentation(exam, 'hydro', roster, { ...snapshot, remoteFrozenAt: at }, null, later, [], 'normal', revealed.freeze);
  assert.equal(native.submissions[0].verdict, null);
});

test('overlay title widgets can be hidden independently and legacy visibility still applies to all', () => {
  const visible = mergeContestLiveSettings(defaultContestLiveSettings, { titles: { visible: true } });
  const independent = mergeContestLiveSettings(visible, { titles: { advertisementVisible: false } });
  assert.deepEqual(
    ['titleVisible', 'advertisementVisible', 'pictureVisible'].map(key => independent.titles[key as 'titleVisible' | 'advertisementVisible' | 'pictureVisible']),
    [true, false, true],
  );
  assert.equal(readContestLiveSettings(JSON.parse(JSON.stringify(independent))).titles.advertisementVisible, false);
  assert.equal(mergeContestLiveSettings(independent, { titles: { visible: false } }).titles.titleVisible, false);
});
