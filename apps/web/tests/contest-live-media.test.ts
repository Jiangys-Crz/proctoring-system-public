import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contestLiveViewerUnchanged } from '../src/lib/contest-live-access';
import { revokeInvalidContestLiveSchedule } from '../src/lib/contest-live-config';
import { contestLiveSourceUnchanged, readContestLiveData } from '../src/lib/contest-live-data';
import { allowContestLiveMediaSession, authorizeContestLiveMediaToken, canUseContestLiveMedia, pruneContestLiveRosterConnections } from '../src/lib/contest-live-media';
import { defaultContestLiveSettings, mergeContestLiveSettings, readContestLiveConfig } from '../src/lib/contest-live-settings';
import { prisma } from '../src/lib/db';
import {
  assertContestLiveTarget, createContestLiveMediaToken, signContestLiveTarget, verifyContestLiveMediaToken,
  matchesContestDisplayHistoryLogo, signContestDisplayHistoryLogo,
} from '../src/lib/contest-live-media-token';

const freezeAt = '2026-11-17T09:00:00.000Z';
const timing = { startAt: new Date('2026-11-17T08:00:00Z'), endAt: new Date('2026-11-17T10:00:00Z') };

test('viewing permissions require a configured freeze, current scene, channel and grant', () => {
  const obsKeyHash = 'fixture-key-hash';
  const settings = {
    publicEnabled: true, publicMediaEnabled: false, selectedTeamIds: ['on-air', 'not-on-air'],
    mediaMode: 'screen', spotlight: { visible: false, teamIds: ['spotlight'] },
  };
  const unconfigured = readContestLiveConfig({ settings, obsKeyHash }, timing);
  assert.equal(canUseContestLiveMedia(unconfigured, obsKeyHash, 'on-air', 'DESKTOP_SCREEN'), false);
  const ready = readContestLiveConfig({ settings: { ...settings, freeze: { at: freezeAt } }, obsKeyHash }, timing);
  assert.equal(canUseContestLiveMedia(ready, obsKeyHash, 'on-air', 'DESKTOP_SCREEN'), true);
  assert.equal(canUseContestLiveMedia(ready, obsKeyHash, 'on-air', 'DESKTOP_CAMERA'), false);
  assert.equal(canUseContestLiveMedia(ready, obsKeyHash, 'not-on-air', 'DESKTOP_SCREEN'), false);
  assert.equal(canUseContestLiveMedia(ready, obsKeyHash, 'spotlight', 'DESKTOP_SCREEN'), false);
  assert.equal(canUseContestLiveMedia(ready, 'public', 'on-air', 'DESKTOP_SCREEN'), false);
  assert.equal(canUseContestLiveMedia(ready, 'old-key', 'on-air', 'DESKTOP_SCREEN'), false);
});

test('a rescheduled contest with an invalid freeze stops existing live access grants', async () => {
  const obsKeyHash = 'existing-obs-grant';
  const stored = { settings: { publicEnabled: true, publicMediaEnabled: true, selectedTeamIds: ['team'],
    freeze: { at: freezeAt, revealed: true } }, obsKeyHash };
  for (const actual of [
    { ...timing, endAt: new Date('2026-11-17T08:45:00Z') },
    { ...timing, startAt: new Date('2026-11-17T09:00:00Z') },
  ]) {
    const invalid = readContestLiveConfig(stored, actual);
    assert.deepEqual(invalid.settings.freeze, { at: null, revealed: false });
    assert.equal(invalid.settings.publicEnabled, false);
    assert.equal(invalid.settings.publicMediaEnabled, false);
    assert.equal(invalid.obsKeyHash, null);
  }
  const original = prisma.contestLiveSettings.findUnique;
  prisma.contestLiveSettings.findUnique = (async () => ({ ...stored, exam: { platform: 'HYDRO_BROWSER', contestRule: 'XCPC',
    ...timing, endAt: new Date('2026-11-17T08:45:00Z') } })) as never;
  try {
    const claims = { examId: 'exam', teamId: 'team', sessionId: 'session', channel: 'DESKTOP_SCREEN' } as const;
    for (const access of ['public', obsKeyHash]) {
      assert.equal(await authorizeContestLiveMediaToken(createContestLiveMediaToken({ ...claims, access }), claims.sessionId, claims.channel), false);
    }
  } finally { prisma.contestLiveSettings.findUnique = original; }
});

test('saving an invalidated schedule clears the live key and collects readers for teardown', async () => {
  const settings = { publicEnabled: true, publicMediaEnabled: true, freeze: { at: freezeAt, revealed: true } };
  const readers = [{ id: 'reader', sessionId: 'session', channel: 'DESKTOP_SCREEN' }];
  const writes: Array<{ settings: typeof settings; obsKeyHash: string | null }> = [];
  const tx = {
    contestLiveSettings: { findUnique: async () => ({ settings, obsKeyHash: 'fixture-key-hash' }),
      update: async ({ data }: { data: typeof writes[number] }) => { writes.push(data); } },
    contestLiveConnection: { findMany: async () => readers },
  } as unknown as Parameters<typeof revokeInvalidContestLiveSchedule>[0];
  const exam = { id: 'exam', platform: 'HYDRO_BROWSER', contestRule: 'XCPC', ...timing } as const;
  assert.deepEqual(await revokeInvalidContestLiveSchedule(tx, exam), []);
  assert.equal(writes.length, 0);
  assert.deepEqual(await revokeInvalidContestLiveSchedule(tx, { ...exam, endAt: new Date(freezeAt) }), readers);
  assert.equal(writes[0].obsKeyHash, null);
  assert.equal(writes[0].settings.publicEnabled, false);
  assert.equal(writes[0].settings.publicMediaEnabled, false);
  assert.deepEqual(writes[0].settings.freeze, { at: null, revealed: false });
});

test('media callback rechecks a live grant after asynchronous roster and camera authorization', async () => {
  const exam = { ...timing, id: 'exam', platform: 'HYDRO_BROWSER', contestRule: 'XCPC', contestType: 'INDIVIDUAL',
    candidates: [{ id: 'team', examNumber: 'entry' }] };
  const key = 'original-obs-grant';
  let obsKeyHash = key;
  const original = { findSettings: prisma.contestLiveSettings.findUnique, findSession: prisma.clientSession.findFirst,
    findExam: prisma.exam.findUnique, findRoom: prisma.examRoom.findFirst };
  prisma.contestLiveSettings.findUnique = (async () => ({ exam, obsKeyHash,
    settings: { selectedTeamIds: ['team'], freeze: { at: freezeAt } } })) as never;
  prisma.clientSession.findFirst = (async () => ({ examId: exam.id, candidateId: 'team', status: 'IN_EXAM', revokedAt: null })) as never;
  prisma.exam.findUnique = (async () => exam) as never;
  prisma.examRoom.findFirst = (async () => {
    obsKeyHash = 'rotated-grant';
    return { requireFrontCamera: true, candidates: [], exam: { ...exam, endAt: new Date(Date.now() + 60_000) } };
  }) as never;
  try {
    const claims = { examId: exam.id, teamId: 'team', sessionId: 'session', channel: 'DESKTOP_CAMERA', access: key } as const;
    assert.equal(await authorizeContestLiveMediaToken(createContestLiveMediaToken(claims), claims.sessionId, claims.channel), false);
    assert.equal(obsKeyHash, 'rotated-grant');
  } finally {
    prisma.contestLiveSettings.findUnique = original.findSettings;
    prisma.clientSession.findFirst = original.findSession;
    prisma.exam.findUnique = original.findExam;
    prisma.examRoom.findFirst = original.findRoom;
  }
});

test('snapshot validation detects roster, organization mode and template edits even when the timestamp is unchanged', async () => {
  const exam = { ...timing, id: 'roster-validation-exam', name: 'fixture', platform: 'HYDRO', contestRule: 'XCPC', contestType: 'TEAM',
    updatedAt: new Date('2026-11-17T08:00:00Z') };
  const candidate = { id: 'team', name: 'Before', examNumber: 'account', teamName: 'Old Team', school: 'School A', college: 'College B' };
  let candidates = [candidate];
  let settings = {};
  let reactionLogoMatchBy = 'SCHOOL';
  const original = { findExam: prisma.exam.findUnique, transaction: prisma.$transaction,
    findProblems: prisma.examProblem.findMany, findSubmissions: prisma.contestSubmission.findMany };
  prisma.exam.findUnique = (async () => ({ ...exam, candidates, reactionLogoMatchBy, contestLiveSettings: { settings } })) as never;
  prisma.examProblem.findMany = (async () => []) as never;
  prisma.contestSubmission.findMany = (async () => []) as never;
  prisma.$transaction = (async (queries: Array<Promise<unknown>>) => Promise.all(queries)) as never;
  try {
    const content = await readContestLiveData(exam.id);
    assert.ok(content);
    assert.equal(content.data.teams[0].name, 'School A: Old Team');
    settings = { horizontalQueue: true };
    assert.equal(await contestLiveSourceUnchanged(exam.id, content.sourceRevision), true);
    reactionLogoMatchBy = 'COLLEGE';
    assert.equal(await contestLiveSourceUnchanged(exam.id, content.sourceRevision), false);
    reactionLogoMatchBy = 'SCHOOL';
    settings = { teamNameTemplate: '{team.name} [{college.name}]' };
    assert.equal(await contestLiveSourceUnchanged(exam.id, content.sourceRevision), false);
    assert.equal((await readContestLiveData(exam.id))?.data.teams[0].name, 'Old Team [College B]');
    settings = {};
    candidates = [{ ...candidate, teamName: 'New Team' }];
    assert.equal(await contestLiveSourceUnchanged(exam.id, content.sourceRevision), false);
    candidates = [];
    assert.equal(await contestLiveSourceUnchanged(exam.id, content.sourceRevision), false);
  } finally {
    prisma.exam.findUnique = original.findExam;
    prisma.$transaction = original.transaction;
    prisma.examProblem.findMany = original.findProblems;
    prisma.contestSubmission.findMany = original.findSubmissions;
  }
});

test('screen and camera sessions must still belong to the requested roster team', async () => {
  const candidate = { id: 'candidate', examNumber: 'entry-b', memberOrder: 2 };
  const leader = { id: 'leader', examNumber: 'entry-a', memberOrder: 1, teamName: 'Team A' };
  const another = { id: 'another', examNumber: 'entry-c', memberOrder: 1, teamName: 'Team B' };
  let currentTeam = 'Team A';
  let roomReads = 0;
  const db = {
    exam: { findUnique: async () => ({
      id: 'exam', platform: 'HYDRO_BROWSER', contestRule: 'XCPC', contestType: 'TEAM',
      candidates: [leader, another, { ...candidate, teamName: currentTeam }],
    }) },
    clientSession: { findFirst: async () => ({ examId: 'exam', candidateId: candidate.id, status: 'IN_EXAM', revokedAt: null }) },
    examRoom: { findFirst: async () => {
      roomReads++;
      return { requireFrontCamera: false, candidates: [], exam: { contestRule: 'XCPC', endAt: new Date(Date.now() + 60_000) } };
    } },
  } as unknown as NonNullable<Parameters<typeof allowContestLiveMediaSession>[4]>;

  assert.equal(await allowContestLiveMediaSession('exam', leader.id, 'session', 'DESKTOP_SCREEN', db), true);
  assert.equal(await allowContestLiveMediaSession('exam', leader.id, 'session', 'DESKTOP_CAMERA', db), false);
  currentTeam = 'Team B';
  assert.equal(await allowContestLiveMediaSession('exam', leader.id, 'session', 'DESKTOP_SCREEN', db), false);
  assert.equal(roomReads, 2, 'a session outside the selected team is rejected before checking camera policy');
  assert.equal(await allowContestLiveMediaSession('exam', another.id, 'session', 'DESKTOP_SCREEN', db), true);
});

test('a snapshot cannot be returned with an outdated viewer or freeze policy', () => {
  const settings = mergeContestLiveSettings(defaultContestLiveSettings, { publicEnabled: true, publicMediaEnabled: true,
    freeze: { at: '2026-11-17T09:00:00.000Z', revealed: false } });
  const viewer = { settings, manage: false, access: 'public', mediaAllowed: true, key: null, obsKeyActive: false } as const;
  assert.equal(contestLiveViewerUnchanged(viewer, { ...viewer, settings: structuredClone(settings) }), true);
  assert.equal(contestLiveViewerUnchanged(viewer, { ...viewer, mediaAllowed: false }), false);
  assert.equal(contestLiveViewerUnchanged(viewer, { ...viewer, access: 'rotated-key' }), false);
  assert.equal(contestLiveViewerUnchanged(viewer, { ...viewer, manage: true, access: null }), false);
  assert.equal(contestLiveViewerUnchanged(viewer, { ...viewer, settings: { ...settings,
    freeze: { ...settings.freeze, at: '2026-11-17T08:30:00.000Z' } } }), false);
});

test('roster edits close old viewing connections without disconnecting the current team', async () => {
  const keep = '59eba050-8295-4e4e-a2e7-18c38dbb4acc';
  const remove = '2c7af651-3e99-4d3f-b587-b0a9ecc940d2';
  const connections = [
    { id: keep, sessionId: 'session', teamId: 'current-team', channel: 'DESKTOP_SCREEN' },
    { id: remove, sessionId: 'session', teamId: 'former-team', channel: 'DESKTOP_SCREEN' },
  ];
  const original = {
    findConnections: prisma.contestLiveConnection.findMany, deleteConnection: prisma.contestLiveConnection.deleteMany,
    findExam: prisma.exam.findUnique, findSessions: prisma.clientSession.findMany, fetch: globalThis.fetch,
  };
  const disconnected: string[] = [];
  const deleted: string[] = [];
  prisma.contestLiveConnection.findMany = (async () => connections) as never;
  prisma.contestLiveConnection.deleteMany = (async ({ where }: { where: { id: string } }) => {
    deleted.push(where.id);
    return { count: 1 };
  }) as never;
  prisma.exam.findUnique = (async () => ({ id: 'exam', platform: 'HYDRO_BROWSER', contestRule: 'XCPC', contestType: 'INDIVIDUAL',
    candidates: [{ id: 'current-team', examNumber: 'entry-a' }] })) as never;
  prisma.clientSession.findMany = (async () => [{ id: 'session', candidateId: 'current-team' }]) as never;
  globalThis.fetch = async (url, options) => {
    assert.equal(options?.method, 'DELETE');
    disconnected.push(new URL(String(url)).pathname);
    return new Response(null, { status: 204 });
  };
  try {
    await pruneContestLiveRosterConnections('exam');
    assert.deepEqual(deleted, [remove]);
    assert.equal(disconnected.length, 1);
    assert.ok(disconnected[0].endsWith(`/whep/${remove}`));
  } finally {
    prisma.contestLiveConnection.findMany = original.findConnections;
    prisma.contestLiveConnection.deleteMany = original.deleteConnection;
    prisma.exam.findUnique = original.findExam;
    prisma.clientSession.findMany = original.findSessions;
    globalThis.fetch = original.fetch;
  }
});

test('sparse team view slots grant only their configured channels and legacy controls replace slots', () => {
  const obsKeyHash = 'fixture-key-hash';
  const settings = mergeContestLiveSettings(defaultContestLiveSettings, {
    freeze: { at: '2026-11-17T09:00:00.000Z' }, teamMode: 'split', mediaMode: 'photo',
    teamSlots: [null, { teamId: 'team-a', primary: 'camera', secondary: 'empty' }, null,
      { teamId: 'team-b', primary: 'photo', secondary: 'screen' }],
  });
  const row = { settings, obsKeyHash };
  assert.deepEqual(settings.selectedTeamIds, ['team-a', 'team-b']);
  assert.equal(canUseContestLiveMedia(row, obsKeyHash, 'team-a', 'DESKTOP_CAMERA'), true);
  assert.equal(canUseContestLiveMedia(row, obsKeyHash, 'team-a', 'DESKTOP_SCREEN'), false);
  assert.equal(canUseContestLiveMedia(row, obsKeyHash, 'team-b', 'DESKTOP_SCREEN'), true);
  assert.equal(canUseContestLiveMedia(row, obsKeyHash, 'team-b', 'DESKTOP_CAMERA'), false);
  const replaced = mergeContestLiveSettings(settings, { teamMode: 'single', selectedTeamIds: ['team-c'], mediaMode: 'screen' });
  assert.equal(replaced.teamSlots, undefined);
  assert.equal(canUseContestLiveMedia({ settings: replaced, obsKeyHash }, obsKeyHash, 'team-c', 'DESKTOP_SCREEN'), true);
});

test('historical logos are scoped to the presentation revision and chosen archived source', () => {
  const grant = signContestDisplayHistoryLogo('active', 'archive', 5, 'school', 'logo');
  assert.equal(matchesContestDisplayHistoryLogo(grant, 'active', 'archive', 5, 'school', 'logo'), true);
  assert.equal(matchesContestDisplayHistoryLogo(grant, 'active', 'other-archive', 5, 'school', 'logo'), false);
  assert.equal(matchesContestDisplayHistoryLogo(grant, 'active', 'archive', 6, 'school', 'logo'), false);
});

test('a signed media target cannot be transferred across exams, sessions, channels or links', () => {
  const channel = 'DESKTOP_SCREEN';
  const claims = { examId: 'exam', teamId: 'team', sessionId: 'session', channel, access: 'public' } as const;
  const signature = signContestLiveTarget(claims.examId, claims.teamId, claims.sessionId, channel, claims.access);
  assert.doesNotThrow(() => assertContestLiveTarget(signature, claims.examId, claims.teamId, claims.sessionId, channel, claims.access));
  assert.throws(() => assertContestLiveTarget(signature, 'other-exam', claims.teamId, claims.sessionId, channel, claims.access));
  assert.throws(() => assertContestLiveTarget(signature, claims.examId, claims.teamId, 'other-session', channel, claims.access));
  assert.throws(() => assertContestLiveTarget(signature, claims.examId, claims.teamId, claims.sessionId, 'DESKTOP_CAMERA', claims.access));
  assert.throws(() => assertContestLiveTarget(signature, claims.examId, claims.teamId, claims.sessionId, channel, 'different-obs-key'));

  const token = createContestLiveMediaToken(claims);
  assert.equal(verifyContestLiveMediaToken(token, claims.sessionId, channel)?.examId, claims.examId);
  assert.equal(verifyContestLiveMediaToken(token, 'other-session', channel), null);
  assert.equal(verifyContestLiveMediaToken(token, claims.sessionId, 'DESKTOP_CAMERA'), null);
});
