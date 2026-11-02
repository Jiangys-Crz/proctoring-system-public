import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDependency = createRequire(resolve(web, 'package.json'));
function loader(mocks: Record<string, unknown>) {
  const modules = new Map<string, any>();
  function load(file: string): any {
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} as any }; modules.set(file, module.exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', code)((name: string) => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('@/')) return load(resolve(web, 'src', `${name.slice(2)}.ts`));
      if (name.startsWith('.')) return load(resolve(dirname(file), `${name}.ts`));
      if (name === '@cwnupaa/proctor-shared') return load(resolve(web, '../../packages/shared/src/index.ts'));
      return requireDependency(name);
    }, module, module.exports);
    modules.set(file, module.exports); return module.exports;
  }
  return (route: string) => load(resolve(web, 'src', route));
}
function fixture(manager = false) {
  const user = { id: 'proctor-a', role: 'ADMIN', status: 'ACTIVE' };
  const queries: any = {};
  let writes = 0;
  const candidate = { id: 'candidate-a', examId: 'exam', password: 'synthetic-password', name: 'A', teamName: 'team' };
  const db: any = {
    systemSetting: { findUnique: async () => null },
    exam: {
      findFirst: async () => manager ? { id: 'exam' } : null,
      findMany: async (q: any) => { queries.exams = q; return [{ id: 'exam', createdById: 'other-admin', administrators: [], _count: { candidates: 1 } }]; },
      findUnique: async (q: any) => { queries.exam = q; return { id: 'exam', endAt: new Date(Date.now() + 60_000), problems: [], candidates: [], rooms: [
        { id: 'room-a', proctors: [{ user: { id: user.id, passwordHash: 'synthetic-admin-hash' } }], candidates: [{ candidate }] },
      ], _count: { candidates: 1, submissions: 1 } }; },
    },
    candidate: { findUnique: async (q: any) => q.include ? { ...candidate, exam: { startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 60_000) } } : ({ examId: 'exam' }),
      findMany: async (q: any) => q.where?.teamName ? [candidate, { ...candidate, id: 'candidate-b' }] : [candidate] },
    clientSession: {
      findUnique: async ({ where }: any) => ({ id: where.id, examId: 'exam', candidateId: where.id === 'session-b' ? 'candidate-b' : 'candidate-a' }),
      findFirst: async ({ where }: any) => where.id === 'session-b' ? null : { id: where.id, candidateId: 'candidate-a', examId: 'exam' },
    },
    alert: { findUnique: async () => ({ id: 'global-alert', examId: 'exam', candidateId: null }) },
    $transaction: async () => { writes++; assert.fail('unauthorized request must never open a write transaction'); },
    examRoomProctor: { count: async () => 1 },
    examRoomCandidate: { count: async ({ where }: any) => where.candidateId === 'candidate-a' ? 1 : 0 },
    printJob: {
      findMany: async (q: any) => { queries.print = q; return []; },
      findFirst: async ({ where }: any) => ({ id: where.id, examId: 'exam', candidateId: where.id === 'job-b' ? 'candidate-b' : 'candidate-a', content: 'code', title: 'print', createdAt: new Date() }),
      updateMany: async (q: any) => { queries.printUpdate = q; writes++; return { count: 1 }; },
    },
    contestSubmission: { findMany: async (q: any) => { queries.submissions = q; return []; } },
    examQuestion: { findMany: async () => [] },
    examAnnouncement: { findMany: async (q: any) => { queries.announcements = q; return []; }, create: async () => { writes++; return { id: 'announcement' }; } },
  };
  class AuthError extends Error { status = 401; }
  const load = loader({ '@/lib/db': { prisma: db }, './db': { prisma: db }, '@/lib/auth': { requireUser: async () => user, AuthError },
    '@/lib/session-health': { finalizeEndedExam: async () => {}, markStaleSessionsOffline: async () => {} },
    '@/lib/leaderboards': { calculateLeaderboards: () => ({}) },
    '@/lib/storage': { publicObjectUrl: async (path: string) => path, storeBuffer: async () => { writes++; assert.fail('unauthorized audio must never be stored'); } },
  });
  return { load, queries, writes: () => writes };
}
const context = { params: Promise.resolve({ id: 'exam' }) };
const request = (body?: object) => new Request('http://localhost:4031/api/test', body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});

test('exam details scope proctor rooms and redact nested credentials', async () => {
  const f = fixture(); const route = f.load('app/api/exams/[id]/route.ts');
  const response = await route.GET(request(), context); assert.equal(response.status, 200);
  assert.deepEqual(f.queries.exam.include.rooms.where, { proctors: { some: { userId: 'proctor-a' } } });
  const body = await response.json();
  assert.equal(body.data.rooms[0].proctors[0].user.passwordHash, undefined);
  assert.equal(body.data.rooms[0].candidates[0].candidate.password, undefined);
});

test('candidate credentials are obtainable only through managed candidate endpoint', async () => {
  const denied = fixture(); assert.equal((await denied.load('app/api/exams/[id]/candidates/route.ts').GET(request(), context)).status, 403);
  const allowed = fixture(true); const response = await allowed.load('app/api/exams/[id]/candidates/route.ts').GET(request(), context);
  assert.equal(response.status, 200); assert.equal((await response.json()).data[0].password, 'synthetic-password');
});

test('print list and mutation enforce room ownership; unauthorized task never writes or renders', async () => {
  const f = fixture(); const route = f.load('app/api/exams/[id]/print-jobs/route.ts');
  assert.equal((await route.GET(request(), context)).status, 200);
  assert.deepEqual(f.queries.print.where.candidate.rooms.some.room.proctors.some, { userId: 'proctor-a' });
  assert.equal((await route.PATCH(request({ id: 'job-b', action: 'REJECTED', reason: 'test' }), context)).status, 403);
  assert.equal(f.writes(), 0);
  const document = f.load('app/api/exams/[id]/print-jobs/[jobId]/document/route.ts');
  assert.equal((await document.GET(request(), { params: Promise.resolve({ id: 'exam', jobId: 'job-b' }) })).status, 403);
  assert.equal((await route.PATCH(request({ id: 'job-a', action: 'PRINTED' }), context)).status, 200);
  assert.deepEqual(f.queries.printUpdate.where.candidate.rooms.some.room.proctors.some, { userId: 'proctor-a' });
});

test('overview identities, submissions and counts use identical proctor room scope', async () => {
  const f = fixture(); const response = await f.load('app/api/exams/[id]/overview/route.ts').GET(request(), context);
  assert.equal(response.status, 200);
  const scope = { rooms: { some: { room: { proctors: { some: { userId: 'proctor-a' } } } } } };
  assert.deepEqual(f.queries.exam.include.candidates.where, scope);
  assert.deepEqual(f.queries.exam.include._count.select.candidates.where, scope);
  assert.deepEqual(f.queries.exam.include._count.select.submissions.where.candidate, scope);
  assert.deepEqual(f.queries.submissions.where.candidate, scope);
});

test('room proctors cannot broadcast globally or see other-room targeted announcements', async () => {
  const f = fixture(); const route = f.load('app/api/exams/[id]/qa/route.ts');
  assert.equal((await route.GET(request(), context)).status, 200);
  assert.ok(f.queries.announcements.where.OR.some((scope: any) => scope.candidateId === null));
  assert.deepEqual(f.queries.announcements.where.OR[1].candidate.rooms.some.room.proctors.some, { userId: 'proctor-a' });
  assert.equal((await route.POST(request({ action: 'announce', content: 'broadcast' }), context)).status, 403);
  assert.equal(f.writes(), 0);
  const managed = fixture(true); assert.equal((await managed.load('app/api/exams/[id]/qa/route.ts').POST(request({ action: 'announce', content: 'broadcast' }), context)).status, 201);
});

test('exam list aggregate counts obey candidate room scope for ordinary proctors', async () => {
  const f = fixture(); const response = await f.load('app/api/exams/route.ts').GET();
  assert.equal(response.status, 200);
  const candidateScope = f.queries.exams.include._count.select.candidates.where;
  assert.deepEqual(candidateScope.OR[2].rooms.some.room.proctors.some, { userId: 'proctor-a' });
  assert.deepEqual(f.queries.exams.include._count.select.loginRequests.where.candidate, candidateScope);
  assert.deepEqual(f.queries.exams.include._count.select.alerts.where.candidate, candidateScope);
});

test('team-wide marking and exam-wide alert acknowledgement cannot cross proctor room scope', async () => {
  const f = fixture();
  const cheating = f.load('app/api/candidates/[id]/cheating/route.ts');
  assert.equal((await cheating.POST(request({ reason: 'test reason', teamWide: true }), { params: Promise.resolve({ id: 'candidate-a' }) })).status, 403);
  const ack = f.load('app/api/alerts/[id]/ack/route.ts');
  assert.equal((await ack.POST(request(), { params: Promise.resolve({ id: 'global-alert' }) })).status, 403);
  assert.equal(f.writes(), 0);
});

test('warning and voice reject a session belonging to another candidate before any write', async () => {
  const f = fixture();
  const warning = f.load('app/api/alerts/warning/route.ts');
  assert.equal((await warning.POST(request({ candidateId: 'candidate-a', sessionId: 'session-b' }))).status, 403);
  const voice = f.load('app/api/voice/route.ts');
  const form = new FormData(); form.set('candidateId', 'candidate-a'); form.set('sessionId', 'session-b');
  form.set('file', new File(['synthetic audio'], 'audio.webm', { type: 'audio/webm' }));
  assert.equal((await voice.POST(new Request('http://localhost:4031/api/voice', { method: 'POST', body: form }))).status, 403);
  assert.equal(f.writes(), 0);
});
