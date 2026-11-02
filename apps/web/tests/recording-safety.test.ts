import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mediaUploadIdentity } from '../src/lib/media-upload-policy';
import { evidenceWindow, type EvidenceSegment } from '../src/lib/evidence-window';
import { storeBuffer, signedLocalObjectUrl, validatedStorageKey, verifySignedLocalObjectUrl } from '../src/lib/storage';
import { prisma } from '../src/lib/db';

const input = { examId: 'exam', sessionId: 'session', channel: 'DESKTOP_SCREEN', startedAt: '2026-09-30T10:00:00Z', buffer: Buffer.from('the same video') };
test('upload retries preserve identity, while sessions, channels, and new capture times remain separate', () => {
  const first = mediaUploadIdentity(input).id;
  assert.equal(mediaUploadIdentity({ ...input, startedAt: '2026-09-30T10:00:00.000Z' }).id, first);
  assert.notEqual(mediaUploadIdentity({ ...input, sessionId: 'another-login' }).id, first);
  assert.notEqual(mediaUploadIdentity({ ...input, channel: 'DESKTOP_CAMERA' }).id, first);
  assert.notEqual(mediaUploadIdentity({ ...input, startedAt: '2026-09-30T10:00:05Z' }).id, first);
});

test('explicit upload IDs survive retry metadata changes but changed bytes have a separate digest', () => {
  const original = mediaUploadIdentity({ ...input, uploadId: 'fixed-id' });
  const retry = mediaUploadIdentity({ ...input, uploadId: 'fixed-id', startedAt: undefined });
  assert.deepEqual(retry, original);
  const conflict = mediaUploadIdentity({ ...input, uploadId: 'fixed-id', buffer: Buffer.from('different bytes') });
  assert.equal(conflict.id, original.id);
  assert.notEqual(conflict.digest, original.digest);
});

const eventTime = new Date('2026-09-30T10:01:00Z');
const alert = { id: 'desktop_alert_event', sessionId: 'session', type: 'SCREEN_SWITCH', createdAt: eventTime };
function segment(startSeconds: number, endSeconds: number | null, changes: Partial<EvidenceSegment> = {}): EvidenceSegment {
  return {
    id: `segment${startSeconds}`, sessionId: 'session', channel: 'DESKTOP_SCREEN', objectPath: `video-${startSeconds}.webm`,
    startedAt: new Date(eventTime.getTime() + startSeconds * 1000),
    endedAt: endSeconds === null ? null : new Date(eventTime.getTime() + endSeconds * 1000), ...changes
  };
}

test('evidence spans exactly 20 seconds before and after an event across uploaded segments', () => {
  const records = [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20].map((start) => segment(start, start + 5));
  const result = evidenceWindow(alert, records, eventTime);
  assert.equal(result.windowStart.toISOString(), '2026-09-30T10:00:40.000Z');
  assert.equal(result.windowEnd.toISOString(), '2026-09-30T10:01:20.000Z');
  assert.equal(result.segments.length, 8);
  assert.equal(result.availableSeconds, 40);
  assert.equal(result.complete, true);
  assert.equal(result.pending, false);
});

test('overlapping copies are counted only once and other sessions or channels are excluded', () => {
  const records = [segment(-20, 20), segment(-20, 20, { id: 'duplicate' }), segment(-20, 20, { id: 'other-session', sessionId: 'next-login', objectPath: 'other.webm' }), segment(-20, 20, { id: 'camera', channel: 'DESKTOP_CAMERA', objectPath: 'camera.webm' })];
  const result = evidenceWindow(alert, records);
  assert.equal(result.segments.length, 1);
  assert.equal(result.availableSeconds, 40);
});

test('an incomplete or legacy recording never claims a complete 40-second evidence window', () => {
  const partial = evidenceWindow(alert, [segment(-20, 0)], eventTime);
  assert.equal(partial.complete, false);
  assert.equal(partial.pending, true);
  assert.equal(partial.availableSeconds, 20);
  const legacy = evidenceWindow(alert, [-20, -10, 0, 10].map((time) => segment(time, null)), new Date(eventTime.getTime() + 31 * 60_000));
  assert.equal(legacy.complete, false);
  assert.equal(legacy.pending, false);
  assert.ok(legacy.segments.every((item) => item.estimated));
});

test('a genuine hole remains incomplete and supplementary uploads complete the same event without copied evidence', () => {
  const records = [segment(-20, -5), segment(5, 20)];
  assert.equal(evidenceWindow(alert, records, eventTime).complete, false);
  assert.equal(evidenceWindow(alert, [...records, segment(-5, 5)], eventTime).complete, true);
});

test('mobile screen switches use only the second-camera evidence; unbound notes never borrow another session', () => {
  const records = [segment(-20, 20), segment(-20, 20, { id: 'mobile', channel: 'MOBILE_CAMERA', objectPath: 'mobile.webm' })];
  assert.equal(evidenceWindow({ ...alert, id: 'mobile_alert_event' }, records).segments[0].id, 'mobile');
  assert.equal(evidenceWindow({ ...alert, id: 'old-id', message: '离开第二机位页面' }, records).segments[0].id, 'mobile');
  assert.equal(evidenceWindow({ ...alert, sessionId: null }, records).segments.length, 0);
});

test('storage rejects traversal and signed URLs cannot be reused for another recording', () => {
  for (const prefix of ['../outside', '/absolute', 'exam/../../outside', 'exam\\outside']) assert.throws(() => validatedStorageKey(prefix, 'clip.webm'));
  const signed = new URL(signedLocalObjectUrl('exam/session/clip.webm'), 'http://localhost');
  assert.equal(verifySignedLocalObjectUrl('exam/session/clip.webm', signed.searchParams.get('exp'), signed.searchParams.get('sig')), true);
  assert.equal(verifySignedLocalObjectUrl('exam/other/clip.webm', signed.searchParams.get('exp'), signed.searchParams.get('sig')), false);
  assert.equal(verifySignedLocalObjectUrl('exam/session/clip.webm', 'Infinity', signed.searchParams.get('sig')), false);
});

test('concurrent saves publish one complete private recording without temporary-file residue', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'proctor-recording-test-'));
  const original = prisma.systemSetting.findUnique;
  prisma.systemSetting.findUnique = (async () => ({ value: { provider: 'LOCAL', localUploadDir: directory } })) as unknown as typeof original;
  try {
    const content = Buffer.alloc(512 * 1024, 42);
    const results = await Promise.all(Array.from({ length: 12 }, () => storeBuffer(content, { filename: 'fixed.webm', prefix: 'exam/session', stableName: true, immutable: true })));
    assert.equal(new Set(results.map((item) => item.objectPath)).size, 1);
    const file = path.join(directory, 'exam/session/fixed.webm');
    assert.deepEqual(await readFile(file), content);
    assert.deepEqual(await readdir(path.dirname(file)), ['fixed.webm']);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    prisma.systemSetting.findUnique = original;
    await rm(directory, { recursive: true, force: true });
  }
});
