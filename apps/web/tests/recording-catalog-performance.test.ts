import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/app/api/recordings/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function fixture(role = 'ADMIN') {
  const user = { id: 'current-user', role };
  const candidates = [
    { id: 'in-room', name: 'Room candidate', teamName: null, examNumber: '001', seatNo: '01' },
    { id: 'unassigned', name: 'Unassigned candidate', teamName: 'Team', examNumber: '002', seatNo: '' },
    { id: 'without-alerts', name: 'No incidents', teamName: null, examNumber: '003', seatNo: '02' }
  ];
  const exams = Array.from({ length: 40 }, (_, index) => ({
    id: `exam-${index}`, name: `Exam ${index}`, startAt: new Date(0),
    endAt: new Date(index === 3 ? Date.now() + 60_000 : 1),
    createdById: index === 0 || index === 3 ? user.id : 'another-admin',
    administrators: index === 1 ? [{ userId: user.id }] : [],
    candidates, rooms: [{ id: `room-${index}`, name: 'Room', candidates: [{ candidateId: 'in-room' }, { candidateId: 'without-alerts' }, { candidateId: 'out-of-scope' }] }]
  }));
  let queryCount = 0;
  let examQuery: any;
  const aggregateQueries: any[] = [];
  const db = {
    exam: { findMany: async (query: any) => { queryCount++; examQuery = query; return exams; } },
    alert: { groupBy: async () => { queryCount++; return [
      { candidateId: 'in-room', _count: { _all: 2 } }, { candidateId: 'unassigned', _count: { _all: 1 } }
    ]; } },
    mediaSegment: { groupBy: async (query: any) => { queryCount++; aggregateQueries.push(query); return [{ examId: 'exam-1', _count: { _all: 7 }, _sum: { byteSize: 1234 } }]; } },
    fileDeletionJob: { groupBy: async (query: any) => { queryCount++; aggregateQueries.push(query); return [{ examId: 'exam-2', _count: { _all: query.where.lastError ? 1 : 3 } }]; } }
  };
  class AuthError extends Error {}
  const mocks: Record<string, unknown> = {
    '@/lib/db': { prisma: db }, '@/lib/auth': { AuthError, requireUser: async () => user },
    '@/lib/permissions': { canManageExam: () => assert.fail('per-exam permission queries must not run'), canAccessCandidate: () => true },
    '@/lib/public-test': { publicTestExamId: async () => 'environment-test' },
    '@/lib/http': { ok: (data: unknown) => Response.json({ data }), fail: (message: string, status: number) => Response.json({ message }, { status }), toErrorMessage: String },
    '@/lib/recording-deletion': { RECORDING_CHANNELS: ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA', 'EVIDENCE_CLIP'] },
    '@/lib/desktop-releases': {}, '@/lib/upload-security': { UploadSecurityError: class extends Error {} },
    '@/lib/storage': {}, '@/lib/alert-evidence': {}
  };
  const exports: any = {};
  new Function('require', 'exports', code)((name: string) => {
    assert.ok(name in mocks, `Unexpected import ${name}`);
    return mocks[name];
  }, exports);
  return { get: exports.GET, queries: () => ({ count: queryCount, exams: examQuery, aggregates: aggregateQueries }) };
}

test('recording catalog keeps room scope, unassigned candidates and management permissions with a fixed query count', async () => {
  const f = fixture();
  const response = await f.get(new Request('http://localhost/api/recordings'));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.length, 40);
  assert.deepEqual(data.slice(0, 4).map((exam: any) => exam.canDelete), [true, true, false, false]);
  assert.equal(data[1].mediaCount, 7);
  assert.equal(data[1].bytes, 1234);
  assert.equal(data[2].cleanupPending, 3);
  assert.equal(data[2].cleanupFailed, 1);
  assert.equal(data[0].recordingCount, 3);
  assert.deepEqual(data[0].rooms.map((room: any) => [room.id, room.candidates.map((candidate: any) => candidate.id)]), [
    ['room-0', ['in-room']], ['__unassigned', ['unassigned']]
  ]);
  const queries = f.queries();
  assert.equal(queries.count, 5, '40 exams require five batched reads, not 40 additional management checks');
  assert.deepEqual(queries.exams.select.administrators.where, { userId: 'current-user' });
  const candidateScope = queries.exams.select.candidates.where;
  assert.deepEqual(candidateScope.OR[2].rooms.some.room.proctors.some, { userId: 'current-user' });
  assert.deepEqual(queries.exams.select.rooms.select.candidates.where.candidate, candidateScope);
  assert.deepEqual(queries.aggregates[0].where.candidate, candidateScope);
  assert.deepEqual(queries.exams.select.rooms.select.candidates.select, { candidateId: true }, 'reuse candidate identities without loading them once per room');
  assert.equal(queries.exams.select.candidates.select.password, undefined);
});

test('super administrators may delete ended exams while active exams remain protected', async () => {
  const f = fixture('SUPER_ADMIN');
  const response = await f.get(new Request('http://localhost/api/recordings'));
  const { data } = await response.json();
  assert.deepEqual(data.slice(0, 4).map((exam: any) => exam.canDelete), [true, true, true, false]);
  assert.deepEqual(f.queries().exams.select.candidates.where, {});
  assert.equal(f.queries().count, 5);
});
