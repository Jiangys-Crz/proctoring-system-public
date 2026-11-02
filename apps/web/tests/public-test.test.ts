import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUBLIC_TEST_PROBLEMS } from '../src/lib/public-test-template';
import { toErrorMessage, fail } from '../src/lib/http';
import { createAlertOnce } from '../src/lib/alert-dedup';
import { mediaApiToken, verifyMediaApiToken } from '../src/lib/media-api-auth';
import { testMediaState } from '../src/lib/test-media-state';

test('test exam starts with one programming placeholder until the configured problem is synchronized', () => {
  assert.equal(PUBLIC_TEST_PROBLEMS.length, 1);
  assert.equal(PUBLIC_TEST_PROBLEMS[0].problemType, 'default');
  assert.equal(PUBLIC_TEST_PROBLEMS[0].content, '');
});
test('technical errors and 500 details never become page messages', async () => {
  const logged = console.error; console.error = () => {};
  try {
    assert.equal(toErrorMessage(new Error('密码不匹配')), '密码不匹配');
    assert.equal(toErrorMessage(new Error('Prisma 数据库出错 /Users/private/path')), '服务暂不可用，请稍后再试');
    assert.equal(toErrorMessage(new Error('fetch failed')), '服务暂不可用，请稍后再试');
    assert.equal((await fail('服务暂不可用', 500, { secret: 'synthetic' }).json()).details, undefined);
  } finally { console.error = logged; }
});
test('test alerts do not even access persistent alert storage', async () => {
  const tx = { alert: { findFirst: () => { throw new Error('must not read'); }, create: () => { throw new Error('must not write'); } } } as any;
  assert.deepEqual(await createAlertOnce(tx, { sessionId: 'test_fixture', examId: 'test', candidateId: 'test', type: 'SCREEN_SWITCH', message: 'test' }), { created: false, alert: null });
});
test('stream success requires an actual ready path with received bytes and private API authorization', async () => {
  const original = globalThis.fetch;
  const oldSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET ||= 'synthetic-test-secret';
  try {
    const token = mediaApiToken(); assert.equal(verifyMediaApiToken(token), true); assert.equal(verifyMediaApiToken('wrong'), false);
    globalThis.fetch = async (input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      const channel = String(input).split('_').pop();
      return Response.json({ ready: true, bytesReceived: channel === 'SCREEN' ? 100 : 0 });
    };
    const result = await testMediaState('test_fixture');
    assert.equal(result.find(item => item.channel === 'DESKTOP_SCREEN')!.ready, true);
    assert.equal(result.find(item => item.channel === 'MOBILE_CAMERA')!.ready, false);
  } finally { globalThis.fetch = original; if (oldSecret) process.env.SESSION_SECRET = oldSecret; else delete process.env.SESSION_SECRET; }
});
