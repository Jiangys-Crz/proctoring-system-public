const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contestDownloadAllowed, contestDownloadFilename } = require('../dist/main/contest-download-policy');
const origin = 'https://legacy-proctor.example.test';
const blob = `${'blob:' + origin}/00000000-0000-4000-8000-000000000000`;
test('the embedded contest can save authenticated attachment and leaderboard blobs only from its current origin', () => {
  assert.equal(contestDownloadAllowed(`${origin}/contest/problems/42`, [blob], origin, true), true);
  assert.equal(contestDownloadAllowed(`${origin}/contest/leaderboard`, [blob], origin, true), true);
  for (const [source, urls, embedded] of [
    [`${origin}/dashboard`, [blob], true], [`${origin}/contestant`, [blob], true],
    [`${origin}/contest`, [blob], false], [`${origin}/contest`, [], true],
    [`${origin}/contest`, ['blob:https://elsewhere.test/id'], true],
    [`${origin}/contest`, ['file:///etc/passwd'], true], [`${origin}/contest`, [`${origin}/api/settings`], true],
    [`${origin}/contest`, [blob, 'https://elsewhere.test/download'], true],
  ]) assert.equal(contestDownloadAllowed(source, urls, origin, embedded), false);
});
test('saved filenames keep Chinese and sanitize filesystem paths and control characters', () => {
  assert.equal(contestDownloadFilename('样例 数据.zip'), '样例 数据.zip');
  assert.equal(contestDownloadFilename('../../file.zip'), 'file.zip');
  assert.equal(contestDownloadFilename('C:\\temp\\a?.zip'), 'a_.zip');
  assert.equal(contestDownloadFilename('..'), '题目附件');
});
