import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContestLiveData, ContestLiveSubmission } from '../src/lib/contest-live-contract';
import { defaultContestLiveSettings } from '../src/lib/contest-live-settings';
import { makeOverlaySnapshot } from '../src/contest-live-overlay/adapter';
import { createOverlayQueue } from '../src/contest-live-overlay/queueFeed';

const now = Date.parse('2026-11-17T02:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const submission = (id: string, age: number, verdict: string | null, firstBlood = false): ContestLiveSubmission => ({
  id, teamId: id, problemId: 'A', submittedAt: iso(now - age), seconds: 1000, verdict, score: null, firstBlood,
});
const contest = (submissions: ContestLiveSubmission[]): ContestLiveData => ({
  exam: { id: 'test', name: 'Test', source: 'local', startAt: iso(now - 3_600_000), endAt: iso(now + 600_000),
    beforeStart: false, freezeAt: iso(now - 10_000), frozen: true, scoring: 'icpc' },
  problems: [], teams: [], standings: [], submissions, timeline: [], statistics: [], sourceError: null, updatedAt: iso(now),
});

test('overlay uses Live queue lifetimes and retains the featured entry', () => {
  const queue = createOverlayQueue();
  const newest = submission('new', 1_000, 'AC');
  const old = submission('old', 61_000, 'AC');
  const first = submission('first', 100_000, 'AC', true);
  const pending = submission('pending', 200_000, null);
  const data = contest([newest, old, first, pending]);
  assert.deepEqual(queue.select(data, null, now).map(row => row.id), ['new', 'first', 'pending']);
  assert.deepEqual(queue.select(data, old.id, now + 22_000).map(row => row.id), ['new', 'old', 'pending']);
  data.submissions[1] = { ...old, verdict: 'WA' };
  assert.deepEqual(queue.select(data, null, now + 70_000).map(row => row.id), ['old', 'pending']);
});

test('overlay reserves room for first-to-solve and drops the oldest judged entries', () => {
  const queue = createOverlayQueue();
  const regular = Array.from({ length: 26 }, (_, n) => submission(String(n), 1000 + n * 500, 'WA'));
  const oldest = submission('first', 20_000, 'AC', true);
  const rows = queue.select(contest([...regular, oldest]), null, now);
  assert.equal(rows.length, 19);
  assert.equal(rows.at(-1)?.id, 'first');
  assert.deepEqual(rows.slice(0, 3).map(row => row.id), ['0', '1', '2']);
});

test('ongoing test progress refreshes a queue entry and reaches the overlay until the verdict arrives', () => {
  const queue = createOverlayQueue();
  const run = submission('judging', 299_000, null);
  const data = contest([run]);
  const snapshot = (time: number) => makeOverlaySnapshot({
    contest: { ...data, teams: [] }, settings: { ...defaultContestLiveSettings, obsKeyActive: false },
  }, time, false, queue.select(data, null, time)).queue[0].result;
  const progress = (time: number) => {
    const result = snapshot(time);
    assert.equal(result.type, 'IN_PROGRESS');
    return result.testedPart;
  };
  assert.equal(progress(now), undefined);
  run.testedPart = 0.25;
  assert.equal(progress(now + 5000), 0.25);
  run.testedPart = 0.75;
  assert.equal(progress(now + 6000), 0.75);
  run.frozen = true;
  assert.equal(progress(now + 7000), undefined);
  run.frozen = false;
  run.verdict = 'AC';
  assert.equal(snapshot(now + 8000).type, 'ICPC');
});
