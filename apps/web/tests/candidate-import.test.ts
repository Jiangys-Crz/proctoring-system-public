import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CandidateImportRowSchema } from '@cwnupaa/proctor-shared';
import { parseCandidateCsv, mergeTeamCandidateRows } from '../src/lib/candidate-import';

test('room columns are optional and old registration exports still import', () => {
  for (const column of ['考室', '考室名称', 'roomName']) {
    const rows = parseCandidateCsv(`姓名,学号,学校,比赛账号,比赛密码,座位号,${column}\n张三,001,学校,1001,pw,A01, 第一考室 \n李四,002,学校,1002,pw,A02,`);
    assert.equal(CandidateImportRowSchema.parse(rows[0]).roomName, '第一考室');
    assert.equal(CandidateImportRowSchema.parse(rows[1]).roomName, undefined);
    assert.equal(rows[0].examNumber, '1001');
  }
  const legacy = parseCandidateCsv('姓名,学号,学校,考号,密码,座位号\n张三,001,学校,1001,pw,A01');
  assert.equal(CandidateImportRowSchema.parse(legacy[0]).roomName, undefined);
});

test('team-account consolidation preserves a room on any member and rejects conflicting rooms', () => {
  const csv = '队伍名称,姓名,学号,考号,密码,座位号,考室\n一队,张三,001,T1001,pw,A01,\n一队,李四,002,,,,第一考室';
  const rows = parseCandidateCsv(csv);
  const combined = mergeTeamCandidateRows(rows);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].roomName, '第一考室');
  assert.equal(combined[0].teamMembers, '张三、李四');
  assert.equal(combined[0].teamMemberStudentIds, '001、002');
  assert.throws(() => mergeTeamCandidateRows([{ ...rows[0], roomName: '第二考室' }, rows[1]]), /考室必须一致/);
});
