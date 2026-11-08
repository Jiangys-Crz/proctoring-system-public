import assert from 'node:assert/strict';
import test from 'node:test';
import { enableHydroBrowserContest, loginHydroBrowser, trustedHydroBrowserTarget } from '../src/lib/hydro-browser';

const origin = 'https://judge.example.test';
const tid = '0123456789abcdefabcdef01';
const exam = { platformBaseUrl: `${origin}/d/acm`, platformContestId: tid };
const candidate = { examNumber: 'player1', password: 'example-password' };
const sid = 'abcdefghijklmnopqrstuv0123456789';
const connection = { baseUrl: origin, apiKey: 'hydro-api-key' };

test('Hydro browser target accepts domain paths and requires the configured origin', () => {
  assert.equal(trustedHydroBrowserTarget(exam, origin).base, exam.platformBaseUrl);
  assert.throws(() => trustedHydroBrowserTarget(exam, `${origin}:8443`), /同一站点/);
  assert.throws(() => trustedHydroBrowserTarget({ ...exam, platformBaseUrl: `${origin}/d/acm/contest` }, origin), /域ID/);
});

test('native Hydro login transfers the session only for an enrolled candidate in the selected contest', async t => {
  const proctoringKey = 'x'.repeat(43);
  const bridge = `${exam.platformBaseUrl}/api/proctor/browser-contest/${tid}`;
  let enrolled = true;
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests.push(url);
    assert.equal(options.redirect, 'manual');
    if (url === `${origin}/login`) {
      assert.equal((options.body as URLSearchParams).get('uname'), candidate.examNumber);
      return Response.json({}, { headers: { 'set-cookie': `sid=${sid}; Path=/` } });
    }
    const headers = new Headers(options.headers);
    assert.equal(headers.get('x-proctor-api-key'), connection.apiKey);
    const payload = JSON.parse(options.body as string);
    if (payload.action === 'enable') {
      assert.equal(headers.has('cookie'), false);
      return Response.json({ ok: true, data: { contestId: tid } });
    }
    assert.equal(payload.username, candidate.examNumber);
    assert.equal(headers.get('cookie'), `sid=${sid}`);
    return enrolled ? Response.json({ ok: true, data: { contestId: tid, proctoringKey } }) : Response.json({}, { status: 403 });
  });
  await enableHydroBrowserContest(exam, connection);
  const login = await loginHydroBrowser(exam, candidate, connection);
  assert.deepEqual(login, { platform: 'HYDRO_BROWSER', loginUrl: `${exam.platformBaseUrl}/contest/${tid}`, proctoringKey, cookie: { name: 'sid', value: sid } });
  assert.deepEqual(requests, [bridge, `${origin}/login`, bridge]);
  enrolled = false;
  await assert.rejects(loginHydroBrowser(exam, candidate, connection), /普通选手/);
});
