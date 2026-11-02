import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from 'xlsx';
import { filterLeaderboardRows, type LeaderboardRow } from '@cwnupaa/proctor-shared/leaderboard';
import { leaderboardExportTable } from '../../../packages/shared/src/leaderboard-export';

const problems = [{ label: 'A', title: '数组之和' }, { label: 'B', title: '最短路径' }];
const row: LeaderboardRow = { rank: 2, username: 'test', displayName: '测试队伍', isStar: true, isGirl: true, institution: '测试学院', score: 70, solved: 1, penalty: 1260, problemScores: [40, null] };
test('visible exports preserve filtering, official ranks, both participation badges and per-problem scores in a valid workbook', () => {
  const rows = filterLeaderboardRows([row, { ...row, username: 'other', displayName: '其他队伍' }], 'IOI', '', 'star', '测试队伍');
  const table = leaderboardExportTable(rows, 'IOI', 'main', problems);
  assert.equal(table.length, 2); assert.equal(table[1][1], '*'); assert.equal(table[1][5], '女生队伍、打星参赛');
  assert.equal(table[1][7], 40); assert.equal(table[1][8], '');
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(table), '排名');
  const read = XLSX.read(XLSX.write(book, { bookType: 'xlsx', type: 'buffer' }));
  assert.deepEqual(XLSX.utils.sheet_to_json(read.Sheets['排名'], { header: 1, defval: '' }), table);
});
test('XCPC exports pending/accepted verdicts without exposing a frozen score; GPLT team boards omit individual problem columns', () => {
  const cells = [
    { score: 1, accepted: true, wrong: 1, pending: 0, seconds: 600, penalty: 1800, firstBlood: false },
    { score: null, accepted: false, wrong: 0, pending: 2, seconds: 0, penalty: 0, firstBlood: false },
  ];
  const table = leaderboardExportTable([{ ...row, cells }], 'XCPC', 'main', problems);
  assert.equal(table[1][7], 21); assert.equal(table[1][8], '+ 2/10'); assert.equal(table[1][9], '? 2');
  assert.equal(leaderboardExportTable([row], 'GPLT', 'team', problems)[0].includes('A · 数组之和'), false);
  assert.equal(leaderboardExportTable([], 'IOI', 'main', problems).length, 1);
});
