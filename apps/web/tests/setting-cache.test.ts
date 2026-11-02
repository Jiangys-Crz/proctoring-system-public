import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingCache } from '../src/lib/setting-cache';

test('500 simultaneous configuration reads share one query and do not share mutable values', async () => {
  const cache = createSettingCache<{ s3: { bucket: string } }>();
  let queries = 0;
  const read = () => cache.read(async () => { queries++; return { s3: { bucket: 'original' } }; });
  const results = await Promise.all(Array.from({ length: 500 }, read));
  assert.equal(queries, 1);
  results[0].s3.bucket = 'changed';
  assert.equal(results[1].s3.bucket, 'original');
  assert.equal((await read()).s3.bucket, 'original');
});

test('configuration save invalidation cannot be undone by an older pending read', async () => {
  const cache = createSettingCache<string>();
  let complete!: (value: string) => void;
  const pending = cache.read(() => new Promise(resolve => { complete = resolve; }));
  await Promise.resolve();
  cache.invalidate();
  assert.equal(await cache.read(async () => 'new'), 'new');
  complete('old');
  assert.equal(await pending, 'old');
  assert.equal(await cache.read(async () => 'wrong'), 'new');
});

test('failed queries are retried and expired entries refresh', async () => {
  const cache = createSettingCache<number>(10);
  await assert.rejects(cache.read(async () => { throw new Error('database unavailable'); }));
  assert.equal(await cache.read(async () => 1), 1);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(await cache.read(async () => 2), 2);
});
