import assert from 'node:assert/strict';
import test from 'node:test';
import { enableHydroBrowserContest, hydroBrowserConnection, loginHydroBrowser, trustedHydroBrowserTarget } from '../src/lib/hydro-browser';
import { assertHydroBrowserOriginKey, normalizeExamSettings } from '../src/lib/exam-settings';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';

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

test('an independent Hydro contest uses only its exam key for protection and login binding', async t => {
  const remote = { ...exam, platformBaseUrl: 'https://other-judge.example/d/race', hydroBrowserApiKey: 'exam-only-key' };
  const bridge = `${remote.platformBaseUrl}/api/proctor/browser-contest/${tid}`;
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests.push(url);
    const headers = new Headers(options.headers);
    if (url === 'https://other-judge.example/login') {
      assert.equal(headers.has('x-proctor-api-key'), false);
      return Response.json({}, { headers: { 'set-cookie': `sid=${sid}; Path=/` } });
    }
    assert.equal(url, bridge);
    assert.equal(headers.get('x-proctor-api-key'), remote.hydroBrowserApiKey);
    assert.notEqual(headers.get('x-proctor-api-key'), connection.apiKey);
    return Response.json({ ok: true, data: { contestId: tid, proctoringKey: 'x'.repeat(43) } });
  });
  await enableHydroBrowserContest(remote, connection);
  const result = await loginHydroBrowser(remote, candidate, connection);
  assert.equal(result.loginUrl, `${remote.platformBaseUrl}/contest/${tid}`);
  assert.deepEqual(requests, [bridge, 'https://other-judge.example/login', bridge]);
});

test('an independent site without an exam key cannot receive the shared key or candidate password', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must not call'); });
  const remote = { ...exam, platformBaseUrl: 'https://unconfigured.example' };
  await assert.rejects(enableHydroBrowserContest(remote, connection), /本?考试的监考插件 API-Key/);
  await assert.rejects(loginHydroBrowser(remote, candidate, connection), /本?考试的监考插件 API-Key/);
  assert.equal(requests, 0);
  assert.deepEqual(hydroBrowserConnection(exam, connection), connection, 'legacy same-site exams retain the configured key');
});

test('Hydro browser settings do not require local contest format and do not reuse keys across origins', () => {
  const input = CreateExamSchema.parse({ name: 'Remote Hydro', platform: 'HYDRO_BROWSER', platformBaseUrl: 'https://other-judge.example',
    platformContestId: tid, hydroBrowserApiKey: ' exam-only-key ', hydroBrowserEventFeedApiKey: ' exam-event-feed-key-0123456789abcdef ',
    startAt: new Date('2026-12-01T00:00:00Z'),
    latestStartAt: new Date('2026-12-01T00:00:00Z'), endAt: new Date('2026-12-01T02:00:00Z'), durationMinutes: 120 });
  const saved = normalizeExamSettings(input);
  assert.equal(saved.hydroBrowserApiKey, 'exam-only-key');
  assert.equal(saved.hydroBrowserEventFeedApiKey, 'exam-event-feed-key-0123456789abcdef');
  assert.throws(() => normalizeExamSettings({ ...input, hydroBrowserEventFeedApiKey: 'short' }), /EventFeed/);
  assert.equal(input.contestType, 'INDIVIDUAL');
  assert.doesNotThrow(() => assertHydroBrowserOriginKey(origin, `${origin}/d/another`));
  assert.throws(() => assertHydroBrowserOriginKey(origin, 'https://other-judge.example'), /更换 HydroOJ/);
  assert.doesNotThrow(() => assertHydroBrowserOriginKey(origin, 'https://other-judge.example', 'replacement-key'));
});
