import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problemFullScore } from '../src/lib/problem-score';
import { calculateLeaderboards } from '../src/lib/leaderboards';
import { saveExam } from '../src/lib/exam-save';
import { prisma } from '../src/lib/db';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';

test('Hydro subtask totals override generic 100-point problem metadata', () => {
  for (const full of [25, 50, 75, 100, 200]) {
    assert.equal(problemFullScore({ score: 100, config: { type: 'default', subtasks: [{ score: full, type: 'sum', cases: [{}, {}] }] } }), full);
  }
  assert.equal(problemFullScore({ score: 100, config: { subtasks: [{ score: 20 }, { score: '30' }, { score: 0 }] } }), 50);
  assert.equal(problemFullScore({ score: 100, config: { subtasks: [{ score: 20 }, {}] } }), 100);
  assert.equal(problemFullScore({ score: 100, config: { score: 25 } }), 25);
  assert.equal(problemFullScore({ score: 200 }), 200);
  assert.equal(problemFullScore({ score: 'invalid' }), null);
});

test('objective full scores still use answer weights before generic metadata', () => {
  assert.equal(problemFullScore({ score: 100, config: { type: 'objective', answers: { a: ['A', 5], b: { B: 3, C: 2 } } } }), 8);
});

test('real four-problem KS scores normalize 25/50/75/100 into exam maxima 20/20/25/35', () => {
  const startAt = new Date('2026-11-01T07:10:00Z'), endAt = new Date('2026-11-01T08:40:00Z');
  const full = [25, 50, 75, 100], maxima = [20, 20, 25, 35], points = [25, 50, 68, 80];
  const problems = full.map((hydroScore, i) => ({ id: String(i), hydroScore, scorePercent: maxima[i], score: maxima[i] }));
  const records = points.map((score, i) => ({ id: String(i), candidateId: 'u', problemId: String(i), score, status: 2, createdAt: new Date(+startAt + 1000) }));
  const result = calculateLeaderboards({ startAt, endAt, latestStartAt: startAt, durationMinutes: 90, contestRule: 'KS', contestType: 'INDIVIDUAL' },
    problems, [{ id: 'u', examNumber: '1', name: null, teamName: null }], records, endAt, true);
  assert.deepEqual(result.rows[0].problemScores, [20, 20, 22.67, 28]);
  assert.equal(result.rows[0].score, 90.67);
  assert.deepEqual(records.map(record => record.score), points, 'raw Hydro scores must remain unchanged');
});

test('exam imports recover the real full score from old bridge metadata and default to normalized 100 points', async t => {
  const replace = (target: any, key: string, implementation: any) => {
    const previous = target[key]; target[key] = implementation; t.after(() => { target[key] = previous; });
  };
  replace(prisma.systemSetting, 'findUnique', async () => ({ value: { baseUrl: 'https://judge.example.org', apiKey: 'test', problemDomainId: 'Problems' } }));
  replace(prisma.examProblem, 'findMany', async () => []);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, data: { id: '9', title: 'A', score: 100, config: { type: 'default', subtasks: [{ score: 25 }] } } }));
  const writes: any[] = [];
  replace(prisma, '$transaction', async (operation: any) => operation({
    exam: { update: async () => ({ id: 'e' }) },
    examProblem: { deleteMany: async () => ({}), create: async ({ data }: any) => { writes.push(data); return data; } },
  }));
  const input = CreateExamSchema.parse({ name: 'Import', startAt: '2026-11-01T07:10:00Z', latestStartAt: '2026-11-01T07:10:00Z',
    endAt: '2026-11-01T08:40:00Z', durationMinutes: 90, platform: 'HYDRO', contestType: 'INDIVIDUAL', contestRule: 'KS', problemIds: ['9'] });
  await saveExam(input, 'admin', 'e');
  assert.equal(writes[0].hydroScore, 25);
  assert.equal(writes[0].scorePercent, 100);
  assert.equal(writes[0].score, 100);
});
