/**
 * Database-backed MODULE tests with explicitly constructed CCS inputs.
 * These do not claim to be real NovaJudge submissions, WHEP or video tests.
 * The separate reaction-e2e.ts exercises those real service boundaries.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/lib/db';
import { acceptReactionEvent } from '../src/lib/reaction-events';
import { maintainReactionCache } from '../src/lib/reaction-retention';
import { deleteStoredObject, storeBuffer, storedObjectExists } from '../src/lib/storage';
import type { CcsEvent } from '../src/lib/reaction-domain';
import { reactionStoredBytes, releaseReactionOutput, reserveReactionOutput } from '../src/lib/reaction-storage-budget';
import { updateReactionConfig } from '../src/lib/reaction-admin';
import { beginReactionRankingSnapshot, completeReactionRankingSnapshot, parseReactionRankContext } from '../src/lib/reaction-ranking';

const lines: string[] = [
  'Reaction database MODULE integration tests',
  'Inputs: constructed CCS events + marker files (NOT playable videos).',
  'This report does NOT certify real NovaJudge judging, WHEP or physical-client capture.',
  `Started: ${new Date().toISOString()}`,
];
const reportPath = path.resolve(process.env.REACTION_STATE_TEST_REPORT || '.local/reaction-e2e/state-tests.txt');
const fixtureId = randomUUID();
const keys: string[] = [];
const marker = Buffer.from('Reaction module fixture marker. This is deliberately NOT a video.\n');
let examId: string | undefined;
let failed = false;
function pass(name: string, evidence: string) { const line = `PASS | ${name} | ${evidence}`; lines.push(line); console.log(line); }

async function main() {
  const db = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname), 'Refusing non-loopback database');
  assert(/^\/reaction_e2e(?:_|$)/.test(db.pathname), 'Refusing database that is not dedicated reaction_e2e');
  const epoch = Math.floor(Date.now() / 1000) * 1000;
  const at = (seconds: number) => new Date(epoch + seconds * 1000);
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: `Reaction module fixture ${fixtureId}`,
    startAt: at(-3600), latestStartAt: at(3600), endAt: at(7200), durationMinutes: 180,
    platform: 'NOVAJUDGE', platformBaseUrl: 'http://127.0.0.1:3001', platformContestId: `module-${fixtureId}`,
    contestType: 'TEAM', teamAccountMode: 'TEAM_ACCOUNT', contestRule: 'ACM', rules: 'Database MODULE test only; no live media or contest.',
    saveFullRecording: false, saveIncidentRecording: false, reactionEnabled: true,
    reactionConfig: { create: { initializedAt: at(-300), bufferSeconds: 60, beforeSeconds: 3, afterSeconds: 10, maxPendingSeconds: 1800,
      leaseToken: fixtureId, leaseUntil: at(24 * 3600), feedStatus: 'STOPPED' } },
  }, include: { reactionConfig: true } });
  examId = exam.id;
  const candidate = await prisma.candidate.create({ data: { examId: exam.id, examNumber: `module-team-${fixtureId}`, name: 'Module Team', teamName: 'Same display name', password: randomBytes(24).toString('hex'), seatNo: 'module-only' } });
  const otherCandidate = await prisma.candidate.create({ data: { examId: exam.id, examNumber: `other-team-${fixtureId}`, name: 'Other Module Team', teamName: 'Same display name', password: randomBytes(24).toString('hex'), seatNo: 'module-other' } });
  const submit = (id: string, seconds: number, team = candidate.examNumber): CcsEvent => ({ type: 'submissions', op: 'create', data: { id, team_id: team, problem_id: 'p1', time: at(seconds).toISOString() } });
  const result = (id: string) => prisma.reaction.findUniqueOrThrow({ where: { examId_submissionId: { examId: exam.id, submissionId: id } } });
  async function addSegment(name: string, from: number, to: number, channel: 'DESKTOP_CAMERA' | 'DESKTOP_SCREEN' = 'DESKTOP_CAMERA', owner = candidate.id, cache = true) {
    const prefix = `reaction-state-fixtures/${fixtureId}`;
    keys.push(`${prefix}/${name}.txt`);
    const object = await storeBuffer(marker, { prefix, filename: `${name}.txt`, stableName: true, contentType: 'text/plain' });
    return prisma.mediaSegment.create({ data: { examId: exam.id, candidateId: owner, channel, objectPath: object.objectPath,
      startedAt: at(from), endedAt: at(to), durationSeconds: to - from, byteSize: marker.length, validatedAt: at(to),
      reactionCache: cache, clockOffsetMs: 0, clockUncertaintyMs: 5 } });
  }

  await acceptReactionEvent(exam, submit('history', -400), at(-299), true);
  await acceptReactionEvent(exam, submit('history', -400), at(-298));
  await acceptReactionEvent(exam, submit('unseen-old-after-reconnect', -350), at(-298));
  assert.equal(await prisma.reaction.count({ where: { examId: exam.id } }), 0);
  pass('Historical initialization/reconnect', 'Snapshot and unseen old submission created zero recordings');
  // The worker persists the snapshot request's start as initializedAt before
  // consuming it. A submission arriving during that HTTP snapshot is live,
  // even if the snapshot contains it before the streaming connection starts.
  await acceptReactionEvent(exam, submit('cutover-old', -301), at(-298));
  assert.equal(await prisma.reaction.count({ where: { examId: exam.id } }), 0);
  const duringSnapshot = submit('cutover-new', -299);
  await acceptReactionEvent(exam, duringSnapshot, at(-298));
  const cutover = await result('cutover-new');
  assert.equal(cutover.status, 'PENDING');
  assert.equal(+cutover.sourceSubmittedAt, +at(-299));
  await acceptReactionEvent(exam, duringSnapshot, at(-295));
  await acceptReactionEvent(exam, { ...duringSnapshot, op: 'update' }, at(-294));
  assert.equal(await prisma.reaction.count({ where: { examId: exam.id, submissionId: 'cutover-new' } }), 1);
  assert.equal(await prisma.reaction.count({ where: { examId: exam.id, submissionId: 'cutover-old' } }), 0);
  pass('Snapshot/live cutover race', 'Before baseline ignored; submission during snapshot captured once; live create/update replay deduplicated');
  await prisma.reaction.delete({ where: { id: cutover.id } });
  await acceptReactionEvent(exam, { type: 'problems', op: 'create', data: { id: 'p1', label: 'A' } }, at(-299), true);

  const camera = await addSegment('pinned-camera', -124, -110);
  const desktop = await addSegment('pinned-desktop', -124, -110, 'DESKTOP_SCREEN');
  const ordinary = await addSegment('ordinary-expired-cache', -400, -390);
  const existingFull = await addSegment('existing-full-recording', -500, -490, 'DESKTOP_CAMERA', candidate.id, false);
  const wrongTeam = await addSegment('other-team-same-name', -124, -110, 'DESKTOP_CAMERA', otherCandidate.id);

  const firstEvent = submit('s1', -120);
  await acceptReactionEvent(exam, firstEvent, at(-119));
  await acceptReactionEvent(exam, firstEvent, at(-118));
  await acceptReactionEvent(exam, { ...firstEvent, op: 'update' }, at(-117));
  assert.equal(await prisma.reaction.count({ where: { examId: exam.id } }), 1);
  const first = await result('s1');
  assert.equal(first.problemLabel, 'A');
  assert.equal(first.candidateId, candidate.id);
  assert.equal(+first.windowStart, +at(-123));
  assert.equal(first.eventOffsetMs, 1000);
  assert.equal(await prisma.reactionSegment.count({ where: { reactionId: first.id, segmentId: wrongTeam.id } }), 0);
  pass('Duplicate create/update + exact username', 'One recording; cached problem A; same display name cannot cross team');

  await acceptReactionEvent(exam, { type: 'judgements', op: 'create', data: { id: 'j1', submission_id: 's1', judgement_type_id: null } }, at(-116));
  let state = await result('s1');
  assert.equal(state.status, 'PENDING'); assert.equal(state.windowEnd, null); assert.equal(state.judgementObservedAt, null);
  pass('Non-final judgement', 'PENDING with no cutoff or observed final judgement');

  await acceptReactionEvent(exam, submit('s2', -118), at(-117));
  const second = await result('s2');
  for (const segment of [camera, desktop]) {
    assert.equal(await prisma.reactionSegment.count({ where: { segmentId: segment.id, reactionId: { in: [first.id, second.id] } } }), 2);
  }
  assert.equal(await prisma.mediaSegment.count({ where: { id: { in: [camera.id, desktop.id] } } }), 2);
  pass('Concurrent submissions share source references', 'Two submissions each pin the same camera/desktop segments; no duplicate media rows');

  await maintainReactionCache(exam.id);
  assert.equal((await result('s1')).status, 'PENDING');
  for (const segment of [camera, desktop]) {
    assert.equal((await prisma.mediaSegment.findUniqueOrThrow({ where: { id: segment.id } })).deletedAt, null);
    assert.equal(await storedObjectExists(segment.objectPath, marker.length), true);
  }
  assert.ok((await prisma.mediaSegment.findUniqueOrThrow({ where: { id: ordinary.id } })).deletedAt);
  assert.equal(await storedObjectExists(ordinary.objectPath, marker.length), false);
  assert.equal((await prisma.mediaSegment.findUniqueOrThrow({ where: { id: existingFull.id } })).deletedAt, null);
  assert.equal(await storedObjectExists(existingFull.objectPath, marker.length), true);
  pass('60-second cleanup and pending protection', '120-second pending sources survive; unreferenced old cache physically removed; full recording preserved');

  const finalEvent: CcsEvent = { type: 'judgements', op: 'update', data: { id: 'j1', submission_id: 's1', judgement_type_id: 'AC', end_time: at(-115).toISOString() } };
  await acceptReactionEvent(exam, finalEvent, at(0));
  state = await result('s1');
  assert.equal(state.status, 'TAIL'); assert.equal(+state.judgementObservedAt!, +at(0));
  assert.equal(+state.sourceJudgementEndAt!, +at(-115)); assert.equal(+state.windowEnd!, +at(10));
  await acceptReactionEvent(exam, { ...finalEvent, op: 'create' }, at(5));
  assert.equal(+(await result('s1')).windowEnd!, +at(10));
  pass('Observed judgement + 10 seconds', 'Synthetic end_time retained only as metadata; replay does not extend window');

  // State-only finalization is explicit: no file is claimed or manufactured.
  await prisma.reaction.update({ where: { id: first.id }, data: { status: 'COMPLETE', finalizedAt: at(11) } });
  const rawBudget = await reactionStoredBytes(prisma, exam.id);
  const outputKey = `reaction-state-fixtures/${fixtureId}/output-marker.txt`;keys.push(outputKey);
  await storeBuffer(marker, { prefix: `reaction-state-fixtures/${fixtureId}`, filename: 'output-marker.txt', stableName: true, contentType: 'text/plain' });
  await prisma.reaction.update({ where: { id: first.id }, data: { metadataPath: outputKey, outputBytes: BigInt(marker.length) } });
  assert.equal(await reactionStoredBytes(prisma, exam.id), rawBudget + BigInt(marker.length));
  await reserveReactionOutput(first.id, 17n);
  const reservedTotal = await reactionStoredBytes(prisma, exam.id);
  assert.equal(reservedTotal, rawBudget + BigInt(marker.length) + 17n);
  await prisma.reactionConfig.update({ where: { examId: exam.id }, data: { maxStorageBytes: reservedTotal } });
  await assert.rejects(reserveReactionOutput(first.id, 1n), /REACTION_STORAGE_LIMIT/);
  assert.equal((await result('s1')).reservedBytes, 17n);
  await releaseReactionOutput(first.id, 18n);
  assert.equal((await result('s1')).reservedBytes, 17n);
  await releaseReactionOutput(first.id, 17n);
  assert.equal((await result('s1')).reservedBytes, 0n);
  await prisma.reactionConfig.update({ where: { examId: exam.id }, data: { maxStorageBytes: 21474836480n } });
  pass('Storage budget counts outputs and reservations', 'Raw + output + reserved totals exact; over-limit reservation rejected atomically; release cannot underflow');
  await acceptReactionEvent(exam, { type: 'judgements', op: 'update', data: { id: 'j2', submission_id: 's1', judgement_type_id: 'WA' } }, at(12));
  state = await result('s1');
  assert.equal(state.originalVerdict, 'AC'); assert.equal(state.verdict, 'WA'); assert.equal(state.status, 'COMPLETE');
  assert.equal(+state.windowEnd!, +at(10));
  assert(Array.isArray(state.verdictHistory) && state.verdictHistory.length >= 3);
  pass('Rejudge preserves original recording semantics', 'Latest WA; captured original AC/window unchanged; history retained (state fixture only)');

  await acceptReactionEvent(exam, { type: 'submissions', op: 'delete', data: { id: 's1' } }, at(13));
  assert.equal((await result('s1')).status, 'DELETED');
  await assert.rejects(reserveReactionOutput(first.id, 1n), /REACTION_JOB_CANCELLED/);
  pass('Submission delete', 'DELETED with explicit reason; original record retained for audit');
  await prisma.reaction.update({ where: { id: second.id }, data: { submissionObservedAt: at(-4000) } });
  await maintainReactionCache(exam.id);
  assert.equal((await result('s2')).status, 'TIMEOUT'); assert.equal((await result('s2')).error, 'JUDGEMENT_TIMEOUT');
  assert.equal((await prisma.mediaSegment.findUniqueOrThrow({ where: { id: camera.id } })).deletedAt, null);
  pass('Configurable pending timeout', 'Over 1800 seconds becomes TIMEOUT; referenced footage remains protected');

  await prisma.reaction.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { expiresAt: at(-1) } });
  await maintainReactionCache(exam.id);
  assert.equal((await result('s1')).status, 'EXPIRED'); assert.equal((await result('s2')).status, 'EXPIRED');
  assert.equal((await result('s1')).outputBytes, 0n); assert.equal((await result('s1')).reservedBytes, 0n);
  assert.equal(await prisma.reactionSegment.count({ where: { reactionId: { in: [first.id, second.id] } } }), 0);
  assert.ok((await prisma.mediaSegment.findUniqueOrThrow({ where: { id: camera.id } })).deletedAt);
  assert.equal(await storedObjectExists(camera.objectPath, marker.length), false);
  pass('Retention expiry releases references', 'Expired reactions release pins; old cache is then physically removed');

  const previousCredentials = process.env.REACTION_CCS_CREDENTIALS;
  try {
    // This credential only satisfies local configuration validation; the module
    // test never connects to CCS, and it cannot affect any other process/exam.
    process.env.REACTION_CCS_CREDENTIALS = JSON.stringify({
      ...JSON.parse(previousCredentials || '{}'),
      [exam.id]: { origin: exam.platformBaseUrl, username: 'module-only', password: randomBytes(24).toString('hex') },
    });
    await updateReactionConfig(exam.id, { enabled: false });
    const disabledAt = new Date();
    const whileDisabled: CcsEvent = { type: 'submissions', op: 'create', data: {
      id: 'disabled-gap', team_id: candidate.examNumber, problem_id: 'p1', time: disabledAt.toISOString(),
    } };
    await acceptReactionEvent(exam, whileDisabled, disabledAt);
    assert.equal(await prisma.reaction.count({ where: { examId: exam.id, submissionId: 'disabled-gap' } }), 0);
    assert.equal(await prisma.reactionEvent.count({ where: { examId: exam.id, type: 'submissions', remoteId: 'disabled-gap' } }), 0);
    // Guarantee different millisecond timestamps even on an extremely fast DB.
    await new Promise(resolve => setTimeout(resolve, 10));
    const beforeEnable = new Date();
    await updateReactionConfig(exam.id, { enabled: true });
    const enabledConfig = await prisma.reactionConfig.findUniqueOrThrow({ where: { examId: exam.id } });
    assert.ok(enabledConfig.initializedAt && enabledConfig.initializedAt >= beforeEnable && enabledConfig.initializedAt <= new Date());
    assert.ok(enabledConfig.initializedAt > disabledAt);
    // Reconnection replays the disabled interval; no new recording may result.
    await acceptReactionEvent(exam, whileDisabled, new Date());
    await acceptReactionEvent(exam, { ...whileDisabled, op: 'update' }, new Date());
    assert.equal(await prisma.reaction.count({ where: { examId: exam.id, submissionId: 'disabled-gap' } }), 0);
    const freshAt = new Date(+enabledConfig.initializedAt + 1);
    const afterEnable: CcsEvent = { type: 'submissions', op: 'create', data: {
      id: 'enabled-new', team_id: candidate.examNumber, problem_id: 'p1', time: freshAt.toISOString(),
    } };
    await acceptReactionEvent(exam, afterEnable, new Date(+freshAt + 1));
    assert.equal((await result('enabled-new')).status, 'PENDING');
    await updateReactionConfig(exam.id, { enabled: true, bufferSeconds: 70 });
    const savedConfig = await prisma.reactionConfig.findUniqueOrThrow({ where: { examId: exam.id } });
    assert.equal(+savedConfig.initializedAt!, +enabledConfig.initializedAt);
    assert.equal(savedConfig.bufferSeconds, 70);
    assert.equal((await result('s1')).status, 'EXPIRED');
    assert.equal((await result('s2')).status, 'EXPIRED');
    assert.equal(await prisma.reaction.count({ where: { examId: exam.id } }), 3);
    pass('Disable/re-enable cutover', 'Disabled-interval replay ignored; post-enable submission captured; saving enabled config keeps cutover; prior reactions retained');
  } finally {
    if (previousCredentials === undefined) delete process.env.REACTION_CCS_CREDENTIALS;
    else process.env.REACTION_CCS_CREDENTIALS = previousCredentials;
  }

  // Ranking fixtures exercise the real transaction path, not just the scorer.
  // They never contact NovaJudge and are explicitly constructed module inputs.
  const rankNow = new Date(Date.now() + 1000), rankStart = new Date(+rankNow - 3600000);
  const rankBaseline: CcsEvent[] = [
    { type: 'contests', data: { id: exam.platformContestId, start_time: rankStart.toISOString(), end_time: new Date(+rankNow + 3600000).toISOString(), penalty_time: 20 } },
    { type: 'teams', data: { id: candidate.examNumber, group_ids: [] } },
    { type: 'teams', data: { id: otherCandidate.examNumber, group_ids: [] } },
    { type: 'problems', data: { id: 'p1', label: 'A' } },
  ];
  await beginReactionRankingSnapshot(prisma, exam.id);
  for (const event of rankBaseline) await acceptReactionEvent(exam, event, rankNow, true);
  await completeReactionRankingSnapshot(prisma, exam.id, rankBaseline, rankNow);
  const rankSubmission: CcsEvent = { type: 'submissions', data: { id: 'rank-live', team_id: candidate.examNumber, problem_id: 'p1', time: rankNow.toISOString(), contest_time: '1:00:00.000' } };
  await acceptReactionEvent(exam, rankSubmission, new Date(+rankNow + 1));
  await acceptReactionEvent(exam, { type: 'judgements', data: { id: 'rank-j', submission_id: 'rank-live', judgement_type_id: 'AC' } }, new Date(+rankNow + 2000));
  const ranked = await result('rank-live'), originalRank = ranked.rankContext;
  assert.equal(parseReactionRankContext(originalRank)?.status, 'AVAILABLE');
  assert.equal(parseReactionRankContext(originalRank)?.beforeRank, 1);
  assert.equal(parseReactionRankContext(originalRank)?.afterRank, 1);
  await acceptReactionEvent(exam, { type: 'judgements', op: 'update', data: { id: 'rank-j', submission_id: 'rank-live', judgement_type_id: 'WA' } }, new Date(+rankNow + 3000));
  await acceptReactionEvent(exam, { type: 'judgements', op: 'delete', data: { id: 'rank-j', submission_id: 'rank-live' } }, new Date(+rankNow + 4000));
  const rejudgedTail = await result('rank-live');
  assert.equal(rejudgedTail.status, 'TAIL'); assert.equal(rejudgedTail.originalVerdict, 'AC');
  assert.equal(+rejudgedTail.windowEnd!, +ranked.windowEnd!);
  assert.deepEqual(rejudgedTail.rankContext, originalRank);
  const tombstone = await prisma.reactionEvent.findUniqueOrThrow({ where: { examId_type_remoteId: { examId: exam.id, type: 'judgements', remoteId: 'rank-j' } } });
  assert.equal((tombstone.payload as Record<string, unknown>).__reactionDeleted, true);
  pass('Observed rank + TAIL rejudge immutability', 'Complete baseline yields exact 1→1; WA/delete during tail retain original AC, cutoff and rank; checkpoint records deletion');

  await beginReactionRankingSnapshot(prisma, exam.id);
  const catchupSubmission: CcsEvent = { type: 'submissions', data: { id: 'rank-catchup', team_id: candidate.examNumber, problem_id: 'p1', time: new Date(+rankNow + 5000).toISOString(), contest_time: '1:00:05.000' } };
  const catchupJudgement: CcsEvent = { type: 'judgements', data: { id: 'rank-catchup-j', submission_id: 'rank-catchup', judgement_type_id: 'AC' } };
  await acceptReactionEvent(exam, catchupSubmission, new Date(+rankNow + 6000));
  await acceptReactionEvent(exam, catchupJudgement, new Date(+rankNow + 7000));
  assert.equal(parseReactionRankContext((await result('rank-catchup')).rankContext)?.status, 'UNAVAILABLE');
  await completeReactionRankingSnapshot(prisma, exam.id, [...rankBaseline, catchupSubmission, catchupJudgement], new Date(+rankNow + 8000));
  const reactionCount = await prisma.reaction.count({ where: { examId: exam.id } });
  await acceptReactionEvent(exam, catchupSubmission, new Date(+rankNow + 9000));
  await acceptReactionEvent(exam, catchupJudgement, new Date(+rankNow + 10000));
  assert.equal(await prisma.reaction.count({ where: { examId: exam.id } }), reactionCount);
  assert.equal(parseReactionRankContext((await result('rank-catchup')).rankContext)?.status, 'UNAVAILABLE');
  assert.equal(await prisma.reactionEvent.count({ where: { examId: exam.id, type: 'judgements', remoteId: 'rank-j' } }), 0);
  pass('Ranking reconnect baseline and snapshot pruning', 'Catch-up rank stays unavailable; replay creates no duplicate Reaction; vanished/deleted checkpoint removed from scoring state');

  const earlyFinal: CcsEvent = { type: 'judgements', data: { id: 'rank-early-j', submission_id: 'rank-early', judgement_type_id: 'AC' } };
  await acceptReactionEvent(exam, earlyFinal, new Date(+rankNow + 11000));
  assert.equal(await prisma.reaction.count({ where: { examId: exam.id, submissionId: 'rank-early' } }), 0);
  await acceptReactionEvent(exam, { type: 'submissions', data: { id: 'rank-early', team_id: candidate.examNumber, problem_id: 'p1', time: new Date(+rankNow + 10000).toISOString(), contest_time: '1:00:10.000' } }, new Date(+rankNow + 12000));
  await acceptReactionEvent(exam, earlyFinal, new Date(+rankNow + 13000));
  const early = await result('rank-early');
  assert.equal(early.status, 'TAIL'); assert.equal(+early.judgementObservedAt!, +rankNow + 11000);
  assert.equal(+early.windowEnd!, +rankNow + 21000);
  assert.equal(parseReactionRankContext(early.rankContext)?.status, 'UNAVAILABLE');
  assert.equal(parseReactionRankContext(early.rankContext)?.reason, 'FINAL_JUDGEMENT_PRECEDED_SUBMISSION_OBSERVATION');
  await acceptReactionEvent(exam, earlyFinal, new Date(+rankNow + 14000));
  assert.equal(+(await result('rank-early')).windowEnd!, +early.windowEnd!);
  pass('Judgement-before-submission snapshot race', 'Same-hash replay finishes previously orphaned final judgement using its first observation time; no invented live rank or extended tail');
}

try { await main(); }
catch (error) {
  failed = true;
  const detail = error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : 'Unknown failure';
  const line = `FAIL | Module integration | ${detail}`; lines.push(line); console.error(line);
} finally {
  try {
    if (examId) {
      // Every mutation is restricted to this invocation's freshly created ID.
      await prisma.reactionSegment.deleteMany({ where: { reaction: { examId } } });
      await prisma.reaction.deleteMany({ where: { examId } });
      await prisma.reactionEvent.deleteMany({ where: { examId } });
      await prisma.mediaSegment.deleteMany({ where: { examId } });
      await prisma.fileDeletionJob.deleteMany({ where: { examId } });
      await prisma.exam.delete({ where: { id: examId } });
    }
    for (const key of keys) await deleteStoredObject(key);
    lines.push('PASS | Fixture cleanup | Only this invocation\'s exam, rows and UUID-prefixed marker files removed');
  } catch { failed = true; lines.push('FAIL | Fixture cleanup | Inspect the UUID fixture; no broad cleanup attempted'); }
  await prisma.$disconnect();
  lines.push(`Finished: ${new Date().toISOString()}`, `Result: ${failed ? 'FAIL' : 'PASS'}`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, lines.join('\n') + '\n');
  console.log(`Module test report: ${reportPath}`);
}
if (failed) process.exitCode = 1;
