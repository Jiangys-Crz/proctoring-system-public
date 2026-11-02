import assert from 'node:assert/strict';
import test from 'node:test';
import { problemLimits } from '../src/lib/problem-limits';
import { serializeLocalContest } from '../src/lib/local-contest';

test('programming problems without explicit limits use Hydro defaults', () => {
  assert.deepEqual(problemLimits({}), { timeLimitMs: 1000, memoryLimitMb: 256 });
  assert.deepEqual(problemLimits({ type: 'default', subtasks: [{ cases: [{ input: '1.in', output: '1.out' }] }] }), { timeLimitMs: 1000, memoryLimitMb: 256 });
});

test('empty computed maxima do not mask configured limits', () => {
  assert.deepEqual(problemLimits({ timeMax: 0, memoryMax: 0, time: '2s', memory: '512m' }), { timeLimitMs: 2000, memoryLimitMb: 512 });
  assert.deepEqual(problemLimits({ timeMax: null, memoryMax: null, timeLimit: '1.5s', memoryLimit: '1g' }), { timeLimitMs: 1500, memoryLimitMb: 1024 });
});

test('test cases inherit subtask and global limits, exposing the actual largest case limits', () => {
  assert.deepEqual(problemLimits({ time: '500ms', memory: '256m', subtasks: [
    { time: '1.5s', memory: '128m', cases: [{}, { time: '2s', memory: '64m' }] },
    { memory: '512m', cases: [{}] },
  ] }), { timeLimitMs: 2000, memoryLimitMb: 512 });
  assert.deepEqual(problemLimits({ time: '5s', memory: '1g', cases: [
    { time: '500ms', memory: '64m' }, { time: '750ms', memory: '128m' },
  ] }), { timeLimitMs: 750, memoryLimitMb: 128 });
});

test('positive computed maxima retain precedence and non-executable questions have no runtime limits', () => {
  assert.deepEqual(problemLimits({ timeMax: 3000, memoryMax: '1g', time: '1s', memory: '64m' }), { timeLimitMs: 3000, memoryLimitMb: 1024 });
  for (const type of ['objective', 'submit_answer']) {
    assert.deepEqual(problemLimits({ type }), { timeLimitMs: null, memoryLimitMb: null });
  }
});

test('existing cached problems receive limits in the contest API without a database rewrite', () => {
  const now = new Date();
  const input = {
    exam: { id: 'exam', name: '限制验证', contestRule: 'IOI', contestType: 'INDIVIDUAL',
      startAt: new Date(+now - 60_000), latestStartAt: new Date(+now + 60_000), endAt: new Date(+now + 3_600_000), durationMinutes: 60,
      allowedLanguages: [], problems: [{ id: 'problem', order: 0, hydroProblemId: '2', title: '签到', score: 100,
        content: 'Statement', html: false, problemType: 'default', config: {}, files: [], timeLimitMs: null, memoryLimitMb: null }] },
    candidate: { id: 'candidate', examNumber: 'qa', startedAt: now },
    session: { id: 'session', status: 'IN_EXAM', startedAt: now, lockdown: false, lockdownReason: null, latestStartAt: now },
    languages: [], submissions: [],
  } as any;
  const problem = serializeLocalContest(input).problems[0];
  assert.equal(problem.timeLimit, 1000); assert.equal(problem.memoryLimit, 256);
  assert.deepEqual(problem.config, { type: 'default' });
  assert.equal(input.exam.problems[0].timeLimitMs, null, 'serialization must not change stored exam data');
  input.exam.problems[0].timeLimitMs = 2000; input.exam.problems[0].memoryLimitMb = 64;
  const configured = serializeLocalContest(input).problems[0];
  assert.equal(configured.timeLimit, 2000); assert.equal(configured.memoryLimit, 64, 'saved custom limits retain precedence');
  input.candidate.startedAt = null; input.session.startedAt = null;
  const beforeStart = serializeLocalContest(input).problems[0];
  assert.equal(beforeStart.timeLimit, undefined); assert.equal(beforeStart.memoryLimit, undefined);
});
