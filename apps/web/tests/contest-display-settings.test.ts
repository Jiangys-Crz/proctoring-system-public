import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeContestDisplay, displayPatchSchema, mergeContestDisplaySettings, readContestDisplaySettings } from '../src/lib/contest-display-config';
import { defaultContestDisplaySettings } from '../src/lib/contest-display-contract';
import { digestContestLiveValue, makeContestLiveObsKey } from '../src/lib/contest-live-access';
import { admittedContestDisplayConnection, admittedContestDisplayRead } from '../src/lib/heavy-read-admission';

const startAt = new Date('2026-11-17T01:00:00Z');
const endAt = new Date('2026-11-17T04:00:00Z');
const now = new Date('2026-11-17T03:30:00Z');
const at = '2026-11-17T03:00:00.000Z';
const timing = { startAt, endAt };

test('display access requires its own freeze and active viewing key, while a manager can preview a paused display', () => {
  const key = makeContestLiveObsKey();
  const config = { settings: defaultContestDisplaySettings, keyHash: digestContestLiveValue(key), revision: 1, startedAt: null };
  const client = { key, manage: false };
  const manager = { key: null, manage: true };
  assert.throws(() => authorizeContestDisplay(config, client), /设置封榜时间/);
  assert.throws(() => authorizeContestDisplay(config, manager), /设置封榜时间/);
  const settings = mergeContestDisplaySettings(config.settings, { freeze: { at } }, timing, now);
  assert.doesNotThrow(() => authorizeContestDisplay({ ...config, settings }, manager));
  assert.throws(() => authorizeContestDisplay({ ...config, settings }, client), /暂停/);
  const active = { ...config, settings: { ...settings, enabled: true } };
  assert.doesNotThrow(() => authorizeContestDisplay(active, client));
  assert.throws(() => authorizeContestDisplay({ ...active, keyHash: null }, client), /链接已失效/);
});

test('director controls cannot activate without a freeze, reveal early or retain playback after clearing the time', () => {
  const defaults = defaultContestDisplaySettings;
  assert.throws(() => mergeContestDisplaySettings(defaults, { enabled: true }, timing, now), /设置大屏封榜时间/);
  assert.throws(() => mergeContestDisplaySettings(defaults, { freeze: { at: endAt.toISOString() } }, timing, now), /比赛开始和结束之间/);
  const settings = mergeContestDisplaySettings(defaults, { freeze: { at }, enabled: true }, timing, now);
  assert.throws(() => mergeContestDisplaySettings(settings, { freeze: { revealed: true } }, timing, startAt), /达到封榜时间/);
  const revealed = mergeContestDisplaySettings(settings, { freeze: { revealed: true } }, timing, now);
  assert.deepEqual(readContestDisplaySettings(JSON.parse(JSON.stringify(revealed))).freeze, { at, revealed: true });
  const cleared = mergeContestDisplaySettings(revealed, { freeze: { at: null } }, timing, now);
  assert.equal(cleared.enabled, false);
  assert.deepEqual(cleared.freeze, { at: null, revealed: false });
});

test('only supported presentations, transitions and bounded playback speeds can be saved', () => {
  assert.equal(displayPatchSchema.safeParse({ scene: 'queue', transition: 'fade', speed: 1 }).success, true);
  assert.equal(displayPatchSchema.safeParse({ scene: 'other', speed: 1 }).success, false);
  assert.equal(displayPatchSchema.safeParse({ durationSeconds: 2 }).success, false);
  assert.equal(displayPatchSchema.safeParse({ speed: -1 }).success, false);
  assert.equal(displayPatchSchema.safeParse({ historyExamIds: ['event', 'event'] }).success, false);
  assert.equal(displayPatchSchema.safeParse({ presentationAssets: { background: 'javascript:alert(1)' } }).success, false);
});

test('scene options stay attached to a plan and old playlists keep global defaults', () => {
  const step = { transition: 'wipe', durationSeconds: 7, properties: { theme: 'light', message: 'Contest opens shortly' } } as const;
  const settings = mergeContestDisplaySettings(defaultContestDisplaySettings, {
    playlist: ['scoreboard', 'message'], playlistOptions: [null, step], autoplay: true,
  }, timing);
  assert.deepEqual(readContestDisplaySettings(JSON.parse(JSON.stringify(settings))).playlistOptions, [null, step]);
  assert.deepEqual(mergeContestDisplaySettings(settings, { hidden: true }, timing).playlistOptions, settings.playlistOptions);
  assert.deepEqual(mergeContestDisplaySettings(settings, { playlist: ['scoreboard'] }, timing).playlistOptions, []);
  assert.equal(displayPatchSchema.safeParse({ playlistOptions: [{ durationSeconds: 2 }] }).success, false);
  assert.equal(displayPatchSchema.safeParse({ playlistOptions: [{ properties: { freeze: { revealed: true } } }] }).success, false);
  assert.equal(readContestDisplaySettings({ playlist: ['scoreboard'] }).durationSeconds, 15);
});

test('open presentation event streams leave slots for initial and fallback reads', async () => {
  const request = new Request('http://localhost/contest-display/events');
  const streams = await Promise.all(Array.from({ length: 6 }, () =>
    admittedContestDisplayConnection(request, async () => new Response(new ReadableStream()))));
  try {
    assert.ok(streams.every(response => response.ok));
    const snapshot = await admittedContestDisplayRead(request, async () => Response.json({ snapshot: true }));
    assert.deepEqual(await snapshot.json(), { snapshot: true });
  } finally {
    await Promise.all(streams.map(response => response.body?.cancel()));
  }
});
