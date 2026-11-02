// Run against a disposable database and local upload/release directories only.
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { readFile, writeFile, rm, mkdir, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import type { MediaChannel, Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { deleteRecordings } from '../src/lib/recording-deletion';
import { processFileDeletions, deletionStorage, queueFileDeletion } from '../src/lib/file-deletion';
import { deleteDesktopArtifacts, uploadDesktopArtifact, publishDesktopRelease, getDesktopArtifacts, getPublishedArtifact } from '../src/lib/desktop-releases';
import { storeBuffer, signedLocalObjectUrl } from '../src/lib/storage';
import { createClientSessionToken } from '../src/lib/client-auth';
import { POST as upload } from '../src/app/api/client/upload/route';
import { GET as readMedia } from '../src/app/api/uploads/file/[...key]/route';

const root = path.resolve(process.env.PROCTOR_UPLOAD_DIR!);
assert.ok(root.includes('/tmp/proctor-deletion-qa.'), 'Only disposable test files');
const marker = `delete-${randomUUID()}`, users: string[] = [], exams: string[] = [], assetIds: string[] = [];
const originalTransaction = prisma.$transaction.bind(prisma);
let localServer: ReturnType<typeof createServer> | undefined;
try {
  await mkdir(root, { recursive: true });
  const admin = await prisma.user.create({ data: { username: marker, role: 'SUPER_ADMIN' } }); users.push(admin.id);
  const owner = await prisma.user.create({ data: { username: marker + '-owner', role: 'ADMIN' } }); users.push(owner.id);
  const outsider = await prisma.user.create({ data: { username: marker + '-outsider', role: 'ADMIN' } }); users.push(outsider.id);
  const now = Date.now();
  async function exam(endAt = new Date(now - 60_000), createdById = owner.id) {
    const row = await prisma.exam.create({ data: { examCode: String(randomInt(1000000000, 10000000000)), name: marker,
      startAt: new Date(now - 3600_000), latestStartAt: new Date(now - 1800_000), endAt, durationMinutes: 60,
      platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker, contestType: 'INDIVIDUAL', rules: marker, createdById, saveFullRecording: true } });
    exams.push(row.id); return row;
  }
  const ended = await exam(), active = await exam(new Date(now + 3600_000)), other = await exam(new Date(now - 60_000), outsider.id);
  const candidate = await prisma.candidate.create({ data: { examId: ended.id, examNumber: marker, password: marker, seatNo: 'QA' } });
  const token = createClientSessionToken();
  const session = await prisma.clientSession.create({ data: { examId: ended.id, candidateId: candidate.id, desktopDeviceId: marker,
    desktopTokenHash: token.tokenHash, status: 'FINISHED', endedAt: new Date(now - 60_000), startedAt: new Date(now - 3600_000) } });
  async function clip(offset: number, channel: MediaChannel = 'DESKTOP_SCREEN') {
    const stored = await storeBuffer(Buffer.from(randomUUID()), { filename: randomUUID() + '.webm', prefix: `${ended.id}/${candidate.id}` });
    return prisma.mediaSegment.create({ data: { examId: ended.id, candidateId: candidate.id, sessionId: session.id, channel,
      objectPath: stored.objectPath, byteSize: 36, startedAt: new Date(now - 180_000 + offset), endedAt: new Date(now - 177_000 + offset) } });
  }
  const shared = await clip(0), sole = await clip(-19000), quiet = await clip(-100000, 'DESKTOP_CAMERA');
  const identity = await clip(0, 'IDENTITY_PHOTO'), room = await clip(0, 'ROOM_VIDEO');
  const a = await prisma.alert.create({ data: { examId: ended.id, candidateId: candidate.id, sessionId: session.id, type: 'PROCESS_POLICY', message: marker, createdAt: new Date(now - 180_000) } });
  const b = await prisma.alert.create({ data: { examId: ended.id, candidateId: candidate.id, sessionId: session.id, type: 'PROCESS_POLICY', message: marker, createdAt: new Date(now - 170_000) } });
  await assert.rejects(deleteRecordings(outsider, { examIds: [ended.id] }), /管理员/);
  await assert.rejects(deleteRecordings(owner, { examIds: [ended.id, other.id] }), /管理员/);
  await assert.rejects(deleteRecordings(owner, { examIds: [ended.id, active.id] }), /尚未结束/);
  assert.equal(await prisma.fileDeletionJob.count({ where: { examId: ended.id } }), 0);
  // Inject an outbox failure after business updates: a rollback must restore both.
  prisma.$transaction = ((operation: any, options: any) => originalTransaction(async tx => operation(new Proxy(tx, {
    get(target, key) { if (key === 'fileDeletionJob') return { ...target.fileDeletionJob, createMany: async () => { throw new Error('injected outbox failure'); } }; return Reflect.get(target, key); }
  })), options)) as typeof prisma.$transaction;
  await assert.rejects(deleteRecordings(owner, { alertIds: [a.id] }), /injected outbox/);
  prisma.$transaction = originalTransaction as typeof prisma.$transaction;
  assert.equal((await prisma.alert.findUniqueOrThrow({ where: { id: a.id } })).evidenceDeletedAt, null);
  assert.equal((await prisma.mediaSegment.findUniqueOrThrow({ where: { id: sole.id } })).deletedAt, null);
  assert.ok(await stat(path.join(root, sole.objectPath)));
  await Promise.all([deleteRecordings(owner, { alertIds: [a.id] }), deleteRecordings(owner, { alertIds: [a.id] })]);
  assert.equal(await prisma.fileDeletionJob.count({ where: { examId: ended.id } }), 1, 'duplicate concurrent deletes enqueue once');
  assert.equal((await prisma.mediaSegment.findUniqueOrThrow({ where: { id: shared.id } })).deletedAt, null, 'another incident still needs shared footage');
  const signed = new URL(signedLocalObjectUrl(sole.objectPath), 'http://localhost');
  assert.equal((await readMedia(new Request(signed), { params: Promise.resolve({ key: sole.objectPath.split('/') }) })).status, 404, 'committed tombstones deny stale signed links before physical cleanup');
  // Simulate a storage failure and worker restart; metadata stays consistently deleted.
  const outside = path.join(root, '..', 'protected-outside'); await writeFile(outside, 'do not delete');
  await rm(path.join(root, sole.objectPath)); await symlink(outside, path.join(root, sole.objectPath));
  await processFileDeletions({ examId: ended.id });
  const failed = await prisma.fileDeletionJob.findFirstOrThrow({ where: { examId: ended.id } });
  assert.ok(failed.lastError); assert.equal(failed.completedAt, null); assert.equal(await readFile(outside, 'utf8'), 'do not delete');
  await rm(path.join(root, sole.objectPath)); await writeFile(path.join(root, sole.objectPath), 'recovered');
  await prisma.fileDeletionJob.update({ where: { id: failed.id }, data: { nextAttemptAt: new Date() } });
  await Promise.all([processFileDeletions({ examId: ended.id }), processFileDeletions({ examId: ended.id })]);
  assert.ok((await prisma.fileDeletionJob.findUniqueOrThrow({ where: { id: failed.id } })).completedAt);
  await assert.rejects(stat(path.join(root, sole.objectPath)), /ENOENT/);
  // A file referenced by another exam must survive deletion of this exam.
  await prisma.mediaSegment.create({ data: { examId: other.id, channel: 'DESKTOP_SCREEN', objectPath: quiet.objectPath } });
  await deleteRecordings(owner, { examIds: [ended.id] });
  await processFileDeletions({ examId: ended.id });
  assert.ok((await prisma.exam.findUniqueOrThrow({ where: { id: ended.id } })).recordingsDeletedAt);
  assert.ok((await prisma.alert.findUniqueOrThrow({ where: { id: b.id } })).evidenceDeletedAt, 'alert audit log retained');
  assert.equal((await prisma.mediaSegment.findUniqueOrThrow({ where: { id: identity.id } })).deletedAt, null);
  assert.equal((await prisma.mediaSegment.findUniqueOrThrow({ where: { id: room.id } })).deletedAt, null);
  for (const protectedClip of [quiet, identity, room]) assert.ok(await stat(path.join(root, protectedClip.objectPath)));
  await assert.rejects(stat(path.join(root, shared.objectPath)), /ENOENT/);
  const bytes = await readFile(new URL('./fixtures/material-room.webm', import.meta.url));
  const form = new FormData(); form.append('file', new File([Uint8Array.from(bytes)], 'late.webm', { type: 'video/webm' }));
  for (const [key, value] of Object.entries({ sessionId: session.id, channel: 'DESKTOP_SCREEN', uploadId: 'late-after-deletion' })) form.append(key, value);
  const late = await upload(new Request('http://localhost/api/client/upload', { method: 'POST', headers: { 'x-proctor-session-token': token.token }, body: form }));
  assert.equal(late.status, 200); assert.equal((await late.json()).data.discarded, true);
  assert.equal(await prisma.mediaSegment.count({ where: { examId: ended.id, deletedAt: null, channel: 'DESKTOP_SCREEN' } }), 0);

  // Installer deletion uses the same outbox and protects the active release.
  const exe = Buffer.alloc(2048); exe.write('MZ'); exe.writeUInt32LE(128, 60); exe.write('PE\0\0', 128);
  async function asset(version: string) {
    const row = await uploadDesktopArtifact(new Request(`http://localhost/api/settings/desktop-releases/upload?target=windows&kind=installer&version=${version}`, {
      method: 'POST', headers: { 'content-length': String(exe.length) }, body: Uint8Array.from(exe) }), admin.id);
    assetIds.push(row.id); return row;
  }
  const old = await asset('9.1.0'), newer = await asset('9.2.0');
  const publish = (a: typeof old) => publishDesktopRelease({ target: 'windows', channel: 'public', version: a.version, installerId: a.id, updateId: a.id, notes: '', installationMode: 'manual' });
  await publish(old); await publish(newer);
  assert.equal((await getDesktopArtifacts()).find(a => a.id === old.id)?.status, 'historical');
  await assert.rejects(deleteDesktopArtifacts([old.id, newer.id], admin.id), /最新版/);
  assert.ok(await getPublishedArtifact(old.id + '.exe'), 'mixed batch rejects atomically');
  await Promise.all([deleteDesktopArtifacts([old.id], admin.id), deleteDesktopArtifacts([old.id], admin.id)]);
  assert.equal(await getPublishedArtifact(old.id + '.exe'), null);
  assert.equal(await prisma.fileDeletionJob.count({ where: { kind: 'INSTALLER', objectPath: old.id + '.exe' } }), 1);
  await processFileDeletions({ kind: 'INSTALLER' });
  await assert.rejects(stat(path.join(process.env.DESKTOP_RELEASE_DIR!, old.id + '.exe')), /ENOENT/);
  assert.ok(await stat(path.join(process.env.DESKTOP_RELEASE_DIR!, newer.id + '.exe')));

  // Object-storage failures remain durable, and retry can finish after recovery.
  let accept = false, calls = 0, hold = false;
  let release!: () => void, arrived!: () => void;
  localServer = createServer((req, res) => { assert.equal(req.method, 'DELETE'); calls++; if (hold) { release = () => { res.writeHead(204); res.end(); }; arrived(); } else { res.writeHead(accept ? 204 : 403); res.end(); } });
  await new Promise<void>(resolve => localServer!.listen(0, '127.0.0.1', resolve));
  const port = (localServer.address() as { port: number }).port;
  const storage = deletionStorage({ provider: 'S3', localUploadDir: root, s3: { endpoint: `http://127.0.0.1:${port}`, bucket: 'qa', accessKeyId: 'qa', secretAccessKey: 'qa', region: 'us-east-1', forcePathStyle: true } });
  await prisma.$transaction(async tx => queueFileDeletion(tx, { kind: 'MEDIA', examId: other.id, objectPath: 'qa/object.webm', storage, requestedById: admin.id }));
  await processFileDeletions({ examId: other.id });
  const s3 = await prisma.fileDeletionJob.findFirstOrThrow({ where: { objectPath: 'qa/object.webm' } }); assert.ok(s3.lastError); assert.equal(s3.completedAt, null);
  accept = true; await prisma.fileDeletionJob.update({ where: { id: s3.id }, data: { nextAttemptAt: new Date() } });
  await processFileDeletions({ examId: other.id });
  assert.ok((await prisma.fileDeletionJob.findUniqueOrThrow({ where: { id: s3.id } })).completedAt); assert.equal(calls, 2);
  // A late upload can recreate a file after the old worker deleted it. Requeue
  // invalidates the old lease so its late acknowledgement cannot lose cleanup.
  const racingKey = 'qa/recreated.webm';
  await prisma.$transaction(tx => queueFileDeletion(tx, { kind: 'MEDIA', examId: other.id, objectPath: racingKey, storage, requestedById: admin.id }));
  hold = true;
  const requestArrived = new Promise<void>(resolve => { arrived = resolve; });
  const oldWorker = processFileDeletions({ objectPath: racingKey });
  await requestArrived;
  await prisma.$transaction(tx => queueFileDeletion(tx, { kind: 'MEDIA', examId: other.id, objectPath: racingKey, storage, requestedById: admin.id }, true));
  release(); await oldWorker;
  assert.equal((await prisma.fileDeletionJob.findFirstOrThrow({ where: { objectPath: racingKey } })).completedAt, null, 'stale worker must not acknowledge the renewed task');
  hold = false; await processFileDeletions({ objectPath: racingKey });
  assert.ok((await prisma.fileDeletionJob.findFirstOrThrow({ where: { objectPath: racingKey } })).completedAt);
  console.log('PASS: transactional rollback; authorization; active release/exam protection; shared evidence; concurrent deletes and workers; durable local/S3 failures and retry; signed-link revocation; late upload suppression; whole-exam cleanup preserves identity and audit records.');
} finally {
  prisma.$transaction = originalTransaction as typeof prisma.$transaction;
  localServer?.close();
  await prisma.fileDeletionJob.deleteMany({ where: { requestedById: { in: [...users, 'client-upload'] } } });
  await prisma.systemSetting.deleteMany({ where: { OR: [{ key: { in: assetIds.flatMap(id => ['desktop.asset.' + id, 'desktop.published.' + id]) } }, { key: 'desktop.active.unified.windows' }] } });
  await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
}
