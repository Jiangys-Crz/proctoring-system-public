import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { normalizeExamSettings } from '../src/lib/exam-settings';
import { loginNovaJudge, novaJudgeContestId, novaJudgeOrigin } from '../src/lib/novajudge';
import { novaBoardProblems, novaBoardSubmission, novaBoardSubmitTime } from '../src/lib/novajudge-board';
import { publicDto, stripCredentialHashes } from '../src/lib/public-dto';
import { novaJudgeClientKey, novaJudgeHeaders, novaJudgeCookie, novaJudgeDownloadAllowed, novaJudgeFileUrl, novaJudgeNavigationAllowed, novaJudgeRequestAllowed } from '../../desktop/src/main/novajudge-policy';

const input = CreateExamSchema.parse({ name: 'Nova 监考', platform: 'NOVAJUDGE', platformBaseUrl: 'judge.example.test', platformContestId: '12', novaJudgeApiKey: 'source-key',
  startAt: '2026-10-12T08:00:00Z', latestStartAt: '2026-10-12T10:00:00Z', endAt: '2026-10-13', durationMinutes: 120, flexible: true, contestType: 'INDIVIDUAL' });
const scope = { origin: 'https://judge.example.test', contestId: '12' };

test('NovaJudge settings use authoritative unified times and need no Hydro problems', () => {
  const normalized = normalizeExamSettings(input);
  assert.equal(normalized.platformBaseUrl, scope.origin);
  assert.equal(normalized.endAt.toISOString(), '2026-10-12T10:00:00.000Z');
  assert.equal(normalized.latestStartAt.toISOString(), '2026-10-12T08:15:00.000Z');
  assert.equal(normalized.flexible, false);
  assert.equal(normalized.contestRule, 'XCPC');
  assert.throws(() => normalizeExamSettings({ ...input, novaJudgeApiKey: '' }), /API Key/);
  assert.throws(() => normalizeExamSettings({ ...input, problemIds: ['1'] }), /由 NovaJudge 管理/);
});

test('NovaJudge origin and ID reject protocols, credentials, paths and numeric overflow', () => {
  assert.equal(novaJudgeOrigin('http://localhost:3001'), 'http://localhost:3001');
  for (const value of ['file:///tmp/oj', 'https://user:pass@judge.example.test', 'https://judge.example.test/path', 'https://judge.example.test?a=1', 'https://judge.example.test#x', 'https://judge.example.test\\other']) assert.throws(() => novaJudgeOrigin(value));
  for (const value of ['0', '-1', '12x', '01', '1.2', '9007199254740992']) assert.throws(() => novaJudgeContestId(value));
});

test('Nova login uses imported credentials and verifies the returned competition identity', async t => {
  let role = 'TEAM', contestId = 12, status = 200;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, `${scope.origin}/api/cli/login`);
    assert.deepEqual(JSON.parse(String(init.body)), { username: '0000123', password: 'password-fixture', contestId: 12, loginSource: 'PROCTORING' });
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('x-api-key'), input.novaJudgeApiKey);
    return Response.json({ token: 'header.payload.signature', loginSource: 'PROCTORING', proctoringKey: 'a'.repeat(43), user: { username: '0000123', contestId, role } }, { status });
  });
  const candidate = { examNumber: '0000123', password: 'password-fixture' };
  const login = await loginNovaJudge(input, candidate);
  assert.equal(login.loginUrl, `${scope.origin}/contest/12`);
  assert.equal(login.cookie.name, 'user_token');
  assert.equal(JSON.stringify(login).includes(candidate.password), false);
  role = 'ADMIN'; await assert.rejects(loginNovaJudge(input, candidate), /选手登录凭据/);
  role = 'TEAM'; contestId = 13; await assert.rejects(loginNovaJudge(input, candidate), /选手登录凭据/);
  status = 401; await assert.rejects(loginNovaJudge(input, candidate), /考号或密码错误/);
});

test('Nova guest blocks other contests, origins, frames, sockets and redirected downloads', () => {
  assert.equal(novaJudgeNavigationAllowed(`${scope.origin}/contest/12/status/3`, scope), true);
  for (const value of [`${scope.origin}/contest/123`, `${scope.origin}/contest/13`, `${scope.origin}/`, `${scope.origin}/admin`, 'https://other.test/contest/12']) assert.equal(novaJudgeNavigationAllowed(value, scope), false);
  for (const type of ['image', 'script', 'stylesheet', 'xhr', 'other', 'webSocket', 'mainFrame', 'subFrame']) assert.equal(novaJudgeRequestAllowed('https://other.test/file.zip', type, scope), false);
  assert.equal(novaJudgeRequestAllowed(`${scope.origin}/_next/static/app.js`, 'script', scope), true);
  assert.equal(novaJudgeRequestAllowed(`${scope.origin}/api/submit`, 'xhr', scope), true);
  assert.equal(novaJudgeRequestAllowed(`blob:${scope.origin}/123`, 'mainFrame', scope), false);
  assert.equal(novaJudgeRequestAllowed(`wss://judge.example.test/ws`, 'webSocket', scope), true);
  assert.equal(novaJudgeRequestAllowed(`ws://judge.example.test/ws`, 'webSocket', scope), false);
  assert.equal(novaJudgeDownloadAllowed(`${scope.origin}/contest/12/problems/A`, [`${scope.origin}/api/problems/1/assets/test.zip`], scope, true), true);
  assert.equal(novaJudgeDownloadAllowed(`${scope.origin}/contest/12`, [`${scope.origin}/file.zip`, 'https://other.test/file.zip'], scope, true), false);
  assert.equal(novaJudgeDownloadAllowed(`${scope.origin}/contest/12`, [`blob:${scope.origin}/1`], scope, false), false);
  assert.equal(novaJudgeFileUrl(`${scope.origin}/api/problems/1/assets/sample.in`, scope), true);
  assert.equal(novaJudgeFileUrl(`${scope.origin}/api/contests/13/editorial`, scope), false);
});

test('Nova cookie is HttpOnly, scoped to the exact origin and never a URL token', () => {
  const cookie = novaJudgeCookie({ loginUrl: `${scope.origin}/contest/12`, cookie: { name: 'user_token', value: 'head.body.sign' } }, scope);
  assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.path, '/');
  assert.throws(() => novaJudgeCookie({ loginUrl: 'https://other.test/contest/12', cookie: { name: 'user_token', value: 'head.body.sign' } }, scope));
  assert.throws(() => novaJudgeCookie({ loginUrl: `${scope.origin}/contest/12`, cookie: { name: 'auth_token', value: 'head.body.sign' } }, scope));
  assert.deepEqual(publicDto({ exam: { novaJudgeApiKey: 'source', externalBoardApiKey: 'target', name: 'Nova' } }), { exam: { name: 'Nova' } });
  assert.equal('novaJudgeApiKey' in stripCredentialHashes({ novaJudgeApiKey: 'secret' }), false);
});

test('Nova external-board conversion keeps leading zeros, verdicts, timestamps and ms/KB units', () => {
  const problems = novaBoardProblems([{ displayId: 'A', name: 'A+B', time: 1000, memory: 256, score: 100 }]);
  assert.equal(problems[0].time_limit, 1000);
  const row = { rid: 123, problem: 'A+B', username: '0000123', status: 'Accepted', score: 100, runtime: 15, memory: 1024, submit_time: '2026-10-12 16:02:03:123', code: 'int main(){}', language: 'cpp' };
  const payload = novaBoardSubmission(row, problems, { id: 'exam-1' });
  assert.equal(payload.problem, 'A'); assert.equal(payload.username, '0000123');
  assert.equal(payload.rid, 'novajudge:exam-1:123'); assert.equal(payload.runtime, '15'); assert.equal(payload.memory, '1024');
  assert.equal(payload.submit_time, '2026-10-12 16:02:03');
  assert.equal(novaBoardSubmission({ ...row, submit_time: '2026-10-12T08:02:03Z' }, problems, { id: 'exam-1' }).submit_time, payload.submit_time);
  assert.throws(() => novaBoardSubmission(row, [...problems, { ...problems[0], display_id: 'B' }], { id: 'exam-1' }), /唯一匹配/);
});

test('Nova server-local export times convert China, UTC and Vancouver DST to the same receiver time', () => {
  assert.equal(novaBoardSubmitTime('2026-10-12 16:00:00:123', 'Asia/Shanghai'), '2026-10-12 16:00:00');
  assert.equal(novaBoardSubmitTime('2026-10-12 08:00:00', 'UTC'), '2026-10-12 16:00:00');
  assert.equal(novaBoardSubmitTime('2026-10-12 01:00:00', 'America/Vancouver'), '2026-10-12 16:00:00');
  assert.equal(novaBoardSubmitTime('2026-12-12 00:00:00', 'America/Vancouver'), '2026-12-12 16:00:00');
  assert.throws(() => novaBoardSubmitTime('2026-03-08 02:30:00', 'America/Vancouver'), /时间无效/);
  assert.throws(() => novaBoardSubmitTime('2026-02-30 12:00:00'), /时间无效/);
  assert.equal(CreateExamSchema.safeParse({ ...input, novaJudgeTimezone: 'Invalid/Timezone' }).success, false);
});


test('Nova native client proof rejects missing bindings and never crosses the configured origin', () => {
  const key = 'a'.repeat(43);
  assert.equal(novaJudgeClientKey({ loginSource: 'PROCTORING', proctoringKey: key }), key);
  for (const login of [{}, { loginSource: 'PROCTORING', proctoringKey: 'fixed-marker' }, { proctoringKey: key }]) assert.throws(() => novaJudgeClientKey(login));
  assert.deepEqual(novaJudgeHeaders(`${scope.origin}/contest/12`, { 'X-NovaJudge-Proctor-Key': 'forged', Accept: '*/*' }, scope, key), { Accept: '*/*', 'x-novajudge-proctor-key': key });
  assert.deepEqual(novaJudgeHeaders('https://other.test/asset', { 'x-novajudge-proctor-key': key }, scope, key), {});
  assert.deepEqual(novaJudgeHeaders(`${scope.origin}/contest/12`, { 'x-novajudge-proctor-key': key }, null, ''), {});
});
