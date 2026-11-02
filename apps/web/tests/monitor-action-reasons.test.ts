import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkSchema, UnlockSchema } from '../src/lib/monitor-action-schemas';

test('marking cheating and unlocking both require a non-blank reason', () => {
  for (const schema of [MarkSchema, UnlockSchema]) {
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(schema.safeParse({ reason: '   ' }).success, false);
    assert.equal(schema.safeParse({ reason: 'a'.repeat(501) }).success, false);
    assert.equal(schema.parse({ reason: '  现场核查  ' }).reason, '现场核查');
  }
});
