import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { acknowledgeAlertInTransaction, refreshCandidateAlertStatus, claimCandidateStatusRecheck, withAlertStatusWrite } from '../src/lib/alert-acknowledgement';

function fixture() {
  const now = new Date('2026-10-15T10:00:00Z');
  const candidate = { status: 'ONLINE_ABNORMAL', abnormal: true, startedAt: now, examId: 'exam',
    exam: { requireMiniProgram: false }, rooms: [] as { room: { examId: string; requireSecondCamera: boolean } }[] };
  const session = { status: 'IN_EXAM', lockdown: false, revokedAt: null as Date | null, approvedAt: now, startedAt: now,
    lastDesktopSeenAt: now, lastMiniProgramSeenAt: now, desktopOfflineAt: null as Date | null, miniProgramOfflineAt: null as Date | null };
  const counts = { remaining: 0, cheating: 0 };
  const events: string[] = [];
  const tx = {
    $queryRaw: async (sql: TemplateStringsArray) => { events.push(sql.join('?').includes('ClientSession') ? 'lock-sessions' : 'lock-candidate'); return []; },
    alert: { update: async () => { events.push('ack'); return { id: 'alert', acknowledgedAt: now }; }, count: async () => counts.remaining },
    cheatingRecord: { count: async () => counts.cheating },
    candidate: { findUniqueOrThrow: async () => candidate, update: async ({ data }: { data: object }) => { events.push('candidate'); Object.assign(candidate, data); return candidate; } },
    clientSession: { findMany: async () => [session] }
  } as unknown as Prisma.TransactionClient;
  return { now, candidate, session, counts, events, refresh: () => refreshCandidateAlertStatus(tx, 'candidate', now), ack: () => acknowledgeAlertInTransaction(tx, { id: 'alert', candidateId: 'candidate' }, now) };
}

test('handling the last alert restores the appropriate online state while retaining session state', async () => {
  for (const [sessionStatus, started, expected] of [['IN_EXAM', true, 'ONLINE_NORMAL'], ['APPROVED', false, 'APPROVED'], ['WAITING_REVIEW', false, 'REQUESTING']] as const) {
    const h = fixture(); h.session.status = sessionStatus;
    if (!started) { h.candidate.startedAt = null as never; h.session.startedAt = null as never; }
    await h.ack();
    assert.equal(h.candidate.abnormal, false);
    assert.equal(h.candidate.status, expected);
    assert.equal(h.session.status, sessionStatus);
    assert.deepEqual(h.events, ['lock-sessions', 'lock-candidate', 'ack', 'candidate']);
  }
});

test('outstanding alerts, cheating, USB locks and actual offline sessions cannot be cleared by acknowledgement', async () => {
  for (const reason of ['remaining', 'cheating', 'lock', 'offline', 'stale-desktop', 'stale-mobile', 'revoked']) {
    const h = fixture();
    if (reason === 'remaining') h.counts.remaining = 1;
    if (reason === 'cheating') h.counts.cheating = 1;
    if (reason === 'lock') { h.session.lockdown = true; h.session.status = 'LOCKED'; }
    if (reason === 'offline') h.session.desktopOfflineAt = new Date(+h.now - 30_000);
    if (reason === 'stale-desktop') h.session.lastDesktopSeenAt = new Date(+h.now - 30_000);
    if (reason === 'stale-mobile') { h.candidate.exam.requireMiniProgram = true; h.session.lastMiniProgramSeenAt = new Date(+h.now - 30_000); }
    if (reason === 'revoked') { h.candidate.status = 'OFFLINE'; h.session.revokedAt = h.now; h.session.status = 'FINISHED'; }
    await h.ack();
    assert.equal(h.candidate.abnormal, true, reason);
    assert.equal(h.candidate.status, ['offline', 'stale-desktop', 'revoked'].includes(reason) ? 'OFFLINE' : 'ONLINE_ABNORMAL', reason);
    if (reason === 'lock') assert.equal(h.session.lockdown, true);
  }
});

test('acknowledging historical alerts never resumes a finished candidate and uses the actual room camera requirement', async () => {
  const done = fixture(); done.candidate.status = 'FINISHED'; done.session.status = 'FINISHED';
  await done.ack();
  assert.equal(done.candidate.abnormal, false);
  assert.equal(done.candidate.status, 'FINISHED');
  const room = fixture(); room.candidate.exam.requireMiniProgram = true;
  room.candidate.rooms = [{ room: { examId: 'exam', requireSecondCamera: false } }];
  room.session.lastMiniProgramSeenAt = new Date(+room.now - 30_000);
  await room.ack();
  assert.equal(room.candidate.abnormal, false);
  assert.equal(room.candidate.status, 'ONLINE_NORMAL');
});


test('handled offline/locked incidents return to normal only after the actual safety condition recovers', async () => {
  for (const issue of ['offline', 'lock', 'mobile']) {
    const h = fixture();
    if (issue === 'offline') { h.session.status = 'OFFLINE'; h.session.desktopOfflineAt = h.now; }
    if (issue === 'lock') { h.session.status = 'LOCKED'; h.session.lockdown = true; }
    if (issue === 'mobile') { h.candidate.exam.requireMiniProgram = true; h.session.miniProgramOfflineAt = h.now; }
    await h.ack();
    assert.equal(h.candidate.abnormal, true, issue);
    h.session.status = 'IN_EXAM'; h.session.lockdown = false;
    h.session.desktopOfflineAt = null; h.session.miniProgramOfflineAt = null;
    await h.refresh();
    assert.equal(h.candidate.abnormal, false, issue);
    assert.equal(h.candidate.status, 'ONLINE_NORMAL', issue);
  }
});

test('historical status repair is limited per session and its shared cache has bounded capacity', () => {
  const now = new Date();
  assert.equal(claimCandidateStatusRecheck('repair-session', now), true);
  assert.equal(claimCandidateStatusRecheck('repair-session', new Date(+now + 29_999)), false);
  assert.equal(claimCandidateStatusRecheck('repair-session', new Date(+now + 30_000)), true);
  for (let i = 0; i < 10_020; i++) claimCandidateStatusRecheck(`repair-capacity-${i}`, now);
  const state = globalThis as typeof globalThis & { candidateStatusRechecks: Map<string, number> };
  assert.equal(state.candidateStatusRechecks.size, 10_000);
});


test('candidate alert-state transactions retry rolled-back deadlocks only and keep their timeout bounds', async () => {
  const original = prisma.$transaction;
  let attempts = 0;
  try {
    prisma.$transaction = (async (_operation: unknown, options: unknown) => {
      assert.deepEqual(options, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 });
      attempts++;
      if (attempts < 3) throw { code: 'P2034' };
      return 'completed';
    }) as typeof original;
    assert.equal(await withAlertStatusWrite(async () => 'unused'), 'completed');
    assert.equal(attempts, 3);
    attempts = 0;
    prisma.$transaction = (async () => { attempts++; throw { code: 'P2034' }; }) as typeof original;
    await assert.rejects(withAlertStatusWrite(async () => 'unused'), error => (error as { code: string }).code === 'P2034');
    assert.equal(attempts, 3);
    attempts = 0;
    prisma.$transaction = (async () => { attempts++; throw new Error('unrelated'); }) as typeof original;
    await assert.rejects(withAlertStatusWrite(async () => 'unused'), /unrelated/);
    assert.equal(attempts, 1);
  } finally { prisma.$transaction = original; }
});
