import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { normalizeExamSettings } from '../src/lib/exam-settings';
import { canCandidateSubmit, canViewTeamSubmissions, normalizeContestFormat } from '../src/lib/contest-format';
import { TeamSubmissionViewSetting } from '../src/components/TeamSubmissionViewSetting';
import { saveExam } from '../src/lib/exam-save';
import { prisma } from '../src/lib/db';

const base = CreateExamSchema.parse({ name: '共享配置测试', startAt: '2026-10-11T08:00:00Z', latestStartAt: '2026-10-11T08:00:00Z',
  endAt: '2026-10-11T10:00:00Z', durationMinutes: 120, platform: 'HYDRO', contestType: 'TEAM', contestRule: 'IOI' });

test('sharing remains opt-in and both choices survive every team format/account normalization', () => {
  assert.equal(base.allowTeamSubmissionView, false);
  for (const contestRule of ['GPLT', 'XCPC', 'ACM', 'IOI', 'OI', 'LANQIAO', 'KS'] as const) {
    for (const teamAccountMode of ['MEMBER_ACCOUNTS', 'TEAM_ACCOUNT'] as const) {
      for (const enabled of [true, false]) {
        const normalized = normalizeExamSettings({ ...base, contestRule, teamAccountMode, allowTeamSubmissionView: enabled });
        assert.equal(normalized.allowTeamSubmissionView, enabled, `${contestRule}/${teamAccountMode}/${enabled}`);
        assert.equal(canViewTeamSubmissions(normalized), enabled && normalized.teamAccountMode === 'MEMBER_ACCOUNTS');
        assert.equal(normalizeContestFormat(normalized).allowTeamSubmissionView, enabled, 'repeated saves cannot silently reset the choice');
      }
    }
  }
});

test('individual contests cannot grant cross-account access and shared team accounts remain one identity', () => {
  const individual = normalizeExamSettings({ ...base, contestType: 'INDIVIDUAL', allowTeamSubmissionView: true });
  assert.equal(individual.allowTeamSubmissionView, false);
  assert.equal(canViewTeamSubmissions(individual), false);
  assert.equal(canViewTeamSubmissions({ ...base, teamAccountMode: 'TEAM_ACCOUNT', allowTeamSubmissionView: true }), false);
  assert.equal(canViewTeamSubmissions({ ...base, teamAccountMode: 'MEMBER_ACCOUNTS', allowTeamSubmissionView: true }), true);
});

test('enabling same-team viewing does not grant submission rights or alter existing format rules', () => {
  for (const enabled of [false, true]) {
    const xcpc = normalizeExamSettings({ ...base, contestRule: 'XCPC', allowTeamSubmissionView: enabled });
    assert.equal(xcpc.leaderOnlySubmission, true);
    assert.equal(canCandidateSubmit(xcpc, { isTeamLeader: false }), false);
    assert.equal(canCandidateSubmit(xcpc, { isTeamLeader: true }), true);
    const gplt = normalizeExamSettings({ ...base, contestRule: 'GPLT', teamAccountMode: 'TEAM_ACCOUNT', leaderOnlySubmission: true, allowTeamSubmissionView: enabled });
    assert.equal(gplt.teamAccountMode, 'MEMBER_ACCOUNTS');
    assert.equal(gplt.leaderOnlySubmission, false);
  }
});

test('team sharing controls show the saved value only for separate member accounts and explain shared-account ownership', () => {
  const render = (contestType: 'INDIVIDUAL' | 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT', enabled: boolean) => renderToStaticMarkup(createElement(TeamSubmissionViewSetting, {
    contestType, teamAccountMode, enabled, onChange() {}
  }));
  assert.match(render('TEAM', 'MEMBER_ACCOUNTS', true), /checked=""/);
  assert.doesNotMatch(render('TEAM', 'MEMBER_ACCOUNTS', false), /checked=""/);
  assert.match(render('TEAM', 'MEMBER_ACCOUNTS', false), /允许同队成员查看提交/);
  assert.match(render('TEAM', 'MEMBER_ACCOUNTS', false), /封榜规则仍然生效/);
  const shared = render('TEAM', 'TEAM_ACCOUNT', true);
  assert.doesNotMatch(shared, /type="checkbox"/);
  assert.match(shared, /共用该账号的提交记录/);
  assert.doesNotMatch(render('INDIVIDUAL', 'MEMBER_ACCOUNTS', true), /type="checkbox"/);
});

test('the ordinary exam-save transaction persists explicit on/off without resetting sharing on an unrelated edit', async t => {
  const replace = (target: object, key: string, value: unknown) => {
    const object = target as Record<string, unknown>, previous = object[key];
    object[key] = value; t.after(() => { object[key] = previous; });
  };
  const saved: Array<Record<string, unknown>> = [];
  replace(prisma.systemSetting, 'findUnique', async () => ({ value: { baseUrl: 'https://judge.invalid', apiKey: 'test', problemDomainId: 'Problems' } }));
  replace(prisma.examProblem, 'findMany', async () => []);
  replace(prisma, '$transaction', async (operation: (client: unknown) => Promise<unknown>) => operation({ exam: {
    update: async ({ data }: { data: Record<string, unknown> }) => { saved.push(data); return { id: 'exam', ...data }; }
  } }));
  const enabled = CreateExamSchema.parse({ ...base, contestRule: 'XCPC', allowTeamSubmissionView: true });
  await saveExam(enabled, 'admin', 'exam');
  await saveExam({ ...enabled, name: '只修改标题' }, 'admin', 'exam');
  await saveExam({ ...enabled, allowTeamSubmissionView: false }, 'admin', 'exam');
  assert.deepEqual(saved.map(item => item.allowTeamSubmissionView), [true, true, false]);
  assert.ok(saved.every(item => item.leaderOnlySubmission === true));
});
