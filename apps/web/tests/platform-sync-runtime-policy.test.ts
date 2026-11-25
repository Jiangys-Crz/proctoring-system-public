import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as policy from '../src/lib/platform-sync-policy';

function load(file: string, dependencies: Record<string, unknown>) {
  const module = { exports: {} as any };
  const unavailable = new Proxy({}, { get: (_target, key) => { throw new Error(`Unexpected dependency access: ${String(key)}`); } });
  const source = readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), 'utf8');
  const code = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  runInNewContext(code, { module, exports: module.exports, Buffer, process, setTimeout, clearTimeout,
    require: (id: string) => id === './platform-sync-policy' ? policy : dependencies[id] ?? unavailable });
  return module.exports;
}

test('only login requests and identity photos are local; sessions and other exam data remain eligible', () => {
  assert.deepEqual([...policy.LOCAL_PLATFORM_KINDS], ['LOGIN', 'PHOTO']);
  for (const kind of ['LOGIN', 'PHOTO']) assert.equal(policy.isSynchronizedPlatformKind(kind), false);
  for (const kind of ['SESSION', 'EXAM', 'CANDIDATE', 'PROBLEM', 'ROOM', 'ALERT', 'RECEIPT', 'MESSAGE_RECEIPT', 'SCREEN_IMAGE', 'CODE_JOB']) {
    assert.equal(policy.isSynchronizedPlatformKind(kind), true, kind);
  }
});

test('old peer login/photo items are ignored before any database or media access', async () => {
  const exams = load('platform-sync-exams', {}), extras = load('platform-sync-extras', {});
  for (const kind of ['LOGIN', 'PHOTO']) {
    await exams.mergeExamItem({ kind }, {});
    await extras.mergeExtraItem({ kind }, {});
  }
});

test('journal pages exclude old login/photo snapshots and still advance through a private-only tail', async () => {
  let records = [{ id: 'private-login', kind: 'LOGIN', sequence: 1n }, { id: 'private-photo', kind: 'PHOTO', sequence: 2n },
    { id: 'session', kind: 'SESSION', sequence: 3n }];
  const tx = { platformSyncState: { findUnique: async () => ({ sequence: 5n }) }, platformSyncItem: {
    findMany: async ({ where }: any) => {
      assert.deepEqual(Array.from(where.kind.notIn), ['LOGIN', 'PHOTO']);
      return records.filter(row => !where.kind.notIn.includes(row.kind));
    }, findUniqueOrThrow: async ({ where }: any) => records.find(row => row.id === where.id)
  } };
  const store = load('platform-sync-store', { './db': { prisma: { $transaction: (work: any) => work(tx) } },
    './platform-sync-protocol': { PlatformItemSchema: { parse: ({ sequence: _sequence, ...value }: any) => value } } });
  const page = await store.readPlatformPage(0n);
  assert.deepEqual(Array.from(page.entries, (row: any) => row.id), ['session']);
  assert.equal(page.after, '5');
  records = records.slice(0, 2);
  const tail = await store.readPlatformPage(3n);
  assert.equal(tail.entries.length, 0);
  assert.equal(tail.after, '5');
});

test('retiring queued login/photos keeps the session queued for ordinary processing', async () => {
  const rows = new Map(['LOGIN', 'PHOTO', 'SESSION'].map(kind => [kind, { id: kind, snapshot: { id: kind, kind } }]));
  const applied: string[] = [];
  const inbox = {
    deleteMany: async ({ where }: any) => {
      if (where.OR) for (const filter of where.OR) rows.delete(filter.snapshot.equals);
      else rows.delete(where.id);
    },
    findUnique: async ({ where }: any) => rows.get(where.id),
    updateMany: async () => { assert.fail('session must not wait on a retired login/photo dependency'); }
  };
  const sync = load('platform-sync', {
    './db': { prisma: { platformSyncInbox: inbox, $queryRaw: async () => [...rows.values()].map(row => ({ id: row.id, kind: row.id })) } },
    './platform-sync-lock': { platformTransaction: (work: any) => work({ platformSyncInbox: inbox }) },
    './platform-sync-protocol': { PlatformItemSchema: { parse: (value: any) => value } },
    './platform-sync-extras': { EXTRA_KINDS: new Set(['SESSION']), mergeExtraItem: async (value: any) => applied.push(value.kind) }
  });
  await sync.drainPlatformInbox({});
  assert.deepEqual(applied, ['SESSION']);
  assert.equal(rows.size, 0);
});

test('session history ignores a legacy remote loginKey and preserves an existing local approval link', async () => {
  for (const existing of [false, true]) {
    let saved: any;
    const candidate = { id: 'local-candidate', syncKey: 'candidate:source' };
    const exam = { id: 'local-exam', examCode: '2026111801', federation: { enabled: true, managedGlobally: true } };
    const tx = {
      $queryRaw: async () => [],
      exam: { findUniqueOrThrow: async () => exam },
      examFederation: { findUnique: async () => exam.federation },
      platformSyncItem: { findUnique: async () => null },
      candidate: { findMany: async () => [candidate], findFirst: async () => candidate },
      examProblem: { findMany: async () => [] },
      systemSetting: { findMany: async () => [] },
      clientSession: {
        findMany: async () => [],
        findUnique: async () => existing ? { examId: exam.id, candidateId: candidate.id, loginRequestId: 'local-approval' } : null,
        create: async ({ data }: any) => { saved = data; }, update: async ({ data }: any) => { saved = data; }
      }
    };
    const extras = load('platform-sync-extras', {
      '@prisma/client': { Prisma: { sql: () => ({}), raw: (value: any) => value } },
      './platform-sync-code-report': { boundedCodeReportIds: () => [] },
      './db': { prisma: { exam: { findUnique: async () => exam }, platformSyncItem: { findUnique: async () => null } } },
      './exam-federation-protocol': { digest: () => 'digest' },
      './exam-federation-store': { federationTransaction: (_id: string, work: any) => work(tx) },
      './platform-sync-store': { itemHash: () => 'valid', jsonValue: (value: any) => value,
        acceptItem: async (_tx: any, _value: any, apply: any) => apply(null), captureDeletions: async () => {} }
    });
    await extras.mergeExtraItem({ kind: 'SESSION', id: 'session:source', scope: exam.examCode, hash: 'valid', revision: 1,
      payload: { candidateKey: candidate.syncKey, loginKey: 'login:retired', status: 'FINISHED' } }, {});
    assert.equal(saved.candidateId, candidate.id);
    assert.equal(Object.hasOwn(saved, 'loginRequestId'), false, 'do not overwrite the local approval or wait for the remote one');
    if (!existing) assert.equal(saved.syncImported, true);
  }
});

test('rolling upgrades preserve an opaque legacy session link without capturing login requests or photos', async () => {
  const captured: any[] = [];
  const empty = { findMany: async () => [] };
  const tx = {
    exam: { findUniqueOrThrow: async () => ({ examCode: '2026111801', federation: { enabled: true, managedGlobally: true } }) },
    clientSession: { findMany: async () => [{ id: 'source-session', candidateId: 'candidate', loginRequestId: null, status: 'FINISHED' }] },
    screenControlGroup: empty, screenControlImage: empty, screenControlDisplay: empty, codeCheckJob: empty,
    candidate: { findMany: async () => [{ id: 'candidate', syncKey: 'candidate:source' }] }, examProblem: empty, systemSetting: empty,
    platformSyncItem: { findMany: async ({ where }: any) => {
      assert.equal(where.kind, 'SESSION');
      return [{ localId: 'source-session', payload: { loginKey: 'login:original-owner' }, appliedHash: null, deleted: false }];
    } }
  };
  const extras = load('platform-sync-extras', {
    './platform-sync-code-report': { boundedCodeReportIds: () => [], changedCodeReportIds: async () => [], captureCodeReportDeletions: async () => {} },
    './exam-federation-protocol': { digest: () => 'digest' },
    './platform-sync-store': { itemHash: () => 'current-payload', jsonValue: (value: any) => JSON.parse(JSON.stringify(value)), captureDeletions: async () => {},
      captureItem: async (_tx: any, _node: any, _scope: any, kind: string, _id: any, payload: any) => captured.push({ kind, payload }) }
  });
  await extras.captureExtrasInTransaction(tx, 'exam', { nodeId: 'node' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].kind, 'SESSION');
  assert.equal(captured[0].payload.loginKey, 'login:original-owner');
  assert.equal(captured[0].payload.candidateKey, 'candidate:source');
});
