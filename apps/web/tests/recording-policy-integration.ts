// Uses only disposable exam records, test video and a LOCAL upload store.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { POST as upload } from '../src/app/api/client/upload/route';
import { POST as heartbeat } from '../src/app/api/client/heartbeat/route';
import { getStorageSettings } from '../src/lib/settings';
import { processFileDeletions } from '../src/lib/file-deletion';

if (!process.env.DATABASE_URL?.includes('/proctor_recording_qa')) throw new Error('Use the isolated recording fixture database.');
const marker = `recording-policy-${randomUUID()}`;
let examId = '', root = '';
try {
  const settings = await getStorageSettings();
  assert.equal(settings.provider, 'LOCAL');
  root = path.resolve(process.cwd(), settings.localUploadDir);
  const now = Date.now();
  const exam = await prisma.exam.create({ data: { examCode: String(randomInt(1000000000, 10000000000)), name: marker,
    startAt: new Date(now - 300000), latestStartAt: new Date(now + 3600000), endAt: new Date(now + 7200000), durationMinutes: 120,
    platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker, contestType: 'INDIVIDUAL', rules: marker, requireMiniProgram: false, requireFrontCamera: true } });
  examId = exam.id;
  assert.equal(exam.saveFullRecording, false);
  assert.equal(exam.saveIncidentRecording, false);
  const candidate = await prisma.candidate.create({ data: { examId, examNumber: marker, password: marker, seatNo: 'QA' } });
  const desktop = createClientSessionToken(), mobile = createClientSessionToken();
  const session = await prisma.clientSession.create({ data: { examId, candidateId: candidate.id, desktopDeviceId: marker,
    desktopTokenHash: desktop.tokenHash, miniProgramTokenHash: mobile.tokenHash, startedAt: new Date(now - 120000), status: 'IN_EXAM' } });
  const bytes = await readFile(new URL('./fixtures/material-room.webm', import.meta.url));
  async function clip(channel: string, uploadId: string, evidenceOnly = false, offset = -10000) {
    const form = new FormData();
    form.append('file', new File([Uint8Array.from(bytes)], 'clip.webm', { type: 'video/webm' }));
    for (const [key, value] of Object.entries({ sessionId: session.id, channel, uploadId, evidenceOnly: String(evidenceOnly),
      startedAt: new Date(now + offset).toISOString(), endedAt: new Date(now + offset + 3500).toISOString() })) form.append(key, value);
    const result = await upload(new Request('http://localhost/api/client/upload', { method: 'POST',
      headers: { 'x-proctor-session-token': channel === 'MOBILE_CAMERA' ? mobile.token : desktop.token }, body: form }));
    return { status: result.status, body: await result.json() };
  }
  const normal = await clip('DESKTOP_SCREEN', 'normal');
  assert.equal(normal.status, 200); assert.equal(normal.body.data.discarded, true);
  for (const channel of ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA', 'EVIDENCE_CLIP']) {
    const result = await clip(channel, `disabled-${channel}`, true);
    assert.equal(result.status, 200); assert.equal(result.body.data.discarded, true);
  }
  assert.equal(await prisma.mediaSegment.count({ where: { examId } }), 0);
  const files = () => readdir(path.join(root, examId, candidate.id)).catch(() => []);
  assert.equal((await files()).length, 0);
  await prisma.exam.update({ where: { id: examId }, data: { saveIncidentRecording: true } });
  assert.equal((await clip('DESKTOP_SCREEN', 'waiting-incident', true)).status, 409);
  await prisma.alert.create({ data: { examId, candidateId: candidate.id, sessionId: session.id, type: 'PROCESS_POLICY', message: marker, createdAt: new Date(now) } });
  assert.equal((await clip('DESKTOP_SCREEN', 'waiting-incident', true)).status, 201);
  const duplicate = await clip('DESKTOP_SCREEN', 'waiting-incident', true);
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.data.duplicate, true);
  assert.equal((await clip('DESKTOP_CAMERA', 'unrelated-camera')).body.data.discarded, true);
  assert.equal((await clip('DESKTOP_SCREEN', 'outside-window', true, -120000)).status, 409);
  const other = await prisma.clientSession.create({ data: { examId, candidateId: candidate.id, desktopDeviceId: `${marker}-other` } });
  await prisma.alert.create({ data: { examId, sessionId: other.id, type: 'PROCESS_POLICY', message: marker, createdAt: new Date(now - 120000) } });
  assert.equal((await clip('DESKTOP_SCREEN', 'other-session-window', true, -125000)).status, 409);
  await prisma.alert.create({ data: { examId, candidateId: candidate.id, sessionId: session.id, type: 'SECOND_CAMERA_OFFLINE', message: marker, createdAt: new Date(now) } });
  assert.equal((await clip('MOBILE_CAMERA', 'mobile-incident', true)).status, 201);
  assert.equal(await prisma.mediaSegment.count({ where: { examId } }), 2);
  assert.equal((await files()).length, 2);
  const beat = () => heartbeat(new Request('http://localhost/api/client/heartbeat', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proctor-session-token': desktop.token }, body: JSON.stringify({ sessionId: session.id, deviceId: marker, side: 'DESKTOP' }) }));
  const incidentBody = (await (await beat()).json()).data;
  assert.equal(incidentBody.requirements.saveIncidentRecording, true);
  assert.ok(incidentBody.recordingEvents.some((event: { channel: string }) => event.channel === 'DESKTOP_SCREEN'));
  assert.ok(incidentBody.recordingEvents.some((event: { channel: string }) => event.channel === 'MOBILE_CAMERA'));
  await prisma.exam.update({ where: { id: examId }, data: { saveFullRecording: true, saveIncidentRecording: false } });
  assert.equal((await clip('DESKTOP_CAMERA', 'full-camera', false, -240000)).status, 201);
  const full = await beat();
  assert.equal(full.status, 200);
  const fullBody = (await full.json()).data;
  assert.equal(fullBody.requirements.saveFullRecording, true);
  assert.equal(fullBody.requirements.saveIncidentRecording, false);
  assert.deepEqual(fullBody.recordingEvents, []);
  await prisma.exam.update({ where: { id: examId }, data: { saveFullRecording: false } });
  assert.equal((await clip('DESKTOP_CAMERA', 'disabled-camera')).body.data.discarded, true);
  assert.equal((await clip('DESKTOP_SCREEN', 'disabled-matching-incident', true)).body.data.discarded, true);
  assert.equal((await clip('MOBILE_CAMERA', 'disabled-matching-mobile', true)).body.data.discarded, true);
  assert.equal((await clip('EVIDENCE_CLIP', 'disabled-legacy-video', true)).body.data.discarded, true);
  const off = await beat();
  const offBody = (await off.json()).data;
  assert.equal(offBody.requirements.saveFullRecording, false);
  assert.equal(offBody.requirements.saveIncidentRecording, false);
  assert.deepEqual(offBody.recordingEvents, []);
  assert.equal(await prisma.mediaSegment.count({ where: { examId } }), 3);
  assert.equal((await files()).length, 3);
  const photo = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const form = new FormData();
  form.append('file', new File([Uint8Array.from(photo)], 'evidence.jpg', { type: 'image/jpeg' }));
  form.append('sessionId', session.id); form.append('channel', 'EVIDENCE_CLIP');
  assert.equal((await upload(new Request('http://localhost/api/client/upload', { method: 'POST', headers: { 'x-proctor-session-token': desktop.token }, body: form }))).status, 201, 'screenshot evidence remains available when video recording is disabled');
  await prisma.exam.update({ where: { id: examId }, data: { saveFullRecording: true } });
  const findExam = prisma.exam.findUnique;
  let disabledDuringUpload = false;
  prisma.exam.findUnique = (async (args: any) => {
    const result = await findExam.call(prisma.exam, args);
    if (args.select?.saveFullRecording && !disabledDuringUpload) {
      disabledDuringUpload = true;
      await prisma.exam.update({ where: { id: examId }, data: { saveFullRecording: false } });
    }
    return result;
  }) as typeof findExam;
  try {
    const raced = await clip('DESKTOP_CAMERA', 'disabled-during-upload');
    assert.equal(raced.status, 200); assert.equal(raced.body.data.discarded, true);
    assert.equal(raced.body.data.reason, 'disabled');
    assert.equal(await prisma.mediaSegment.count({ where: { examId } }), 4);
    assert.equal(await prisma.fileDeletionJob.count({ where: { examId, completedAt: null } }), 1);
  } finally { prisma.exam.findUnique = findExam; }
  await processFileDeletions({ examId });
  assert.equal((await files()).length, 4, 'a disabled in-flight upload leaves no unreferenced video');
  await prisma.exam.update({ where: { id: examId }, data: { saveIncidentRecording: true } });
  await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'FINISHED', endedAt: new Date() } });
  const finishedBody = (await (await beat()).json()).data;
  assert.equal(finishedBody.requirements.saveIncidentRecording, true);
  assert.ok(finishedBody.recordingEvents.length > 0, 'the final heartbeat retains enabled incident windows for queued tail clips');
  console.log(JSON.stringify({ ok: true, unselectedIncidentStored: false, incidentChannelsIsolated: true, retriesDeduplicated: true,
    recordingTogglesSynced: true, screenshotEvidencePreserved: true, disabledUploadCleaned: true }));
} finally {
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  if (root && examId) await rm(path.join(root, examId), { recursive: true, force: true });
  await prisma.$disconnect();
}
