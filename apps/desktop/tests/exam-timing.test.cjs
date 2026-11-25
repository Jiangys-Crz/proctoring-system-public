const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
function harness() {
  const exam = { id: 'exam', updatedAt: '2026-11-19T10:00:00Z', startAt: '2026-11-19T11:00:00Z', endAt: '2026-11-19T12:30:00Z', durationMinutes: 90 };
  const session = { id: 'session', examId: 'exam', startedAt: null, status: 'APPROVED' };
  const state = { exam, session, screenStream: {}, drafts: { code: 'int main() {}' } };
  const context = vm.createContext({ state });
  vm.runInContext(source.slice(source.indexOf('function acceptExamTiming('), source.indexOf('function clientAuthHeaders(')), context);
  const timing = { examId: 'exam', updatedAt: '2026-11-19T10:54:43Z', startAt: '2026-11-19T11:10:00Z', latestStartAt: '2026-11-19T11:25:00Z', endAt: '2026-11-19T12:40:00Z', durationMinutes: 90, flexible: false, contestRule: 'KS' };
  return { context, state, exam, session, timing };
}
test('a live delay updates the shell clock metadata without replacing its session, capture or drafts', () => {
  const h = harness(), capture = h.state.screenStream, drafts = h.state.drafts;
  assert.equal(h.context.acceptExamTiming(h.timing, 'session'), true);
  assert.equal(h.state.exam.startAt, h.timing.startAt); assert.equal(h.state.exam.endAt, h.timing.endAt);
  assert.equal(h.state.session, h.session); assert.equal(h.state.session.startedAt, null);
  assert.equal(h.state.screenStream, capture); assert.equal(h.state.drafts, drafts);
  const extended = { ...h.timing, updatedAt: '2026-11-19T11:20:00Z', endAt: '2026-11-19T13:00:00Z', durationMinutes: 110 };
  assert.equal(h.context.acceptExamTiming(extended, 'session'), true);
  assert.equal(h.context.acceptExamTiming(h.timing, 'session'), false, 'late responses cannot restore an old deadline');
  assert.equal(h.state.exam.endAt, extended.endAt);
});
test('another exam, replaced session and invalid timing cannot change the current countdown', () => {
  for (const timing of [null, { examId: 'another' }, { updatedAt: 'bad' }, { endAt: '2026-11-19T11:00:00Z' }, { latestStartAt: '2026-11-19T13:00:00Z' }, { durationMinutes: 0 }]) {
    const h = harness(); assert.equal(h.context.acceptExamTiming(timing && { ...h.timing, ...timing }, 'session'), false); assert.equal(h.state.exam, h.exam);
  }
  const h = harness(); assert.equal(h.context.acceptExamTiming(h.timing, 'replaced-session'), false); assert.equal(h.state.exam, h.exam);
});
