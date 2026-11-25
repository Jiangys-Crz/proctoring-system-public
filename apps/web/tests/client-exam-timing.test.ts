import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientExamTiming } from '../src/lib/client-exam-timing';
test('heartbeat timing carries the latest delay and extension without session or credential data', () => {
  const exam = { id: 'exam', updatedAt: new Date('2026-11-19T10:54:43Z'), startAt: new Date('2026-11-19T11:10:00Z'), latestStartAt: new Date('2026-11-19T11:25:00Z'), endAt: new Date('2026-11-19T12:40:00Z'), durationMinutes: 90, contestRule: 'KS' as const, flexible: false };
  assert.deepEqual(clientExamTiming(exam), { examId: 'exam', updatedAt: exam.updatedAt.toISOString(), startAt: exam.startAt.toISOString(), latestStartAt: exam.latestStartAt.toISOString(), endAt: exam.endAt.toISOString(), durationMinutes: 90, contestRule: 'KS', flexible: false });
  exam.endAt = new Date('2026-11-19T13:00:00Z'); exam.durationMinutes = 110;
  assert.equal(clientExamTiming(exam).endAt, '2026-11-19T13:00:00.000Z');
});
