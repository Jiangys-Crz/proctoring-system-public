import assert from 'node:assert/strict';
import test from 'node:test';
import { ccsContestTimeMs, coverage, finalVerdict, readNdjson, reactionTimelineFrames, type TimedSegment } from '../src/lib/reaction-domain';

const epoch = Date.parse('2026-11-04T02:30:00.000Z');
const at = (seconds: number) => new Date(epoch + seconds * 1000);
function segment(id: string, from: number, to: number, patch: Partial<TimedSegment> = {}): TimedSegment {
  return { id, startedAt: at(from), endedAt: at(to), durationSeconds: to - from, clockOffsetMs: 0, clockUncertaintyMs: 10, ...patch };
}
function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); } });
}

test('NDJSON keeps UTF-8 team names across every byte boundary and ignores heartbeats', async () => {
  const events = [
    { id: '1', type: 'submissions', op: 'create', data: { id: '10086', team_id: 'team007', name: '测试队伍😀' } },
    { id: '2', type: 'judgements', op: 'update', data: { submission_id: '10086', judgement_type_id: 'WA' } },
  ];
  const bytes = new TextEncoder().encode(`\r\n${JSON.stringify(events[0])}\r\n\n${JSON.stringify(events[1])}`);
  const actual = [];
  for await (const event of readNdjson(stream([...bytes].map(value => new Uint8Array([value]))))) actual.push(event);
  assert.deepEqual(actual, events);
});

test('invalid JSON and unbounded lines fail instead of emitting fabricated events', async () => {
  const consume = async (input: string) => { for await (const _event of readNdjson(stream([new TextEncoder().encode(input)]))) { /* drain */ } };
  await assert.rejects(consume('{broken}\n'), SyntaxError);
  await assert.rejects(consume(' '.repeat(8 * 1024 * 1024 + 1)), /exceeds limit/);
});

test('submission at 0 and judgement at 15 retain exactly -3 through +25 seconds', () => {
  const result = coverage([segment('a', -10, 0), segment('b', 0, 10), segment('c', 10, 20), segment('d', 20, 30)], at(-3), at(25));
  assert.equal(result.complete, true);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.slices.map(({ id, from, duration, timelineStart }) => ({ id, from, duration, timelineStart })), [
    { id: 'a', from: 7, duration: 3, timelineStart: 0 },
    { id: 'b', from: 0, duration: 10, timelineStart: 3 },
    { id: 'c', from: 0, duration: 10, timelineStart: 13 },
    { id: 'd', from: 0, duration: 5, timelineStart: 23 },
  ]);
  assert.equal(result.slices.reduce((sum, value) => sum + value.duration, 0), 28);
});

test('late submission feed and interrupted tail expose the missing pre/post intervals', () => {
  const result = coverage([segment('a', 0, 10), segment('b', 10, 15)], at(-3), at(25));
  assert.equal(result.complete, false);
  assert.deepEqual(result.gaps, [
    { start: at(-3).toISOString(), end: at(0).toISOString() },
    { start: at(15).toISOString(), end: at(25).toISOString() },
  ]);
});

test('overlapping source segments are shared without duplicating playback time', () => {
  const sources = [segment('b', 5, 15), segment('a', 0, 10), segment('duplicate', 0, 10), segment('c', 10, 20)];
  const first = coverage(sources, at(2), at(18));
  const second = coverage(sources, at(8), at(20));
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(first.slices.reduce((sum, value) => sum + value.duration, 0), 16);
  assert.equal(second.slices.reduce((sum, value) => sum + value.duration, 0), 12);
  assert.deepEqual(first.slices.map(value => value.id), ['a', 'b', 'c']);
  assert.deepEqual(sources.map(value => value.id), ['b', 'a', 'duplicate', 'c']);
});

test('unknown or uncertain clock mapping never produces complete coverage', () => {
  for (const patch of [{ clockOffsetMs: null }, { clockUncertaintyMs: null }, { clockUncertaintyMs: 251 }]) {
    const result = coverage([segment('camera', -3, 25, patch)], at(-3), at(25));
    assert.equal(result.complete, false);
    assert.ok(result.issues.includes('CLOCK_UNCERTAIN:camera'));
  }
});

test('independent video duration and missing timestamp are verified per source', () => {
  const desktop = coverage([segment('desktop', -3, 25)], at(-3), at(25));
  const camera = coverage([segment('camera', -3, 25, { durationSeconds: 20 })], at(-3), at(25));
  const unknown = coverage([segment('unknown', -3, 25, { endedAt: null })], at(-3), at(25));
  assert.equal(desktop.complete, true);
  assert.equal(camera.complete, false);
  assert.ok(camera.issues.includes('DURATION_MISMATCH:camera'));
  assert.equal(unknown.complete, false);
  assert.ok(unknown.issues.includes('UNVERIFIED_TIMING:unknown'));
});

test('empty source and interior disconnect remain incomplete', () => {
  assert.equal(coverage([], at(-3), at(25)).complete, false);
  const result = coverage([segment('a', -3, 5), segment('b', 8, 25)], at(-3), at(25));
  assert.equal(result.complete, false);
  assert.deepEqual(result.gaps, [{ start: at(5).toISOString(), end: at(8).toISOString() }]);
});

test('NovaJudge AC/WA/SE and supported final verdicts terminate; pending events do not', () => {
  for (const verdict of ['AC', 'WA', 'TLE', 'RE', 'RTE', 'CE', 'MLE', 'OLE', 'PE', 'SE']) assert.equal(finalVerdict({ judgement_type_id: verdict }), verdict);
  for (const verdict of [null, undefined, '', 'PENDING', 'RUNNING', 'JUDGING', 'COMPILING']) assert.equal(finalVerdict({ judgement_type_id: verdict }), null);
  assert.equal(finalVerdict({}), null);
});

test('nonfinite media timing and clock values fail closed', () => {
  for (const patch of [{ durationSeconds: NaN }, { durationSeconds: Infinity }, { durationSeconds: -1 }, { startedAt: new Date(NaN) }, { endedAt: new Date(NaN) }, { clockOffsetMs: Infinity }, { clockUncertaintyMs: NaN }, { clockUncertaintyMs: -1 }]) {
    assert.equal(coverage([segment('bad', -3, 25, patch)], at(-3), at(25)).complete, false);
  }
  assert.throws(() => coverage([], at(5), at(1)), /WINDOW_INVALID/);
  assert.throws(() => coverage([], new Date(NaN), at(5)), /WINDOW_INVALID/);
});

test('black placeholders preserve front/interior/tail gap positions and total frame count', () => {
  const report = coverage([segment('a', 0, 5), segment('b', 8, 20)], at(-3), at(25));
  const frames = reactionTimelineFrames(report.slices, 28);
  assert.deepEqual(frames.map(piece => [piece.id, piece.startFrame, piece.frames]), [
    [null, 0, 75], ['a', 75, 125], [null, 200, 75], ['b', 275, 300], [null, 575, 125],
  ]);
  assert.equal(frames.reduce((sum, piece) => sum + piece.frames, 0), 700);
  const truncated = coverage([segment('short', 0, 10, { durationSeconds: 6 })], at(0), at(10));
  assert.equal(truncated.complete, false);
  assert.deepEqual(reactionTimelineFrames(truncated.slices, 10).map(piece => [piece.id, piece.frames]), [['short', 150], [null, 100]]);
});

test('CCS contest clock is parsed independently of proctoring exam start time', () => {
  assert.equal(ccsContestTimeMs('0:24:49.326'), 1_489_326);
  assert.equal(ccsContestTimeMs('12:03:04.5'), 43_384_500);
  assert.equal(ccsContestTimeMs('123:45:56.789'), 445_556_789);
  assert.equal(ccsContestTimeMs('0:00:00'), 0);
  assert.equal(ccsContestTimeMs('0:00:00.000123'), 0);
  for (const value of [null, '', '0:99:01', '2026-11-04T06:41:17Z', '-1:00:00', 'Infinity:00:00', '999999999999999999:00:00']) assert.equal(ccsContestTimeMs(value), null);
});
