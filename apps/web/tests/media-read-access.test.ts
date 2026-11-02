import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMediaReadToken, verifyMediaReadToken, rewriteHlsPlaylist, mediaStreamPath } from '../src/lib/media-read-token';
import type { User } from '@prisma/client';
import { authorizeMediaRead } from '../src/lib/media-read-access';
import { prisma } from '../src/lib/db';

test('live read tokens are scoped to a specific viewer, session, channel and short expiry', () => {
  const now = Date.parse('2026-09-30T10:00:00Z');
  const token = createMediaReadToken('viewer-a', 'session-a', 'DESKTOP_SCREEN', now);
  assert.equal(verifyMediaReadToken(token, 'session-a', 'DESKTOP_SCREEN', now)?.userId, 'viewer-a');
  assert.equal(verifyMediaReadToken(token, 'session-b', 'DESKTOP_SCREEN', now), null);
  assert.equal(verifyMediaReadToken(token, 'session-a', 'DESKTOP_CAMERA', now), null);
  assert.equal(verifyMediaReadToken(token, 'session-a', 'DESKTOP_SCREEN', now + 60_000), null);
});

test('tampered, malformed and client publishing credentials cannot grant live read access', () => {
  const now = Date.now();
  const token = createMediaReadToken('viewer-a', 'session-a', 'DESKTOP_SCREEN', now);
  const [payload, signature] = token.split('.');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sessionId: 'session-b' })).toString('base64url');
  for (const value of ['', 'desktop-client-session-token', `${changed}.${signature}`, `${payload}.${'中'.repeat(43)}`, `${token}.extra`, `bad.${signature}`]) {
    assert.equal(verifyMediaReadToken(value, 'session-b', 'DESKTOP_SCREEN', now), null);
  }
});

test('HLS playlists, init files, parts and preload hints remain behind the same authorization route', () => {
  const path = mediaStreamPath('session-a', 'DESKTOP_SCREEN');
  const upstream = new URL(`http://media:8080${path}/index.m3u8`);
  const prefix = '/api/media/hls/session-a/DESKTOP_SCREEN';
  const playlist = [
    '#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000000', 'main.m3u8',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-PART:DURATION=0.2,URI="part1.mp4"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part2.mp4?_HLS_part=2"',
    `${path}/segment1.mp4?token=must-not-leak`
  ].join('\n');
  const rewritten = rewriteHlsPlaylist(playlist, upstream, prefix, path);
  for (const resource of ['main.m3u8', 'init.mp4', 'part1.mp4', 'part2.mp4?_HLS_part=2', 'segment1.mp4']) {
    assert.ok(rewritten.includes(`${prefix}/${resource}`), resource);
  }
  assert.doesNotMatch(rewritten, /token=|http:\/\/media/);
});

test('HLS rewriting rejects cross-stream, external and traversing resources', () => {
  const path = mediaStreamPath('session-a', 'DESKTOP_SCREEN');
  const source = new URL(`http://media:8080${path}/index.m3u8`);
  for (const resource of ['https://external.example/segment.mp4', '../session-b_DESKTOP_SCREEN/segment.mp4', '/live/session-b_DESKTOP_SCREEN/segment.mp4', '//other:8080/live/session-a_DESKTOP_SCREEN/x.mp4']) {
    assert.throws(() => rewriteHlsPlaylist(`#EXTM3U\n${resource}`, source, '/api/media/hls/session-a/DESKTOP_SCREEN', path), /无效/);
  }
  assert.throws(() => mediaStreamPath('../session', 'DESKTOP_SCREEN'), /参数/);
  assert.throws(() => mediaStreamPath('session', 'NOT_A_CHANNEL'), /参数/);
});

function accessRow(changes: Record<string, unknown> = {}) {
  return { candidateId: 'candidate', examId: 'exam', examRequireFrontCamera: 1, examRequireMiniProgram: 1,
    requireFrontCamera: 1, requireSecondCamera: 1, allowed: 1n, ...changes };
}

const viewer = { id: 'viewer', role: 'ADMIN' } as User;

test('parallel HLS requests across all channels share one query but permission removal applies to the next request', async () => {
  const originalQuery = prisma.$queryRaw;
  let lookups = 0, permitted = true;
  let release!: () => void;
  const query = new Promise<void>(resolve => { release = resolve; });
  prisma.$queryRaw = (async () => {
    lookups++;
    await query;
    return [accessRow({ allowed: permitted ? 1n : null })];
  }) as unknown as typeof originalQuery;
  try {
    const channels = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'];
    const requests = Array.from({ length: 60 }, (_, i) => authorizeMediaRead(viewer, 'session', channels[i % channels.length]));
    assert.equal(lookups, 1);
    release();
    assert.equal((await Promise.all(requests)).length, 60);
    permitted = false;
    await assert.rejects(authorizeMediaRead(viewer, 'session', 'DESKTOP_SCREEN'), { status: 403 });
    assert.equal(lookups, 2, 'completed authorization is never cached');
  } finally {
    release();
    prisma.$queryRaw = originalQuery;
  }
});

test('sharing a lookup never shares a channel decision or bypasses current room policy', async () => {
  const originalQuery = prisma.$queryRaw;
  let roomRequiresCamera = false, lookups = 0;
  prisma.$queryRaw = (async () => { lookups++; return [accessRow({ requireFrontCamera: Number(roomRequiresCamera), requireSecondCamera: 0 })]; }) as unknown as typeof originalQuery;
  try {
    const result = await Promise.allSettled([
      authorizeMediaRead(viewer, 'session', 'DESKTOP_SCREEN'),
      authorizeMediaRead(viewer, 'session', 'DESKTOP_CAMERA'),
      authorizeMediaRead(viewer, 'session', 'MOBILE_CAMERA'),
      authorizeMediaRead(viewer, 'session', 'MOBILE_CAMERA', false)
    ]);
    assert.equal(lookups, 1);
    assert.equal(result[0].status, 'fulfilled');
    for (const denied of [result[1], result[2]]) {
      assert.equal(denied.status, 'rejected');
      if (denied.status === 'rejected') assert.equal(denied.reason.status, 409);
    }
    assert.equal(result[3].status, 'fulfilled', 'existing WHEP resource cleanup keeps its original policy behavior');
    roomRequiresCamera = true;
    await authorizeMediaRead(viewer, 'session', 'DESKTOP_CAMERA');
    roomRequiresCamera = false;
    await assert.rejects(authorizeMediaRead(viewer, 'session', 'DESKTOP_CAMERA'), { status: 409 });
    assert.equal(lookups, 3);
  } finally { prisma.$queryRaw = originalQuery; }
});

test('different viewers, roles and sessions never reuse another authorization query', async () => {
  const originalQuery = prisma.$queryRaw;
  let lookups = 0;
  prisma.$queryRaw = (async () => { lookups++; return [accessRow()]; }) as unknown as typeof originalQuery;
  try {
    await Promise.all([
      authorizeMediaRead(viewer, 'session', 'DESKTOP_SCREEN'),
      authorizeMediaRead({ ...viewer, id: 'other' }, 'session', 'DESKTOP_SCREEN'),
      authorizeMediaRead({ ...viewer, role: 'SUPER_ADMIN' }, 'session', 'DESKTOP_SCREEN'),
      authorizeMediaRead(viewer, 'other-session', 'DESKTOP_SCREEN')
    ]);
    assert.equal(lookups, 4);
  } finally { prisma.$queryRaw = originalQuery; }
});

test('invalid parameters fail before accessing the database and missing sessions remain 404', async () => {
  const originalQuery = prisma.$queryRaw;
  let lookups = 0;
  prisma.$queryRaw = (async () => { lookups++; return []; }) as unknown as typeof originalQuery;
  try {
    await assert.rejects(authorizeMediaRead(viewer, '../session', 'DESKTOP_SCREEN'), { status: 400 });
    await assert.rejects(authorizeMediaRead(viewer, 'session', 'OTHER'), { status: 400 });
    assert.equal(lookups, 0);
    await assert.rejects(authorizeMediaRead(viewer, 'missing', 'DESKTOP_SCREEN'), { status: 404 });
    assert.equal(lookups, 1);
  } finally { prisma.$queryRaw = originalQuery; }
});

test('failed database queries are not retained after the concurrent request completes', async () => {
  const originalQuery = prisma.$queryRaw;
  let lookups = 0;
  prisma.$queryRaw = (async () => {
    if (++lookups === 1) throw new Error('temporary failure');
    return [accessRow()];
  }) as unknown as typeof originalQuery;
  try {
    const requests = await Promise.allSettled([
      authorizeMediaRead(viewer, 'session', 'DESKTOP_SCREEN'),
      authorizeMediaRead(viewer, 'session', 'MOBILE_CAMERA')
    ]);
    assert.equal(requests.every(request => request.status === 'rejected'), true);
    await authorizeMediaRead(viewer, 'session', 'DESKTOP_SCREEN');
    assert.equal(lookups, 2);
  } finally {
    prisma.$queryRaw = originalQuery;
  }
});
