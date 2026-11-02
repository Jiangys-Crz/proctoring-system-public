import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/lib/db';
import { hashClientSessionToken } from '../src/lib/client-auth';
import { POST } from '../src/app/api/client/contest/file/route';

test('authenticated statement attachments stream through the client API while unstarted, foreign-file and invalid-token requests are denied', async t => {
  const now = new Date();
  const problem = { id: 'row', hydroProblemId: '42', files: [{ name: '样例.zip' }], content: '[远程文件](https://judge.example.test/file/remote.zip)' };
  const session = { id: 's', status: 'IN_EXAM', revokedAt: null, startedAt: now, desktopTokenHash: hashClientSessionToken('test-token'),
    candidate: { startedAt: now }, exam: { id: 'exam', startAt: new Date(+now - 1000), platformContestId: 'local', published: true, platformBaseUrl: 'https://judge.example.test', problems: [problem] } };
  const replace = (target: object, key: string, implementation: unknown) => {
    const value = target as Record<string, unknown>, old = value[key]; value[key] = implementation; t.after(() => { value[key] = old; });
  };
  replace(prisma.clientSession, 'findUnique', async () => session);
  replace(prisma.examProblem, 'findFirst', async () => null);
  replace(prisma.systemSetting, 'findUnique', async () => ({ value: { baseUrl: 'https://judge.example.test', apiKey: 'fixture-api-key', problemDomainId: 'Problems' } }));
  let network = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init: RequestInit) => {
    network++;
    if (String(url).endsWith('/api/proctor/problem/42/file')) {
      assert.equal(new Headers(init.headers).get('x-proctor-api-key'), 'fixture-api-key');
      assert.deepEqual(JSON.parse(String(init.body)), { name: '样例.zip' });
      return Response.json({ ok: true, data: { url: '/file/fixture.zip' } });
    }
    assert.equal(new Headers(init.headers).has('authorization'), false);
    return new Response('file-bytes', { headers: { 'content-type': 'application/zip' } });
  });
  const request = (input: object, token = 'test-token') => new Request('https://client.example.test/api/client/contest/file', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': token },
    body: JSON.stringify({ sessionId: 's', type: 'public', name: '样例.zip', problemId: '42', ...input }),
  });
  assert.equal((await POST(request({}, 'wrong-token'))).status, 401);
  session.startedAt = null as any; session.candidate.startedAt = null as any;
  assert.equal((await POST(request({}))).status, 403);
  session.startedAt = now; session.candidate.startedAt = now;
  assert.equal((await POST(request({ problemId: 'foreign' }))).status, 404);
  assert.equal((await POST(request({ name: 'unlisted.zip' }))).status, 404);
  assert.equal(network, 0);
  const response = await POST(request({}));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(await response.text(), 'file-bytes'); assert.equal(network, 2);
  const remote = await POST(request({ name: 'remote.zip', url: 'https://judge.example.test/file/remote.zip' }));
  assert.equal(remote.status, 200); assert.equal(await remote.text(), 'file-bytes');
});
