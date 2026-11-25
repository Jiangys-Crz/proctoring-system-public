import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContestFeedSettingsSchema, contestFeedSettingsStatus, saveContestFeedSettings } from '../src/lib/contest-event-feed-settings';
import { configuredContestEventFeed } from '../src/lib/contest-live-event-feed';
import { prisma } from '../src/lib/db';

test('stored CCS credentials are encrypted, omitted from settings responses and restricted to the configured contest origin', async t => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret-used-only-by-this-test';
  t.after(() => {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  });
  const rows = new Map<string, string>();
  const original = { upsert: prisma.systemSetting.upsert, findMany: prisma.systemSetting.findMany, deleteMany: prisma.systemSetting.deleteMany };
  prisma.systemSetting.upsert = (async ({ create }: { create: { key: string; value: string } }) => {
    rows.set(create.key, create.value);
  }) as never;
  prisma.systemSetting.findMany = (async () => [...rows.entries()].map(([key, value]) => ({ key, value }))) as never;
  prisma.systemSetting.deleteMany = (async ({ where }: { where: { key: string } }) => rows.delete(where.key)) as never;
  t.after(() => { Object.assign(prisma.systemSetting, original); });

  const hydroKey = 'unchanged-standalone-ccs-api-key-01234';
  const password = 'test-password-with-separators:123';
  await saveContestFeedSettings(ContestFeedSettingsSchema.parse({ platform: 'nova', origin: 'https://nova.example/', username: 'ccs-user', password }));
  await saveContestFeedSettings(ContestFeedSettingsSchema.parse({ platform: 'hydro', origin: 'https://hydro.example', apiKey: hydroKey }));
  assert.equal([...rows.values()].every(value => !value.includes(password) && !value.includes(hydroKey)), true);
  assert.deepEqual(await contestFeedSettingsStatus(), { nova: { origin: 'https://nova.example', username: 'ccs-user' } });
  const hydroExam = { id: 'fixture', platform: 'HYDRO_BROWSER', platformBaseUrl: 'https://hydro.example/d/acm', platformContestId: 'a'.repeat(24) };
  const configured = await configuredContestEventFeed(hydroExam, 'hydro');
  assert.equal(configured?.headers['x-ccs-api-key'], hydroKey);
  assert.equal(new URL(configured!.url).pathname, `/d/acm/api/ccs/contests/${hydroExam.platformContestId}/event-feed`);
  const examKey = 'exam-owned-event-feed-key-0123456789abcdef';
  const perExam = { ...hydroExam, hydroBrowserEventFeedApiKey: examKey };
  const perExamConfigured = await configuredContestEventFeed(perExam, 'hydro');
  assert.equal(perExamConfigured?.headers['x-ccs-api-key'], examKey);
  assert.notEqual(perExamConfigured?.headers['x-ccs-api-key'], hydroKey);
  assert.equal(new URL(perExamConfigured!.url).pathname, `/d/acm/api/ccs/contests/${hydroExam.platformContestId}/event-feed`);
  const localHydro = { ...hydroExam, platform: 'HYDRO' as const, hydroBrowserEventFeedApiKey: examKey };
  assert.equal((await configuredContestEventFeed(localHydro, 'hydro'))?.headers['x-ccs-api-key'], hydroKey);
  await assert.rejects(configuredContestEventFeed({ ...hydroExam, hydroBrowserEventFeedApiKey: 'too-short' }, 'hydro'), /EventFeed/);
  assert.equal(await configuredContestEventFeed({ ...hydroExam, platformBaseUrl: 'https://unconfigured.invalid' }, 'hydro'), null);
  await saveContestFeedSettings({ platform: 'hydro', remove: true });
  assert.deepEqual(await contestFeedSettingsStatus(), { nova: { origin: 'https://nova.example', username: 'ccs-user' } });
  assert.equal((await configuredContestEventFeed(perExam, 'hydro'))?.headers['x-ccs-api-key'], examKey);
});
