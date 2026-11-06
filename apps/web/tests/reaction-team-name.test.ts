import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReactionTeamIdentity, resolveReactionTeamName } from '../src/lib/reaction-team-name';

const input = {
  examId: 'exam-15', teamId: 'sample-team',
  candidate: { examId: 'exam-15', examNumber: 'sample-team', teamName: null as string | null, name: '123' },
  teamEvent: { examId: 'exam-15', type: 'teams', remoteId: 'sample-team', payload: { id: 'sample-team', name: '示例大学队伍' } },
};

test('an explicit team name takes priority over the exact CCS team record', () => {
  assert.equal(resolveReactionTeamName({ ...input, candidate: { ...input.candidate, teamName: '  校内队名  ' } }), '校内队名');
});

test('a missing or blank team name uses CCS, never the personal candidate name', () => {
  assert.equal(resolveReactionTeamName(input), '示例大学队伍');
  assert.equal(resolveReactionTeamName({ ...input, candidate: { ...input.candidate, teamName: ' \n ' } }), '示例大学队伍');
  assert.equal(resolveReactionTeamName({ ...input, candidate: null }), '示例大学队伍');
});

test('missing CCS data falls back to the team account without reusing old personal-name snapshots', () => {
  const historical = { ...input, teamName: '123', teamEvent: null };
  assert.equal(resolveReactionTeamName(historical), 'sample-team');
});

test('candidate names from another exam or team cannot replace the exact CCS name', () => {
  for (const mismatch of [{ examId: 'exam-16' }, { examNumber: 'other-team' }]) {
    assert.equal(resolveReactionTeamName({ ...input, candidate: { ...input.candidate, teamName: '错误队伍', ...mismatch } }), '示例大学队伍');
  }
});

test('CCS records must match exam, event type, remote ID and payload ID exactly', () => {
  for (const mismatch of [
    { examId: 'exam-16' }, { type: 'submissions' }, { remoteId: 'other-team' },
    { payload: { id: 'other-team', name: '错误队伍' } }, { payload: { name: '无队伍账号' } },
  ]) {
    assert.equal(resolveReactionTeamName({ ...input, teamEvent: { ...input.teamEvent, ...mismatch } }), 'sample-team');
  }
});

test('deleted, malformed or unnamed CCS teams cannot contribute a display name', () => {
  for (const payload of [null, [], 'not-a-team', { id: 'sample-team', name: '旧队伍', __reactionDeleted: true },
    { id: 'sample-team', name: '  ' }, { id: 'sample-team', name: null }, { id: 'sample-team', name: 123 }]) {
    assert.equal(resolveReactionTeamName({ ...input, teamEvent: { ...input.teamEvent, payload } }), 'sample-team');
  }
});

test('a valid CCS rename is used without changing or trusting the stored Reaction snapshot', () => {
  const historical = { ...input, teamName: '123', teamEvent: { ...input.teamEvent, payload: { id: 'sample-team', name: ' 新队名 ' } } };
  assert.equal(resolveReactionTeamName(historical), '新队名');
  assert.equal(historical.teamName, '123');
});

test('identity reports the validated source used by generated-video metadata', () => {
  assert.deepEqual(resolveReactionTeamIdentity(input), { teamName: '示例大学队伍', source: 'CCS_TEAM_NAME' });
  assert.deepEqual(resolveReactionTeamIdentity({ ...input, candidate: { ...input.candidate, teamName: '指定队名' } }), { teamName: '指定队名', source: 'CANDIDATE_TEAM_NAME' });
  assert.deepEqual(resolveReactionTeamIdentity({ ...input, teamEvent: null }), { teamName: 'sample-team', source: 'TEAM_ID' });
});
