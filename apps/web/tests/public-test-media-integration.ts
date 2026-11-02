// Explicit local integration check: publishes synthetic patterns, never personal camera footage.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { prisma } from '../src/lib/db';
import { ensurePublicTestExam, cleanupPublicTestState } from '../src/lib/public-test';
import { createMediaPublishToken } from '../src/lib/media-publish-token';
import { hashClientSessionToken } from '../src/lib/client-auth';
import { liveChannels } from '../src/lib/media-read-token';
import { testMediaState } from '../src/lib/test-media-state';
import { requestHydroLanguages } from '../src/lib/hydro-contest';
import { languageFamily } from '../src/lib/exam-languages';

const desktopToken = randomBytes(32).toString('base64url');
const mobileToken = randomBytes(32).toString('base64url');
const publishers: ChildProcess[] = [];
let candidateId: string | undefined;
const diagnostics: string[] = [];
const sockets = new Set<Socket>();
// macOS static FFmpeg uses the system certificate store. This test-only loopback bridge
// verifies the development certificate explicitly without changing the user's trust store.
const proxy = createServer();
try {
  const examId = await ensurePublicTestExam();
  const room = await prisma.examRoom.findFirstOrThrow({ where: { examId, requireSecondCamera: true } });
  const candidate = await prisma.candidate.create({ data: { examId, name: '合成推流测试', examNumber: `TEST${randomUUID()}`, password: randomBytes(32).toString('base64url'), seatNo: '测试', ranked: false, rooms: { create: { roomId: room.id } } } });
  candidateId = candidate.id;
  const session = await prisma.clientSession.create({ data: {
    id: `test_${randomUUID()}`, examId, candidateId, status: 'APPROVED', approvedAt: new Date(),
    desktopDeviceId: 'synthetic-media-desktop', miniProgramDeviceId: 'synthetic-media-mobile',
    desktopTokenHash: hashClientSessionToken(desktopToken), miniProgramTokenHash: hashClientSessionToken(mobileToken),
    lastDesktopSeenAt: new Date(), lastMiniProgramSeenAt: new Date(),
  } });
  assert.equal((await testMediaState(session.id)).every(channel => !channel.ready), true);
  const binary = process.env.PROCTOR_TEST_FFMPEG || path.resolve('../desktop/build/ffmpeg/darwin-arm64/ffmpeg');
  const certificate = process.env.PROCTOR_TEST_MEDIA_CA || '/tmp/cwnupaa-proctor-dev-cert.pem';
  const ca = await readFile(certificate);
  proxy.on('connection', socket => {
    const encrypted = connectTls({ host: 'localhost', port: 1936, servername: 'localhost', ca, rejectUnauthorized: true });
    sockets.add(socket); sockets.add(encrypted);
    socket.on('error', () => encrypted.destroy());
    encrypted.on('error', error => { diagnostics.push(error.message); socket.destroy(); });
    socket.pipe(encrypted).pipe(socket);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  for (const channel of liveChannels) {
    const { token } = createMediaPublishToken(session, channel);
    const url = `rtmp://127.0.0.1:${address.port}/live/${session.id}_${channel}?token=${encodeURIComponent(token)}`;
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10',
      '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-f', 'flv', url], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', data => diagnostics.push(String(data).replaceAll(token, '[redacted]')));
    publishers.push(child);
  }
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const channels = await testMediaState(session.id);
    if (channels.every(channel => channel.ready)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(ready, true, `Synthetic streams failed: ${diagnostics.join('').slice(-1500)}`);
  const started = await fetch('http://localhost:4031/api/client/session/start', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': desktopToken },
    body: JSON.stringify({ sessionId: session.id, confirm: true }),
  });
  assert.equal(started.status, 200, JSON.stringify(await started.json()));
  const language = (await requestHydroLanguages()).find(item => languageFamily(item.id) === 'python');
  assert.ok(language, 'Python judge language is required for this integration fixture');
  const submitted = await fetch('http://localhost:4031/api/client/contest/submit', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': desktopToken },
    body: JSON.stringify({ sessionId: session.id, pid: 1, lang: language.id, code: 'a, b = map(int, input().split())\nprint(a + b)\n' }),
  });
  const submissionResult = await submitted.json();
  assert.equal(submitted.status, 201, JSON.stringify(submissionResult));
  const submissionId = submissionResult.data.submissionId;
  let judged = await prisma.contestSubmission.findUniqueOrThrow({ where: { id: submissionId } });
  for (let attempt = 0; attempt < 100 && !judged.judgeAt; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    judged = await prisma.contestSubmission.findUniqueOrThrow({ where: { id: submissionId } });
  }
  assert.equal(judged.status, 1, judged.judgeError || judged.statusText || 'Judging timed out');
  assert.equal(judged.score, 100); assert.equal(judged.passedTestCases, 5);
  assert.equal(await prisma.mediaSegment.count({ where: { sessionId: session.id } }), 0);
  assert.equal(await prisma.alert.count({ where: { sessionId: session.id } }), 0);
  await prisma.candidate.update({ where: { id: candidateId }, data: { status: 'FINISHED', updatedAt: new Date(Date.now() - 120_000) } });
  await cleanupPublicTestState();
  assert.equal(await prisma.candidate.findUnique({ where: { id: candidateId } }), null);
  assert.equal(await prisma.clientSession.findUnique({ where: { id: session.id } }), null);
  assert.equal(await prisma.contestSubmission.findUnique({ where: { id: submissionId } }), null);
  console.log('PASS: three TLS-verified synthetic streams received, real start gate and A+B submission API passed (Accepted, 100, 5 cases), no media/events saved, temporary session/submission purged.');
} finally {
  for (const child of publishers) if (child.exitCode === null) child.kill('SIGTERM');
  for (const socket of sockets) socket.destroy();
  proxy.close();
  if (candidateId) await prisma.candidate.deleteMany({ where: { id: candidateId } });
  await prisma.$disconnect();
}
