// Run only against a disposable database and local upload directory.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/db';
import { cleanupUnusedLoginMaterials } from '../src/lib/material-cleanup';
import { storeBuffer, deleteStoredObject, storedObjectExists } from '../src/lib/storage';
import { getStorageSettings } from '../src/lib/settings';
import type { MediaChannel } from '@prisma/client';

const marker = `material-cleanup-${randomUUID()}`;
const grants: string[] = [];
let examId = '';
let root = '';
const outside = await mkdtemp(path.join(os.tmpdir(), 'proctor-cleanup-outside-'));
try {
  const settings = await getStorageSettings();
  assert.equal(settings.provider, 'LOCAL');
  root = path.resolve(process.cwd(), settings.localUploadDir);
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1000000000, 10000000000)), name: marker, startAt: new Date(), latestStartAt: new Date(),
    endAt: new Date(Date.now() + 3600000), durationMinutes: 60, platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker,
    contestType: 'INDIVIDUAL', rules: 'Disposable recording cleanup test'
  } });
  examId = exam.id;
  const candidate = await prisma.candidate.create({ data: { examId, examNumber: marker, password: marker, seatNo: 'QA' } });
  const now = new Date();
  const old = new Date(now.getTime() - 3 * 86400000);
  async function grant(changes: Record<string, unknown> = {}) {
    const row = await prisma.materialUploadGrant.create({ data: {
      tokenHash: randomUUID(), examId, candidateId: candidate.id, pairingId: marker, deviceId: marker, expiresAt: old, ...changes
    } });
    grants.push(row.id);
    return row;
  }
  async function media(uploadGrantId: string, channel: MediaChannel = 'ROOM_VIDEO', changes: Record<string, unknown> = {}) {
    const bytes = Buffer.from(`synthetic fixture ${randomUUID()}`);
    const stored = await storeBuffer(bytes, { filename: `${randomUUID()}.webm`, prefix: `${examId}/${candidate.id}` });
    return prisma.mediaSegment.create({ data: { examId, candidateId: candidate.id, uploadGrantId, channel, objectPath: stored.objectPath,
      byteSize: bytes.length, validatedAt: now, ...changes } });
  }
  const unused = await grant();
  const doomed = [await media(unused.id), await media(unused.id, 'IDENTITY_PHOTO')];
  const empty = await grant();
  const retained = [];
  retained.push(await media((await grant({ expiresAt: new Date(now.getTime() - 23 * 3600000) })).id));
  retained.push(await media((await grant({ expiresAt: new Date(now.getTime() + 3600000) })).id));
  retained.push(await media((await grant({ consumedAt: old })).id));
  const submittedGrant = await grant();
  const submitted = await media(submittedGrant.id);
  const login = await prisma.loginRequest.create({ data: { examId, candidateId: candidate.id, roomVideoPath: submitted.objectPath } });
  retained.push(submitted); // Legacy path reference with no consumedAt still protects it.
  retained.push(await media((await grant({ loginRequestId: login.id })).id));
  const session = await prisma.clientSession.create({ data: { examId, candidateId: candidate.id, desktopDeviceId: marker, status: 'IN_EXAM' } });
  retained.push(await media((await grant()).id, 'ROOM_VIDEO', { sessionId: session.id }));
  retained.push(await media((await grant()).id, 'DESKTOP_SCREEN'));
  const shared = await media((await grant()).id);
  await prisma.mediaSegment.create({ data: { examId, candidateId: candidate.id, channel: 'EVIDENCE_CLIP', objectPath: shared.objectPath } });
  retained.push(shared);
  const evidence = await media((await grant()).id);
  await prisma.alert.create({ data: { examId, candidateId: candidate.id, type: 'MANUAL_NOTE', message: marker, evidencePath: evidence.objectPath } });
  retained.push(evidence);
  assert.equal(await cleanupUnusedLoginMaterials(now), 2);
  assert.equal(await cleanupUnusedLoginMaterials(now), 0, 'cleanup retries are idempotent');
  for (const segment of doomed) {
    assert.equal(await prisma.mediaSegment.findUnique({ where: { id: segment.id } }), null);
    assert.equal(await storedObjectExists(segment.objectPath, segment.byteSize), false);
  }
  assert.equal(await prisma.materialUploadGrant.findUnique({ where: { id: unused.id } }), null);
  assert.equal(await prisma.materialUploadGrant.findUnique({ where: { id: empty.id } }), null);
  for (const segment of retained) {
    assert.ok(await prisma.mediaSegment.findUnique({ where: { id: segment.id } }));
    assert.equal(await storedObjectExists(segment.objectPath, segment.byteSize), true);
  }
  for (const key of ['../outside.webm', '/absolute', 'http://example.test/video', 'exam\\file', 'exam/../file']) {
    await assert.rejects(deleteStoredObject(key), /存储路径/);
  }
  const outsideFile = path.join(outside, 'original.webm');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outsideFile, 'protected outside content');
  const symlinkKey = `${examId}/${candidate.id}/outside.webm`;
  await symlink(outsideFile, path.join(root, symlinkKey));
  await assert.rejects(deleteStoredObject(symlinkKey), /存储路径/);
  assert.equal(await readFile(outsideFile, 'utf8'), 'protected outside content');
  const failed = await media((await grant()).id);
  await rm(path.join(root, failed.objectPath));
  await symlink(outsideFile, path.join(root, failed.objectPath));
  await assert.rejects(cleanupUnusedLoginMaterials(now), /存储路径/);
  assert.ok(await prisma.mediaSegment.findUnique({ where: { id: failed.id } }), 'failed deletion keeps metadata for retry');
  await rm(path.join(root, failed.objectPath));
  assert.equal(await cleanupUnusedLoginMaterials(now), 1, 'already missing unused files can safely finish cleanup');
  console.log(JSON.stringify({ ok: true, removedUnusedMaterials: 2, protectedCases: retained.length, traversalAndSymlinkProtected: true, retryAfterStorageFailure: true }));
} finally {
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.materialUploadGrant.deleteMany({ where: { id: { in: grants } } });
  if (root && examId) await rm(path.join(root, examId), { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await prisma.$disconnect();
}
