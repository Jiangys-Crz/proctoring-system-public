import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { normalizeExamSettings } from '../src/lib/exam-settings';
import { canCandidateLogin, candidateLoginError, candidateLoginOpensAt, candidateStartDeadline, effectiveEnd, judgeObjectiveImmediately, scoreRows } from '../src/lib/contest-rules';
import { allowedProblemLanguages, languageFamily } from '../src/lib/exam-languages';
import { submissionVisibility } from '../src/lib/submission-visibility';
import { serializeLocalContest } from '../src/lib/local-contest';
import { problemLimits } from '../src/lib/problem-limits';
import { allSessionsFullyOfflineForRelogin, sessionFullyOfflineForRelogin } from '../src/lib/client-session-policy';
import { calculateLeaderboards } from '../src/lib/leaderboards';
import { canCandidateSubmit, canViewTeamSubmissions } from '../src/lib/contest-format';
import { candidateIdentityLookup } from '../src/lib/candidate-identity';

const base = CreateExamSchema.parse({ name: '考试', startAt: '2026-09-25T08:00:00Z', latestStartAt: '2026-09-25T09:00:00Z', endAt: '2030-01-01', durationMinutes: 120, platform: 'HYDRO', contestType: 'INDIVIDUAL', contestRule: 'IOI' });
test('full recording is opt-in and is independent of camera requirements', () => {
  assert.equal(base.saveFullRecording, false);
  const enabled = CreateExamSchema.parse({ ...base, saveFullRecording: true, requireMiniProgram: false, requireFrontCamera: false });
  assert.equal(enabled.saveFullRecording, true);
  assert.equal(enabled.requireFrontCamera, false);
  assert.equal(CreateExamSchema.parse({ ...enabled, saveFullRecording: false }).saveFullRecording, false);
});
test('candidate student IDs are unique only within the current exam', () => {
  assert.deepEqual(candidateIdentityLookup('exam-b', '西华师范大学'), { examId: 'exam-b', school: '西华师范大学' });
  assert.deepEqual(candidateIdentityLookup('exam-b', '西华师范大学', 'candidate-b'), {
    examId: 'exam-b', school: '西华师范大学', id: { not: 'candidate-b' }
  });
});
test('printing is disabled by default and preserves virtual, physical, and legacy settings', () => {
  assert.equal(base.allowPrint, false);
  assert.equal(normalizeExamSettings(base).printMode, 'DISABLED');
  assert.equal(normalizeExamSettings(CreateExamSchema.parse({ ...base, printMode: 'VIRTUAL' })).printMode, 'VIRTUAL');
  assert.equal(normalizeExamSettings(CreateExamSchema.parse({ ...base, printMode: 'PHYSICAL' })).printMode, 'PHYSICAL');
  assert.equal(normalizeExamSettings(CreateExamSchema.parse({ ...base, allowPrint: true })).printMode, 'PHYSICAL');
});
test('team submission access is closed by default and can be enabled independently', () => {
  assert.equal(base.allowTeamSubmissionView, false);
  assert.equal(base.leaderOnlySubmission, false);
  const team = CreateExamSchema.parse({ ...base, contestType: 'TEAM', allowTeamSubmissionView: true, leaderOnlySubmission: true });
  assert.equal(team.allowTeamSubmissionView, true);
  assert.equal(team.leaderOnlySubmission, true);
});
test('unified time, overnight end, and admission deadline are computed server-side', () => {
  const time = normalizeExamSettings({ ...base, startAt: new Date('2026-09-25T23:30:00Z') });
  assert.equal(time.endAt.toISOString(), '2026-09-26T01:30:00.000Z');
  assert.equal(time.latestStartAt.toISOString(), '2026-09-25T23:45:00.000Z');
  assert.equal(time.flexible, false);
  const sameStart = normalizeExamSettings({ ...base, flexible: true, latestStartAt: base.startAt });
  assert.equal(sameStart.flexible, false);
  assert.equal(sameStart.latestStartAt.toISOString(), '2026-09-25T08:15:00.000Z');
});
test('unified-time exams only admit unstarted candidates for fifteen minutes', () => {
  const exam = { ...base, ...normalizeExamSettings(base) };
  assert.equal(canCandidateLogin(exam, null, new Date('2026-09-25T08:15:00Z')), true);
  assert.equal(canCandidateLogin(exam, null, new Date('2026-09-25T08:15:01Z')), false);
  assert.equal(canCandidateLogin(exam, new Date('2026-09-25T08:05:00Z'), new Date('2026-09-25T09:30:00Z')), true);
  assert.equal(effectiveEnd(exam, new Date('2026-09-25T08:05:00Z')).toISOString(), '2026-09-25T10:00:00.000Z');
});
test('every formal format opens login exactly forty minutes before its start, including flexible exams and relogin', () => {
  for (const contestRule of ['OI', 'IOI', 'KS', 'GPLT', 'LANQIAO', 'XCPC', 'ACM'] as const) {
    for (const flexible of [false, true]) {
      const exam = { ...base, ...normalizeExamSettings({ ...base, contestRule, flexible }), contestRule };
      const opens = candidateLoginOpensAt(exam);
      assert.equal(opens.toISOString(), '2026-09-25T07:20:00.000Z');
      for (const startedAt of [null, new Date('2026-09-25T07:00:00Z')]) {
        assert.equal(canCandidateLogin(exam, startedAt, new Date(+opens - 1)), false);
        assert.match(candidateLoginError(exam, startedAt, new Date(+opens - 1)), /开始前 40 分钟/);
        assert.equal(canCandidateLogin(exam, startedAt, opens), true);
        assert.equal(canCandidateLogin(exam, startedAt, new Date(+opens + 1)), true);
      }
      assert.equal(canCandidateLogin(exam, null, new Date(+opens - 1), true), true, 'public tests skip the opening gate');
      assert.equal(canCandidateLogin(exam, null, exam.endAt, true), false, 'public tests still respect the end');
    }
  }
});
test('flexible exam grants full duration to the latest start and caps personal end', () => {
  const time = normalizeExamSettings({ ...base, flexible: true });
  assert.equal(time.endAt.toISOString(), '2026-09-25T11:00:00.000Z');
  assert.equal(effectiveEnd({ ...base, ...time }, new Date('2026-09-25T08:30:00Z')).toISOString(), '2026-09-25T10:30:00.000Z');
  assert.throws(() => normalizeExamSettings({ ...base, flexible: true, latestStartAt: new Date('2026-09-24') }), /不能早于/);
});
test('a candidate who already started can log in again after the admission deadline', () => {
  const exam = { ...base, ...normalizeExamSettings({ ...base, flexible: true }) };
  const startedAt = new Date('2026-09-25T08:30:00Z');
  assert.equal(canCandidateLogin(exam, null, new Date('2026-09-25T09:00:01Z')), false);
  assert.equal(canCandidateLogin(exam, startedAt, new Date('2026-09-25T09:00:01Z')), true);
  assert.equal(canCandidateLogin(exam, startedAt, new Date('2026-09-25T10:30:00Z')), false);
});
test('individual late-start permission permits admission until the exam end and preserves both timing modes', () => {
  for (const flexible of [false, true]) {
    const exam = { ...base, ...normalizeExamSettings({ ...base, flexible }) };
    const late = new Date(+candidateStartDeadline(exam) + 1);
    assert.equal(canCandidateLogin(exam, null, late), false);
    assert.equal(canCandidateLogin(exam, null, late, false, late), true);
    assert.equal(+candidateStartDeadline(exam, late), +exam.endAt);
    assert.equal(canCandidateLogin(exam, null, exam.endAt, false, late), false);
    assert.equal(canCandidateLogin(exam, null, new Date(+candidateLoginOpensAt(exam) - 1), false, late), false);
    const startedAt = new Date(+exam.startAt + 60_000);
    assert.equal(canCandidateLogin(exam, startedAt, effectiveEnd(exam, startedAt), false, late), false);
    assert.equal(+effectiveEnd(exam, late), flexible ? Math.min(+exam.endAt, +late + exam.durationMinutes * 60_000) : +exam.endAt);
  }
});
test('relogin expires every active session only after all required sides are offline for two minutes', () => {
  const now = new Date('2026-09-25T09:02:00Z');
  const stale = { createdAt: new Date('2026-09-25T08:00:00Z'), lastDesktopSeenAt: new Date('2026-09-25T09:00:00Z'), lastMiniProgramSeenAt: new Date('2026-09-25T09:00:00Z') };
  const desktopAlive = { ...stale, lastDesktopSeenAt: new Date('2026-09-25T09:01:30Z') };
  const miniProgramAlive = { ...stale, lastMiniProgramSeenAt: new Date('2026-09-25T09:01:30Z') };
  assert.equal(sessionFullyOfflineForRelogin(stale, now, true), true);
  assert.equal(sessionFullyOfflineForRelogin(desktopAlive, now, true), false);
  assert.equal(sessionFullyOfflineForRelogin(miniProgramAlive, now, true), false);
  assert.equal(allSessionsFullyOfflineForRelogin([stale, stale], now, true), true);
  assert.equal(allSessionsFullyOfflineForRelogin([stale, desktopAlive], now, true), false);
  assert.equal(sessionFullyOfflineForRelogin(miniProgramAlive, now, false), true);
  assert.equal(sessionFullyOfflineForRelogin(desktopAlive, now, false), false);
});
test('XCPC ignores flexible windows and locks remaining minutes before end', () => {
  const time = normalizeExamSettings({ ...base, contestRule: 'ACM', flexible: true, freezeMinutes: 30 });
  assert.equal(time.endAt.toISOString(), '2026-09-25T10:00:00.000Z');
  assert.equal(time.scoreboardFrozenAt?.toISOString(), '2026-09-25T09:30:00.000Z');
  assert.throws(() => normalizeExamSettings({ ...base, contestRule: 'ACM', freezeMinutes: 120 }), /必须小于/);
  assert.equal(normalizeExamSettings({ ...base, contestRule: 'ACM', freezeMinutes: 0 }).scoreboardFrozenAt, null);
});
test('event formats enforce their account models and preserve LANQIAO', () => {
  const gplt = normalizeExamSettings({ ...base, contestRule: 'GPLT', contestType: 'INDIVIDUAL', teamAccountMode: 'TEAM_ACCOUNT', allowTeamSubmissionView: true, leaderOnlySubmission: true });
  assert.deepEqual([gplt.contestType, gplt.teamAccountMode, gplt.allowTeamSubmissionView, gplt.leaderOnlySubmission], ['TEAM', 'MEMBER_ACCOUNTS', true, false]);
  const lanqiao = normalizeExamSettings({ ...base, contestRule: 'LANQIAO', contestType: 'TEAM', teamAccountMode: 'TEAM_ACCOUNT', allowTeamSubmissionView: true });
  assert.deepEqual([lanqiao.contestRule, lanqiao.contestType, lanqiao.teamAccountMode, lanqiao.allowTeamSubmissionView], ['LANQIAO', 'TEAM', 'TEAM_ACCOUNT', true]);
  const xcpc = normalizeExamSettings({ ...base, contestRule: 'XCPC', contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS' });
  assert.deepEqual([xcpc.contestType, xcpc.teamAccountMode, xcpc.allowTeamSubmissionView, xcpc.leaderOnlySubmission], ['TEAM', 'MEMBER_ACCOUNTS', false, true]);
  assert.equal(canCandidateSubmit({ contestRule: 'XCPC', contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS', leaderOnlySubmission: false }, { isTeamLeader: false }), false);
  assert.equal(canCandidateSubmit({ contestRule: 'XCPC', contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS', leaderOnlySubmission: false }, { isTeamLeader: true }), true);
  assert.equal(canViewTeamSubmissions({ contestRule: 'GPLT', contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS', allowTeamSubmissionView: true }), true);
  assert.equal(canViewTeamSubmissions({ contestRule: 'XCPC', contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS', allowTeamSubmissionView: true }), true);
});
test('GPLT publishes grouped personal and team boards without sharing submission ownership', () => {
  const settings = normalizeExamSettings({ ...base, contestRule: 'GPLT', contestType: 'TEAM' });
  const exam = { ...base, ...settings, contestRule: 'GPLT' as const, contestType: 'TEAM' as const };
  const candidates = [
    { id: 'a', examNumber: 'A1', name: '甲', teamName: '一队', groupName: '星芒初绽', ranked: true },
    { id: 'b', examNumber: 'A2', name: '乙', teamName: '一队', groupName: '星芒初绽', ranked: true },
    { id: 'c', examNumber: 'B1', name: '丙', teamName: '二队', groupName: '长风破浪', ranked: true },
  ];
  const problem = { id: 'p', score: 80, hydroScore: 100 };
  const records = [
    { id: 'ra', candidateId: 'a', problemId: 'p', status: 2, score: 33, createdAt: new Date('2026-09-25T08:20:00Z') },
    { id: 'rb', candidateId: 'b', problemId: 'p', status: 2, score: 50, createdAt: new Date('2026-09-25T08:30:00Z') },
    { id: 'rc', candidateId: 'c', problemId: 'p', status: 1, score: 100, createdAt: new Date('2026-09-25T08:40:00Z') },
  ];
  const result = calculateLeaderboards(exam, [problem], candidates, records, exam.endAt, true);
  assert.deepEqual(new Set(result.groups), new Set(['星芒初绽', '长风破浪', '凌霄问鼎']));
  assert.equal(result.boards[0].rows.find(row => row.username === 'A1')?.score, 27);
  assert.equal(result.boards[0].rows.find(row => row.username === 'A2')?.score, 40);
  assert.equal(result.boards[1].rows.find(row => row.username === '一队')?.score, 67);
  assert.equal(result.boards[0].rows.find(row => row.username === 'B1')?.rank, 1);
});
test('LANQIAO keeps separate groups, rounded best scores and private submission results', () => {
  const settings = normalizeExamSettings({ ...base, contestRule: 'LANQIAO' });
  assert.equal(settings.contestRule, 'LANQIAO');
  const exam = { ...base, ...settings, contestRule: 'LANQIAO' as const };
  const result = calculateLeaderboards(exam, [{ id: 'p', score: 80, hydroScore: 100 }],
    [{ id: 'a', examNumber: '1', name: '甲', teamName: null, groupName: 'C/C++程序设计' }],
    [{ id: 'r', candidateId: 'a', problemId: 'p', status: 2, score: 33, createdAt: new Date('2026-09-25T08:20:00Z') }], exam.endAt, true);
  assert.equal(result.rows[0].score, 26);
  assert.deepEqual(result.groups, ['C/C++程序设计', 'Python程序设计', 'Java软件开发']);
  assert.equal(submissionVisibility({ ...exam, showTestCaseCount: true, showObjectiveScore: true }, 'default', new Date('2026-09-25T09:00:00Z')).result, false);
});
test('language families intersect live Hydro languages with exam and problem restrictions', () => {
  const available = ['c', 'cc.cc17o2', 'cc.cc20o2', 'py.py3', 'py.pypy3', 'java', 'rust'].map(id => ({ id, name: id }));
  assert.equal(languageFamily('cc.cc17o2'), 'cpp');
  assert.equal(languageFamily('c.c11'), 'c');
  assert.deepEqual(allowedProblemLanguages({ problemType: 'default', languages: ['cc.cc20o2', 'rust'] }, ['cpp'], available), ['cc.cc20o2']);
  assert.deepEqual(allowedProblemLanguages({ problemType: 'default', languages: ['rust'] }, ['cpp'], available), []);
  assert.deepEqual(allowedProblemLanguages({ problemType: 'default', languages: [] }, ['c', 'python'], available), ['c', 'py.py3', 'py.pypy3']);
  assert.deepEqual(allowedProblemLanguages({ problemType: 'default', languages: [] }, [], available), available.map(language => language.id));
  assert.deepEqual(allowedProblemLanguages({ problemType: 'objective', languages: [] }, ['cpp'], available), ['_']);
});
test('KS exposes verdicts and test counts only for programming problems and never scores', () => {
  const exam = { contestRule: 'KS' as const, endAt: new Date('2026-09-25T10:00:00Z'), showTestCaseCount: false, showObjectiveScore: true };
  assert.deepEqual(submissionVisibility(exam, 'default', new Date('2026-09-25T09:00:00Z')), { result: true, score: false, counts: true, details: true });
  assert.deepEqual(submissionVisibility(exam, 'objective', new Date('2026-09-25T09:00:00Z')), { result: false, score: false, counts: false, details: false });
  assert.deepEqual(submissionVisibility(exam, 'objective', exam.endAt), { result: false, score: false, counts: false, details: false });
  const problem = { id: 'p', order: 0, hydroProblemId: '1', title: 'Programming', problemType: 'default', languages: [], files: [], config: {} };
  const serialized = serializeLocalContest({ exam: { ...base, ...exam, id: 'e', problems: [problem], allowedLanguages: [] }, candidate: { id: 'u', examNumber: '1' }, session: { startedAt: new Date() }, submissions: [{ id: 's', problemId: 'p', status: 2, score: 60, passedTestCases: 1, totalTestCases: 2, testCases: [{ status: 1, score: 50, time: 8, memory: 1024, message: 'hidden' }, { status: 2, score: 10 }], subtasks: { a: { score: 60 } }, createdAt: new Date() }], languages: [] } as any);
  assert.equal(serialized.submissions[0].score, null);
  assert.deepEqual(serialized.submissions[0].testCases, [{ status: 1 }, { status: 2 }]);
  assert.deepEqual(serialized.submissions[0].subtasks, {});
});
test('KS objective submissions are judged immediately while their candidate result remains hidden', () => {
  assert.equal(judgeObjectiveImmediately('KS', false, false), true);
  assert.equal(judgeObjectiveImmediately('OI', false, false), false);
  assert.equal(judgeObjectiveImmediately('IOI', true, false), true);
  assert.equal(judgeObjectiveImmediately('IOI', false, true), true);
  const exam = { contestRule: 'KS' as const, endAt: new Date('2026-09-25T10:00:00Z'), showTestCaseCount: true, showObjectiveScore: false };
  assert.equal(submissionVisibility(exam, 'objective', new Date('2026-09-25T09:00:00Z')).result, false);
});
test('KS uses the latest non-cancelled submission for every problem', () => {
  const exam = { ...base, ...normalizeExamSettings({ ...base, contestRule: 'KS' }), contestRule: 'KS' as const };
  const problems = [{ id: 'a', score: 100 }, { id: 'b', score: 100 }];
  const records = [
    { id: 'a-high', candidateId: 'u', problemId: 'a', status: 1, score: 100, createdAt: new Date('2026-09-25T08:10:00Z') },
    { id: 'a-last', candidateId: 'u', problemId: 'a', status: 2, score: 25, createdAt: new Date('2026-09-25T08:20:00Z') },
    { id: 'b-old', candidateId: 'u', problemId: 'b', status: 1, score: 80, createdAt: new Date('2026-09-25T08:15:00Z') },
    { id: 'b-last', candidateId: 'u', problemId: 'b', status: 22, score: 0, createdAt: new Date('2026-09-25T08:25:00Z') },
    { id: 'b-cancelled', candidateId: 'u', problemId: 'b', status: 30, score: 100, createdAt: new Date('2026-09-25T08:30:00Z') },
  ];
  const row = scoreRows(exam, problems, [{ id: 'u', examNumber: '1', name: '甲', teamName: null }], records, exam.endAt, true).rows[0];
  assert.deepEqual(row.problemScores, [25, 0]);
  assert.equal(row.score, 25);
  assert.equal(row.cells[1].pending, 1);
});
test('KS manual scores override the selected system result and can fall back to it', () => {
  const exam = { ...base, ...normalizeExamSettings({ ...base, contestRule: 'KS' }), contestRule: 'KS' as const };
  const problems = [{ id: 'a', score: 80, hydroScore: 100 }];
  const users = [{ id: 'u', examNumber: '1', name: '甲', teamName: null }];
  const system = scoreRows(exam, problems, users, [{ id: 'r', candidateId: 'u', problemId: 'a', status: 2, score: 50, createdAt: new Date('2026-09-25T08:20:00Z') }], exam.endAt, true).rows[0];
  const manual = scoreRows(exam, problems, users, [{ id: 'r', candidateId: 'u', problemId: 'a', status: 2, score: 50, manualScore: 72, createdAt: new Date('2026-09-25T08:20:00Z') }], exam.endAt, true).rows[0];
  assert.equal(system.score, 40);
  assert.equal(manual.score, 72);
  assert.equal(manual.problemScores[0], 72);
});
test('unchecked visibility settings conceal objective grades and per-case details', () => {
  const exam = { contestRule: 'IOI' as const, endAt: new Date('2100-01-01'), showTestCaseCount: false, showObjectiveScore: false };
  assert.equal(submissionVisibility(exam, 'objective').result, false);
  assert.equal(submissionVisibility({ ...exam, contestRule: 'OI', showObjectiveScore: true }, 'objective').score, false);
  assert.equal(submissionVisibility(exam, 'default').details, false);
  const problem = { id: 'p', order: 0, hydroProblemId: '1', title: 'Objective', problemType: 'objective', languages: [], files: [], config: { answers: { '1': 'secret-answer' } } };
  const serialized = serializeLocalContest({ exam: { ...base, ...exam, id: 'e', problems: [problem], allowedLanguages: [] }, candidate: { id: 'u', examNumber: '1' }, session: { startedAt: new Date() }, submissions: [{ id: 's', problemId: 'p', status: 1, score: 100, passedTestCases: 2, totalTestCases: 2, testCases: [{ status: 1, score: 100 }], subtasks: { a: { score: 100 } }, createdAt: new Date() }], languages: [] } as any);
  assert.deepEqual(serialized.problems[0].config, { type: 'objective' });
  assert.equal(serialized.submissions[0].score, null);
  assert.equal(serialized.submissions[0].passedTestCases, null);
  assert.deepEqual(serialized.submissions[0].testCases, []);
  assert.deepEqual(serialized.submissions[0].subtasks, {});
});
test('visibility settings expose objective grades and test counts outside OI', () => {
  const exam = { contestRule: 'IOI' as const, endAt: new Date('2100-01-01'), showTestCaseCount: true, showObjectiveScore: true };
  assert.deepEqual(submissionVisibility(exam, 'objective'), { result: true, score: true, counts: true, details: true });
  assert.equal(submissionVisibility({ ...exam, contestRule: 'OI' }, 'default').counts, true);
  assert.equal(submissionVisibility({ ...exam, contestRule: 'OI' }, 'default').score, false);
  assert.equal(submissionVisibility({ ...exam, contestRule: 'XCPC' }, 'default', exam.endAt).score, false);
  assert.equal(normalizeExamSettings({ ...base, contestRule: 'OI', showObjectiveScore: true }).showObjectiveScore, false);
});
test('freeze starts at the configured instant and KS never publishes a leaderboard', () => {
  const exam = { ...base, ...normalizeExamSettings({ ...base, contestRule: 'ACM', freezeMinutes: 30 }), contestRule: 'ACM' as const };
  const users = [{ id: 'u', examNumber: '1', name: null, teamName: null }];
  const problems = [{ id: 'p', score: 100 }];
  const records = [{ id: 'r', candidateId: 'u', problemId: 'p', status: 1, score: 100, createdAt: new Date('2026-09-25T09:40:00Z') }];
  assert.equal(scoreRows(exam, problems, users, records, new Date('2026-09-25T09:00:00Z')).frozen, false);
  const frozen = scoreRows(exam, problems, users, records, new Date('2026-09-25T09:45:00Z'));
  assert.equal(frozen.frozen, true); assert.equal(frozen.rows[0].solved, 0);
  assert.equal(scoreRows(exam, problems, users, records, exam.endAt).rows[0].solved, 1);
  assert.equal(scoreRows({ ...exam, contestRule: 'KS' }, problems, users, records, exam.endAt).available, false);
  const ks = scoreRows({ ...exam, contestRule: 'KS' }, problems, users, [...records, { ...records[0], id: 'r2', status: 2, score: 30, createdAt: new Date('2026-09-25T09:50:00Z') }], exam.endAt, true);
  assert.equal(ks.rows[0].score, 30);
});
test('legacy ACM settings are saved as XCPC', () => {
  const normalized = normalizeExamSettings({ ...base, contestRule: 'ACM' });
  assert.equal(normalized.contestRule, 'XCPC');
});
test('XCPC truncates each accepted time to minutes before adding twenty-minute penalties', () => {
  const exam = { ...base, ...normalizeExamSettings({ ...base, contestRule: 'XCPC' }), contestRule: 'XCPC' as const };
  const users = [{ id: 'u', examNumber: '1', name: '甲', teamName: null }];
  const problems = [{ id: 'a', score: 100 }, { id: 'b', score: 100 }];
  const records = [
    { id: 'wa', candidateId: 'u', problemId: 'a', status: 2, score: 0, createdAt: new Date('2026-09-25T08:00:30Z') },
    { id: 'ce', candidateId: 'u', problemId: 'a', status: 7, score: 0, createdAt: new Date('2026-09-25T08:00:45Z') },
    { id: 'aca', candidateId: 'u', problemId: 'a', status: 1, score: 100, createdAt: new Date('2026-09-25T08:01:59Z') },
    { id: 'acb', candidateId: 'u', problemId: 'b', status: 1, score: 100, createdAt: new Date('2026-09-25T08:02:59Z') },
  ];
  const row = scoreRows(exam, problems, users, records, exam.endAt, true).rows[0];
  assert.equal(row.solved, 2);
  assert.equal(row.cells[0].wrong, 1);
  assert.equal(row.cells[0].penalty / 60, 21);
  assert.equal(row.cells[1].penalty / 60, 2);
  assert.equal(row.penalty / 60, 23);
});
test('XCPC excludes CE and includes other judged failures in the reference penalty', () => {
  const exam = { ...base, ...normalizeExamSettings({ ...base, contestRule: 'XCPC' }), contestRule: 'XCPC' as const };
  const users = [
    { id: 'late', examNumber: '1', name: '甲', teamName: null },
    { id: 'early', examNumber: '2', name: '乙', teamName: null },
  ];
  const problems = [{ id: 'a', score: 100 }, { id: 'b', score: 100 }];
  const records = [
    { id: 'late-ce', candidateId: 'late', problemId: 'a', status: 7, score: 0, createdAt: new Date('2026-09-25T08:01:00Z') },
    { id: 'late-system', candidateId: 'late', problemId: 'a', status: 8, score: 0, createdAt: new Date('2026-09-25T08:02:00Z') },
    { id: 'late-a', candidateId: 'late', problemId: 'a', status: 1, score: 100, createdAt: new Date('2026-09-25T08:10:00Z') },
    { id: 'late-b', candidateId: 'late', problemId: 'b', status: 1, score: 100, createdAt: new Date('2026-09-25T08:30:00Z') },
    { id: 'early-a', candidateId: 'early', problemId: 'a', status: 1, score: 100, createdAt: new Date('2026-09-25T08:20:00Z') },
    { id: 'early-b', candidateId: 'early', problemId: 'b', status: 1, score: 100, createdAt: new Date('2026-09-25T08:20:00Z') },
  ];
  const rows = scoreRows(exam, problems, users, records, exam.endAt, true).rows;
  const late = rows.find(row => row.username === '1')!;
  const early = rows.find(row => row.username === '2')!;
  assert.equal(late.cells[0].wrong, 1);
  assert.equal(late.penalty / 60, 60);
  assert.equal(early.penalty / 60, 40);
  assert.equal(early.rank, 1);
  assert.equal(late.rank, 2);
});
test('ignored submissions do not affect scores, solved counts, or XCPC penalties', () => {
  const exam = { ...base, ...normalizeExamSettings({ ...base, contestRule: 'XCPC' }), contestRule: 'XCPC' as const };
  const users = [{ id: 'u', examNumber: '1', name: '甲', teamName: null }];
  const problems = [{ id: 'a', score: 100 }];
  const records = [
    { id: 'ignored-wa', candidateId: 'u', problemId: 'a', status: 30, score: 0, createdAt: new Date('2026-09-25T08:01:00Z') },
    { id: 'accepted', candidateId: 'u', problemId: 'a', status: 1, score: 100, createdAt: new Date('2026-09-25T08:02:00Z') },
    { id: 'ignored-ac', candidateId: 'u', problemId: 'a', status: 30, score: 100, createdAt: new Date('2026-09-25T08:03:00Z') },
  ];
  const row = scoreRows(exam, problems, users, records, exam.endAt, true).rows[0];
  assert.equal(row.solved, 1);
  assert.equal(row.cells[0].wrong, 0);
  assert.equal(row.penalty / 60, 2);
});
test('exam problem percentages scale submission and leaderboard scores', () => {
  const exam = { ...base, ...normalizeExamSettings(base), contestRule: 'IOI' as const, showTestCaseCount: true, showObjectiveScore: true };
  const problem = { id: 'p', order: 0, hydroProblemId: '1', title: 'A', problemType: 'default', score: 80, hydroScore: 100, scorePercent: 80, languages: [], files: [], config: {} };
  const submission = { id: 's', problemId: 'p', candidateId: 'u', status: 1, score: 75, passedTestCases: 3, totalTestCases: 4, testCases: [], subtasks: {}, createdAt: new Date('2026-09-25T08:30:00Z') };
  const serialized = serializeLocalContest({ exam: { ...exam, id: 'e', problems: [problem], allowedLanguages: [] }, candidate: { id: 'u', examNumber: '1' }, session: { startedAt: new Date() }, submissions: [submission], languages: [] } as any);
  assert.equal(serialized.submissions[0].score, 60);
  const leaderboard = scoreRows(exam, [problem], [{ id: 'u', examNumber: '1', name: '张三', teamName: null }], [submission], exam.endAt, true);
  assert.equal(leaderboard.rows[0].score, 60);
});
test('non-100 Hydro points use the same exact percentage in history and leaderboards', () => {
  const exam = { ...base, ...normalizeExamSettings(base), contestRule: 'IOI' as const, showTestCaseCount: true, showObjectiveScore: true };
  for (const [hydroScore, scorePercent, rawScore, expected] of [[24, 10, 23, 9.58], [200, 40, 150, 30], [60, 33, 59, 32.45], [50, 0, 50, 0]]) {
    const problem = { id: 'p', order: 0, hydroProblemId: '1', title: 'A', problemType: 'default',
      score: scorePercent, hydroScore, scorePercent, languages: [], files: [], config: {} };
    const submission = { id: 's', problemId: 'p', candidateId: 'u', status: 2, score: rawScore,
      testCases: [], subtasks: {}, createdAt: new Date('2026-09-25T08:30:00Z') };
    const serialized = serializeLocalContest({ exam: { ...exam, id: 'e', problems: [problem], allowedLanguages: [] },
      candidate: { id: 'u', examNumber: '1' }, session: { startedAt: new Date() }, submissions: [submission], languages: [] } as any);
    const leaderboard = scoreRows(exam, [problem], [{ id: 'u', examNumber: '1', name: '张三', teamName: null }], [submission], exam.endAt, true);
    assert.equal(serialized.submissions[0].score, expected);
    assert.equal(leaderboard.rows[0].score, expected);
  }
});
test('Hydro problem time and memory strings are converted for the client table', () => {
  assert.deepEqual(problemLimits({ time: '1s', memory: '256m' }), { timeLimitMs: 1000, memoryLimitMb: 256 });
  assert.deepEqual(problemLimits({ timeMax: 2500, memoryMax: '1g' }), { timeLimitMs: 2500, memoryLimitMb: 1024 });
});

test('incident recording is independently opt-in and defaults off', () => {
  assert.equal(base.saveIncidentRecording, false);
  assert.equal(CreateExamSchema.parse({ ...base, saveFullRecording: false, saveIncidentRecording: true }).saveIncidentRecording, true);
  assert.equal(CreateExamSchema.parse({ ...base, saveFullRecording: true, saveIncidentRecording: false }).saveIncidentRecording, false);
  assert.equal(CreateExamSchema.safeParse({ ...base, saveIncidentRecording: 'true' }).success, false);
});
