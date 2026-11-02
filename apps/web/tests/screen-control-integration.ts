// Run against a local database: pnpm exec tsx --env-file=.env tests/screen-control-integration.ts
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { canManageExam } from '../src/lib/permissions';
import { normalizeScreenControlImage, removeScreenControlImage } from '../src/lib/screen-control-images';
import { storeBuffer } from '../src/lib/storage';
import {
  cancelScreenControlDisplay, createScreenControlDisplay, createScreenControlGroup, deleteScreenControlGroup,
  getAdminScreenControl, getClientScreenControl, stopScreenControlDisplay, updateScreenControlGroup,
} from '../src/lib/screen-control';
import { GET as getClientState } from '../src/app/api/client/screen-control/route';
import { GET as getClientImage } from '../src/app/api/client/screen-control/images/[imageId]/route';

const marker = `screen-qa-${randomUUID()}`;
const exams: string[] = [];
const users: string[] = [];
const uploads: string[] = [];
async function newExam(ownerId: string) {
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1000000000, 10000000000)), name: marker, createdById: ownerId,
    startAt: new Date('2099-01-01'), latestStartAt: new Date('2099-01-01'), endAt: new Date('2099-01-02'),
    durationMinutes: 120, platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker,
    contestType: 'INDIVIDUAL', rules: 'Screen control integration', requireMiniProgram: false,
  } });
  exams.push(exam.id);
  return exam;
}
const clientRequest = (sessionId: string, token: string, imageId?: string) => new Request(
  `http://localhost/api/client/screen-control${imageId ? `/images/${imageId}` : ''}?sessionId=${sessionId}`,
  { headers: { 'x-proctor-session-token': token } },
);
try {
  const owner = await prisma.user.create({ data: { username: `${marker}-owner`, role: 'ADMIN' } }); users.push(owner.id);
  const proctor = await prisma.user.create({ data: { username: `${marker}-proctor`, role: 'ADMIN' } }); users.push(proctor.id);
  const exam = await newExam(owner.id);
  const otherExam = await newExam(owner.id);
  const candidate = await prisma.candidate.create({ data: { examId: exam.id, examNumber: marker, password: marker, seatNo: '1' } });
  const otherCandidate = await prisma.candidate.create({ data: { examId: otherExam.id, examNumber: marker, password: marker, seatNo: '1' } });
  await prisma.examRoom.create({ data: { examId: exam.id, name: marker, proctors: { create: { userId: proctor.id } } } });
  assert.equal(await canManageExam(owner, exam.id), true);
  assert.equal(await canManageExam(proctor, exam.id), false, 'room proctors cannot control the whole exam');

  const token = createClientSessionToken();
  const miniToken = createClientSessionToken();
  const otherToken = createClientSessionToken();
  const session = await prisma.clientSession.create({ data: { examId: exam.id, candidateId: candidate.id,
    status: 'WAITING_REVIEW', desktopTokenHash: token.tokenHash, miniProgramTokenHash: miniToken.tokenHash } });
  const otherSession = await prisma.clientSession.create({ data: { examId: otherExam.id, candidateId: otherCandidate.id,
    status: 'APPROVED', desktopTokenHash: otherToken.tokenHash } });
  assert.equal((await getClientState(clientRequest(session.id, 'wrong'))).status, 401);
  assert.equal((await getClientState(clientRequest(session.id, miniToken.token))).status, 401);

  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#246' } }).png().toBuffer();
  const normalized = await normalizeScreenControlImage(bytes);
  const stored = await storeBuffer(normalized.buffer, { filename: `${marker}.webp`, prefix: `screen-control/${exam.id}`, contentType: normalized.contentType });
  uploads.push(stored.objectPath);
  const { buffer: _buffer, ...metadata } = normalized;
  const image = { name: '规则.png', objectPath: stored.objectPath, ...metadata };
  const first = await createScreenControlGroup(exam.id, '规则', [image, { ...image, name: '注意事项.png' }], owner.id);
  const second = await createScreenControlGroup(exam.id, '开赛', [image], owner.id);
  const reordered = await updateScreenControlGroup(exam.id, first.id, { name: '比赛规则', imageIds: first.images.map(item => item.id).reverse() });
  assert.equal(reordered.name, '比赛规则');
  assert.deepEqual(reordered.images.map(item => item.id), first.images.map(item => item.id).reverse());
  await assert.rejects(updateScreenControlGroup(exam.id, first.id, { imageIds: [first.images[0].id, second.images[0].id] }), /全部图片/);
  await assert.rejects(createScreenControlDisplay(otherExam.id, { groupId: first.id }, owner.id), /有效图片组/);

  const immediate = await createScreenControlDisplay(exam.id, { groupId: first.id, endsAt: new Date(Date.now() + 300_000).toISOString() }, owner.id);
  const stateResponse = await getClientState(clientRequest(session.id, token.token));
  assert.equal(stateResponse.status, 200);
  assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
  const state = (await stateResponse.json()).data;
  assert.equal(state.active.id, immediate.id, 'unreviewed candidates receive a pre-exam push');
  assert.equal(state.active.intervalMs, 5_000);
  assert.equal(state.active.images[0].url, `/api/client/screen-control/images/${reordered.images[0].id}?sessionId=${session.id}`);
  assert.equal(state.active.images[0].objectPath, undefined);
  assert.equal(state.desktopTokenHash, undefined);
  const imageResponse = await getClientImage(clientRequest(session.id, token.token, reordered.images[0].id), { params: Promise.resolve({ imageId: reordered.images[0].id }) });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), normalized.buffer);
  assert.equal((await getClientImage(clientRequest(session.id, 'wrong', reordered.images[0].id), { params: Promise.resolve({ imageId: reordered.images[0].id }) })).status, 401);
  assert.equal((await getClientImage(clientRequest(otherSession.id, otherToken.token, reordered.images[0].id), { params: Promise.resolve({ imageId: reordered.images[0].id }) })).status, 403);
  assert.equal((await getClientImage(clientRequest(session.id, token.token, second.images[0].id), { params: Promise.resolve({ imageId: second.images[0].id }) })).status, 403);
  await assert.rejects(updateScreenControlGroup(exam.id, first.id, { name: 'locked' }), /正在展示/);
  await assert.rejects(deleteScreenControlGroup(exam.id, first.id), /正在展示/);

  // Exam and session phases never override the separate administrator display.
  await prisma.exam.update({ where: { id: exam.id }, data: { endAt: new Date(Date.now() - 1_000) } });
  await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'FINISHED' } });
  assert.equal((await (await getClientState(clientRequest(session.id, token.token))).json()).data.active.id, immediate.id);
  const laterSession = await prisma.clientSession.create({ data: { examId: exam.id, candidateId: candidate.id,
    status: 'APPROVED', desktopTokenHash: token.tokenHash } });
  assert.equal((await (await getClientState(clientRequest(laterSession.id, token.token))).json()).data.active.id, immediate.id, 'later logins inherit the current display');

  const startsAt = new Date(Date.now() + 30_000).toISOString();
  const endsAt = new Date(Date.now() + 60_000).toISOString();
  const schedule = await createScreenControlDisplay(exam.id, { groupId: second.id, startsAt, endsAt }, owner.id);
  assert.equal((await getClientScreenControl(exam.id, session.id)).active?.id, immediate.id);
  assert.equal((await getClientScreenControl(exam.id, session.id)).nextStartsAt, startsAt);
  assert.equal((await getClientScreenControl(exam.id, session.id, new Date(startsAt))).active?.id, schedule.id);
  assert.equal((await getClientScreenControl(exam.id, session.id, new Date(endsAt))).active, null, 'deadline does not resume the previous group');
  await assert.rejects(deleteScreenControlGroup(exam.id, second.id), /定时展示/);
  await cancelScreenControlDisplay(exam.id, schedule.id);
  assert.equal((await getClientScreenControl(exam.id, session.id, new Date(endsAt))).active?.id, immediate.id, 'canceled future plans never supersede the display');
  assert.equal((await getAdminScreenControl(exam.id)).schedules.length, 0);
  await assert.rejects(stopScreenControlDisplay(exam.id, 'stale-display-id'), /已发生变化/);
  await stopScreenControlDisplay(exam.id, immediate.id);
  assert.equal((await getClientScreenControl(exam.id, session.id)).active, null);

  const concurrent = await Promise.all([
    createScreenControlDisplay(exam.id, { groupId: first.id }, owner.id),
    createScreenControlDisplay(exam.id, { groupId: second.id }, owner.id),
    createScreenControlDisplay(exam.id, { groupId: first.id }, owner.id),
  ]);
  const current = (await getClientScreenControl(exam.id, session.id)).active!;
  assert.ok(concurrent.some(item => item.id === current.id));
  const persisted = await prisma.screenControlDisplay.findMany({ where: { id: { in: concurrent.map(item => item.id) }, stoppedAt: null } });
  assert.equal(persisted.length, 1, 'concurrent pushes have a single active winner');
  assert.equal(persisted[0].id, current.id);
  await stopScreenControlDisplay(exam.id, current.id);
  await deleteScreenControlGroup(exam.id, first.id);
  assert.equal((await getAdminScreenControl(exam.id)).groups.some(item => item.id === first.id), false);
  await assert.rejects(createScreenControlDisplay(exam.id, { groupId: first.id }, owner.id), /有效图片组/);
  console.log('PASS: actual MySQL screen control groups/order; permissions; candidate image/token/exam isolation; pre-exam/finished/later logins; immediate push/stop; timed start/deadline/cancel; no resume; concurrent pushes; group deletion.');
} finally {
  await prisma.screenControlDisplay.deleteMany({ where: { examId: { in: exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await Promise.allSettled(uploads.map(removeScreenControlImage));
  await prisma.$disconnect();
}
