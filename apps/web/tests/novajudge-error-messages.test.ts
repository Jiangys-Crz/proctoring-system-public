import assert from 'node:assert/strict';
import test from 'node:test';
import { toErrorMessage } from '../src/lib/http';
import { loginNovaJudge, readNovaJudgeArray } from '../src/lib/novajudge';

const exam = { platformBaseUrl: 'https://judge.example.test', platformContestId: '12', novaJudgeApiKey: 'test-only-key' };
const candidate = { examNumber: 'team007', password: 'test-only-password' };
const publicError = (expected: string) => (error: unknown) => {
  assert.equal(toErrorMessage(error), expected);
  return true;
};

test('missing NovaJudge credentials return actionable messages without a remote request', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(loginNovaJudge({ ...exam, novaJudgeApiKey: '' }, candidate),
    publicError('请填写 NovaJudge 外榜接口密钥，以授权监考专用登录'));
  await assert.rejects(readNovaJudgeArray({ ...exam, novaJudgeApiKey: '' }, 'problems'),
    publicError('请填写 NovaJudge 外榜接口密钥'));
  assert.equal(request.mock.callCount(), 0);
});

test('NovaJudge authorization failures keep safe guidance and never forward the remote body', async t => {
  let status = 403;
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: 'Remote diagnostic', password: 'remote-test-password', apiKey: 'remote-test-key'
  }, { status }));
  await assert.rejects(loginNovaJudge(exam, candidate),
    publicError('NovaJudge 监考登录未获授权，请检查外榜接口密钥是否有效且属于超级管理员'));
  for (status of [401, 403]) {
    await assert.rejects(readNovaJudgeArray(exam, 'problems'),
      publicError('NovaJudge 外榜接口密钥无效或未启用'));
  }
});

test('global sanitization still hides credential-like values and remote diagnostics', t => {
  t.mock.method(console, 'error', () => {});
  for (const message of [
    '外榜请求失败 apiKey=test-only-key',
    '外榜请求失败 API Key=test-only-key',
    '外榜请求失败 x-api-key=test-only-key',
    '登录失败 password=test-only-password',
    '登录失败 secret=test-only-value',
    '登录失败 token=test-only-token',
    '登录失败 https://judge.example.test/private',
    '服务失败 Prisma 内部诊断'
  ]) {
    assert.equal(toErrorMessage(new Error(message)), '服务暂不可用，请稍后再试');
  }
});
