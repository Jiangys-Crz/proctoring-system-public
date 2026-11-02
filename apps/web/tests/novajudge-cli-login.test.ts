import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginNovaJudge } from '../src/lib/novajudge';

test('monitor login forwards only the validated optional contest grant to the desktop', async t => {
  const exam = { platformBaseUrl: 'https://judge.test', platformContestId: '2', novaJudgeApiKey: 'server-only-key' };
  const candidate = { examNumber: 'team', password: 'server-only-password' };
  let grant: unknown = null;
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    token: 'header.payload.signature', loginSource: 'PROCTORING', proctoringKey: 'a'.repeat(43),
    user: { contestId: 2, username: 'team', role: 'TEAM' }, contestAccessToken: grant,
  }));
  assert.equal('contestAccessToken' in await loginNovaJudge(exam, candidate), false);
  grant = 'private.contest.grant';
  const login = await loginNovaJudge(exam, candidate);
  assert.equal(login.contestAccessToken, grant);
  assert(!JSON.stringify(login).includes(candidate.password));
  assert(!JSON.stringify(login).includes(exam.novaJudgeApiKey));
  for (grant of ['', {}, 'not-a-jwt', 'a'.repeat(8193)]) {
    await assert.rejects(loginNovaJudge(exam, candidate), /比赛授权格式无效/);
  }
});
