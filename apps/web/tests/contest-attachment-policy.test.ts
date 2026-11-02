import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canReadContestAttachments } from '../src/lib/contest-attachment-policy';

const now = new Date('2026-10-07T08:00:00Z');
const past = new Date('2026-10-07T07:00:00Z');
const future = new Date('2026-10-07T09:00:00Z');
test('attachment access requires both global opening and a real personal start', () => {
  const session = { startedAt: null as Date | null, candidate: { startedAt: null as Date | null }, exam: { startAt: past } };
  assert.equal(canReadContestAttachments(session, now), false); // Approved, waiting to start.
  assert.equal(canReadContestAttachments({ ...session, startedAt: past }, now), true);
  assert.equal(canReadContestAttachments({ ...session, startedAt: future }, now), false);
  assert.equal(canReadContestAttachments({ ...session, startedAt: past, exam: { startAt: future } }, now), false);
  assert.equal(canReadContestAttachments({ ...session, candidate: { startedAt: past } }, now), true); // Approved re-login preserves the personal clock.
});
