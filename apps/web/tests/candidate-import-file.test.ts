import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from 'xlsx';
import { CandidateImportRowSchema } from '@cwnupaa/proctor-shared';
import { readCandidateImportFile } from '../src/lib/candidate-import-file';
import { mergeTeamCandidateRows } from '../src/lib/candidate-import';

function spreadsheet(rows: unknown[][], bookType: 'xlsx' | 'xls' = 'xlsx', formatIds = false) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (formatIds) { sheet.A2.z = '0000'; sheet.C2.z = '00000000'; }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '考生导入模板');
  return new File([XLSX.write(book, { bookType, type: 'array' })], `考生.${bookType}`);
}

test('Excel imports preserve formatted identifiers, Chinese text and optional rooms', async () => {
  for (const type of ['xlsx', 'xls'] as const) {
    const { rows } = await readCandidateImportFile(spreadsheet([
      ['考号', '姓名', '学号', '密码', '座位号', '学校', '考室'],
      [1, '张三', 2026001, 'pw', 'A01', '西华师范大学', '第一考室'],
      ['', '', '', '', '', '', '']
    ], type, true));
    assert.equal(rows.length, 1);
    const row = CandidateImportRowSchema.parse(rows[0]);
    assert.equal(row.examNumber, '0001');
    assert.equal(row.studentId, '02026001');
    assert.equal(row.name, '张三');
    assert.equal(row.roomName, '第一考室');
  }
});

test('CSV imports preserve UTF-8 headers, leading zeroes and legacy column aliases', async () => {
  const { rows } = await readCandidateImportFile(new File(['\uFEFF姓名,学号,比赛账号,比赛密码,座位号\r\n张三,001,0001,pw,A01'], '报名.csv'));
  assert.equal(rows[0].examNumber, '0001');
  assert.equal(rows[0].studentId, '001');
  assert.equal(rows[0].name, '张三');
});

test('Excel cells containing newlines, commas and quotes stay in a single candidate row', async () => {
  const { rows } = await readCandidateImportFile(spreadsheet([
    ['考号', '姓名', '密码', '座位号', '学校', '指导老师'],
    ['1001', '张三', 'pw', 'A01', '学校,校区', '李老师\n王"老师']
  ]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].school, '学校,校区');
  assert.equal(rows[0].advisor, '李老师\n王"老师');
});

test('header-only, wrong-template and unreadable files fail with actionable errors', async () => {
  await assert.rejects(readCandidateImportFile(spreadsheet([['考号', '密码', '座位号']])), /没有考生数据/);
  await assert.rejects(readCandidateImportFile(spreadsheet([['用户名', '姓名'], ['local001', '张三']])), /表头缺少/);
  await assert.rejects(readCandidateImportFile(new File(['not an Excel file'], 'broken.xlsx')), /表头缺少/);
  await assert.rejects(readCandidateImportFile(new File(['考号,密码,座位号\n1001,"pw,A01'], 'broken.csv')), /未闭合的引号/);
});

test('legacy per-member Excel exports can still be consolidated for team accounts', async () => {
  const { rows } = await readCandidateImportFile(spreadsheet([
    ['队伍名称', '姓名', '学号', '比赛账号', '比赛密码', '座位号', '考室'],
    ['一队', '张三', '001', 'T1001', 'pw', 'A01', ''],
    ['一队', '李四', '002', '', '', '', '第一考室']
  ]));
  const combined = mergeTeamCandidateRows(rows);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].teamMembers, '张三、李四');
  assert.equal(combined[0].roomName, '第一考室');
});
