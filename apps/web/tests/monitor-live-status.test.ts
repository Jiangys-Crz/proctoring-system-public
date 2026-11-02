import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMonitorLiveStatusLoader } from '../src/lib/monitor-live-status';

const active = (id: string) => ({ id, status: 'IN_EXAM' });
const path = (id: string, extra = {}) => ({ name: `live/${id}_DESKTOP_SCREEN`, ready: true, bytesReceived: 100, ...extra });

test('thirty monitor requests share one signed media query and cache presence, never authorization', async () => {
  let now = 1000, calls = 0;
  const load = createMonitorLiveStatusLoader({ now: () => now, base: () => 'http://media.test/', token: () => 'signed-private-token',
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), 'http://media.test/v3/paths/list?itemsPerPage=500&page=0');
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer signed-private-token');
      assert.equal(init?.cache, 'no-store');
      return Response.json({ pageCount: 1, items: [path('allowed'), path('other-room'), path('finished')] });
    } });
  const results = await Promise.all(Array.from({ length: 30 }, () => load([active('allowed'), { id: 'finished', status: 'FINISHED' }])));
  assert.equal(calls, 1);
  for (const result of results) assert.deepEqual(result, { liveStatusAvailable: true, liveReadySessionIds: ['allowed'] });
  assert.deepEqual(await load([active('other-room')]), { liveStatusAvailable: true, liveReadySessionIds: ['other-room'] });
  assert.deepEqual(await load([]), { liveStatusAvailable: true, liveReadySessionIds: [] }, 'revoked scopes cannot inherit cached session IDs');
  assert.equal(calls, 1);
  now += 2001;
  await load([active('allowed')]);
  assert.equal(calls, 2);
});

test('all pages and all video channels count, but no bytes, stale paths or unrelated paths do not', async () => {
  let calls = 0;
  const load = createMonitorLiveStatusLoader({ base: () => 'http://media.test', token: () => 'token', fetch: async url => {
    calls++;
    return Response.json({ pageCount: 2, items: String(url).endsWith('page=0')
      ? [path('empty', { bytesReceived: 0 }), path('stopped', { ready: false }), path('foreign', { name: 'other/foreign_DESKTOP_SCREEN' })]
      : [path('mobile', { name: 'live/mobile_MOBILE_CAMERA' }), path('front', { name: 'live/front_DESKTOP_CAMERA' })] });
  } });
  assert.deepEqual(await load(['empty', 'stopped', 'foreign', 'mobile', 'front'].map(active)), {
    liveStatusAvailable: true, liveReadySessionIds: ['mobile', 'front'],
  });
  assert.equal(calls, 2);
});

test('unavailable/partial media snapshots are unknown, bounded and retryable without claiming a stopped stream is live', async () => {
  let now = 1, mode = 'ready', calls = 0;
  const load = createMonitorLiveStatusLoader({ now: () => now, base: () => 'http://media.test', token: () => 'token', fetch: async url => {
    calls++;
    if (mode === 'ready') return Response.json({ pageCount: 1, items: [path('a')] });
    if (mode === 'partial' && String(url).endsWith('page=0')) return Response.json({ pageCount: 2, items: [path('a')] });
    if (mode === 'oversized') return Response.json({ pageCount: 100, items: [path('a')] });
    throw new Error('unavailable');
  } });
  assert.equal((await load([active('a')])).liveStatusAvailable, true);
  for (const value of ['partial', 'oversized', 'offline']) {
    mode = value; now += 2001;
    assert.deepEqual(await load([active('a')]), { liveStatusAvailable: false, liveReadySessionIds: [] });
    const before = calls;
    await Promise.all(Array.from({ length: 30 }, () => load([active('a')])));
    assert.equal(calls, before, 'failed reads also have a short cooldown');
  }
  mode = 'ready'; now += 1001;
  assert.deepEqual(await load([active('a')]), { liveStatusAvailable: true, liveReadySessionIds: ['a'] });
});

test('a changed media endpoint or signing secret cannot reuse the previous stream snapshot', async () => {
  let token = 'first', base = 'http://media.test', calls = 0;
  const load = createMonitorLiveStatusLoader({ base: () => base, token: () => token, fetch: async () => {
    calls++; return Response.json({ pageCount: 1, items: calls === 1 ? [path('a')] : [] });
  } });
  await load([active('a')]);
  token = 'second';
  assert.deepEqual((await load([active('a')])).liveReadySessionIds, []);
  base = 'http://another-media.test'; await load([active('a')]);
  assert.equal(calls, 3);
});
