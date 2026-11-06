/**
 * Real local NovaJudge HTTP/CCS/go-judge + authenticated MediaMTX WHIP/WHEP.
 * Media is explicitly synthetic; this does not certify a physical webcam/Electron installation.
 * Run only against a dedicated local reaction_e2e database. No production records are touched.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright-core';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { createSessionToken } from '../src/lib/auth';
import { digestPasswordForStorage } from '../src/lib/password-crypto';
import { generateLiveApiKey, liveApiKeyHash } from '../src/lib/live-api-key';

const run = promisify(execFile);
const base = (process.env.REACTION_E2E_URL || 'http://localhost:4031').replace(/\/$/, '');
const local = path.resolve('.local/reaction-e2e');
const output = path.resolve(process.env.REACTION_E2E_OUTPUT || path.join(local, 'artifacts'));
const fixturePath = path.join(local, 'fixture.private.json');
const novaFixturePath = process.env.NOVAJUDGE_E2E_FIXTURE;
assert(novaFixturePath, 'Set NOVAJUDGE_E2E_FIXTURE to the explicit private NovaJudge test fixture');
const mode = process.argv[2] || 'full';
const report: any = { startedAt: new Date().toISOString(), mediaKind: 'SIMULATED_CANVAS_VIA_AUTHENTICATED_MEDIAMTX', physicalClient: 'NOT_RUN_BY_THIS_SCRIPT: physical webcam/Electron validation is reported separately', checks: [], artifacts: [] };
let browser: Browser | undefined;
let feedAbort: AbortController | undefined;
let feedTask: Promise<void> | undefined;
let publisher: any;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatCapture: { screenOk?: boolean; desktopCameraOk?: boolean } = {};
const feedEvents: any[] = [];
const secretValues = new Set<string>();
const redact = (text: string) => [...secretValues].filter(Boolean).reduce((value, secret) => value.split(secret).join('[redacted]'), text);
function check(name: string, evidence: unknown) { report.checks.push({ name, result: 'PASS', evidence }); console.log('PASS ' + name); }
async function waitFor<T>(read: () => Promise<T | null | false>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(1000); }
  throw new Error('Timed out: ' + label);
}
async function jsonRequest(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (data.message || data.error || 'request failed'));
  return data;
}
async function fixture() {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Only localhost is allowed');
  const db = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname) && /^\/reaction_e2e(?:_|$)/.test(db.pathname), 'Dedicated local reaction_e2e database required');
  const nova = JSON.parse(await fs.readFile(novaFixturePath!, 'utf8'));
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(nova.base).hostname), 'Local NovaJudge test origin required');
  assert(process.env.REACTION_CCS_ORIGIN === nova.base && process.env.REACTION_CCS_USERNAME === nova.adminUsername && process.env.REACTION_CCS_PASSWORD === nova.adminPassword, 'Configure matching test CCS credentials in Web and Recorder, then restart both before E2E');
  for (const key of ['adminPassword', 'teamPassword', 'apiKey']) secretValues.add(nova[key]);
  const ccsContest = await jsonRequest(nova.base + '/api/ccs/contests/' + nova.contestId, { headers: { Authorization: 'Basic ' + Buffer.from(nova.adminUsername + ':' + nova.adminPassword).toString('base64') } });
  const contestStart = new Date(ccsContest.start_time), contestEnd = new Date(ccsContest.end_time);
  assert(Number.isFinite(+contestStart) && Number.isFinite(+contestEnd) && +contestEnd > Date.now(), 'The dedicated NovaJudge contest must be running');
  const durationMinutes = Math.ceil((+contestEnd - +contestStart) / 60000);
  await fs.mkdir(local, { recursive: true }); await fs.mkdir(output, { recursive: true });
  try {
    const old = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    const exam = await prisma.exam.findUnique({ where: { id: old.examId } });
    if (exam?.name === 'Reaction E2E local acceptance' && exam.platformContestId === String(nova.contestId)) {
      await prisma.exam.update({ where: { id: exam.id }, data: { startAt: contestStart, endAt: contestEnd, durationMinutes, platformBaseUrl: nova.base } });
      const admin = await prisma.user.findUniqueOrThrow({ where: { id: old.adminId } });
      assert(admin.username?.startsWith('reaction-e2e-'), 'Fixture administrator must be test-owned');
      if (!await bcrypt.compare(digestPasswordForStorage(old.adminPassword), admin.passwordHash || '')) await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: await bcrypt.hash(digestPasswordForStorage(old.adminPassword), 12) } });
      old.adminToken = createSessionToken(admin);
      const oldSession = await prisma.clientSession.findUnique({ where: { id: old.sessionId } });
      old.deviceId ||= 'reaction-e2e-' + randomBytes(12).toString('hex');
      if (!oldSession || oldSession.revokedAt || oldSession.status === 'FINISHED' || (oldSession.lastDesktopSeenAt || oldSession.createdAt).getTime() < Date.now() - 110000) {
        const issued = createClientSessionToken();
        const fresh = await prisma.clientSession.create({ data: { examId: exam.id, candidateId: old.candidateId, desktopDeviceId: old.deviceId, status: 'IN_EXAM', startedAt: new Date(), approvedAt: new Date(), lastDesktopSeenAt: new Date(), desktopTokenHash: issued.tokenHash } });
        old.sessionId = fresh.id; old.clientToken = issued.token;
      } else if (!oldSession.desktopDeviceId) await prisma.clientSession.update({ where: { id: oldSession.id }, data: { desktopDeviceId: old.deviceId } });
      await prisma.candidate.update({ where: { id: old.candidateId }, data: { status: 'ONLINE_NORMAL', startedAt: new Date() } });
      await fs.writeFile(fixturePath, JSON.stringify(old, null, 2));
      [old.adminToken, old.clientToken, old.liveKey, old.adminPassword].forEach(value => secretValues.add(value));
      return { ...old, nova };
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const password = randomBytes(24).toString('base64url');
  const admin = await prisma.user.create({ data: { username: 'reaction-e2e-' + randomBytes(4).toString('hex'), role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(digestPasswordForStorage(password), 12), realName: 'Reaction E2E Administrator' } });
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: 'Reaction E2E local acceptance',
    startAt: contestStart, latestStartAt: new Date(Math.min(+contestEnd, Date.now() + 3600000)), endAt: contestEnd, durationMinutes,
    platform: 'NOVAJUDGE', platformBaseUrl: nova.base, platformContestId: String(nova.contestId), novaJudgeApiKey: nova.apiKey,
    contestType: 'TEAM', teamAccountMode: 'TEAM_ACCOUNT', contestRule: 'ACM', published: true, rules: 'Isolated synthetic-media Reaction acceptance',
    requireMiniProgram: false, requireFrontCamera: true, saveFullRecording: false, saveIncidentRecording: false, createdById: admin.id,
    administrators: { create: { userId: admin.id } }
  } });
  const room = await prisma.examRoom.create({ data: { examId: exam.id, name: 'Reaction synthetic media room', requireFrontCamera: true, requireSecondCamera: false } });
  const candidate = await prisma.candidate.create({ data: { examId: exam.id, examNumber: nova.teamUsername, password: nova.teamPassword, name: 'Reaction Test Team', teamName: 'Reaction Test Team', school: 'Test University', seatNo: '007', status: 'ONLINE_NORMAL', rooms: { create: { roomId: room.id } } } });
  const token = createClientSessionToken();
  const deviceId = 'reaction-e2e-' + randomBytes(12).toString('hex');
  const session = await prisma.clientSession.create({ data: { examId: exam.id, candidateId: candidate.id, desktopDeviceId: deviceId, status: 'IN_EXAM', startedAt: new Date(), approvedAt: new Date(), lastDesktopSeenAt: new Date(), desktopTokenHash: token.tokenHash } });
  const liveKey = generateLiveApiKey();
  await prisma.liveApiKey.create({ data: { name: 'Reaction E2E only', keyHash: liveApiKeyHash(liveKey), keyPrefix: liveKey.slice(0, 12) } });
  const data = { examId: exam.id, examCode: exam.examCode, candidateId: candidate.id, sessionId: session.id, deviceId, adminId: admin.id, adminUsername: admin.username, adminPassword: password, adminToken: createSessionToken(admin), clientToken: token.token, liveKey };
  await fs.writeFile(fixturePath, JSON.stringify(data, null, 2));
  [data.adminToken, data.clientToken, data.liveKey, password].forEach(value => secretValues.add(value));
  return { ...data, nova };
}
async function main() {
  const f = await fixture();
  report.fixture = { examId: f.examId, examCode: f.examCode, candidate: f.nova.teamUsername, novaContestId: f.nova.contestId };
  if (mode === 'fixture') { console.log(JSON.stringify(report.fixture)); return; }
  const heartbeat = async () => jsonRequest(base + '/api/client/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-proctor-session-token': f.clientToken }, body: JSON.stringify({ sessionId: f.sessionId, deviceId: f.deviceId, side: 'DESKTOP', capture: heartbeatCapture }) });
  await heartbeat();
  heartbeatTimer = setInterval(() => { void heartbeat().catch(error => { report.heartbeatError = redact(error.message); }); }, 5000);
  const headers = { Cookie: 'cwnupaa_proctor_session=' + f.adminToken, Origin: base, 'Content-Type': 'application/json' };
  const endpoint = base + '/api/exams/' + f.examId + '/reactions';
  const api = async (url: string, options: RequestInit = {}) => (await jsonRequest(url, { ...options, headers: { ...headers, ...options.headers } })).data;
  assert.equal((await fetch(base)).status, 200); check('Proctoring HTTP/database', base);
  assert.equal((await fetch(f.nova.base)).status, 200); check('NovaJudge HTTP', f.nova.base);
  await api(endpoint, { method: 'PATCH', body: JSON.stringify({ enabled: true, bufferSeconds: 60, beforeSeconds: 3, afterSeconds: 10, autoGenerate: false }) });
  await waitFor(async () => (await api(endpoint)).health.feedStatus === 'CONNECTED', 60000, 'CCS recorder connection');
  check('CCS recorder connected', 'Actual authenticated NovaJudge feed');
  browser = await chromium.launch({ executablePath: process.env.REACTION_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: f.adminToken, url: base, httpOnly: true, sameSite: 'Lax' }]);
  await context.route(base + '/__reaction_e2e', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><meta charset="utf-8"><body style="margin:20px;background:#0b1220;color:white"><h1>Reaction E2E - SIMULATED MEDIA</h1></body></html>' }));
  publisher = await context.newPage(); await publisher.goto(base + '/__reaction_e2e');
  await publisher.addScriptTag({ path: path.resolve('../desktop/src/renderer/recording-controller.js') });
  await publisher.addScriptTag({ path: path.resolve('tests/reaction-e2e-browser.js') });
  const connection = await publisher.evaluate((input: any) => (globalThis as any).startReactionPublisher(input), { examId: f.examId, candidateId: f.candidateId, sessionId: f.sessionId, clientToken: f.clientToken });
  report.clock = connection.clock; check('Two authenticated WHIP publishers', connection.channels);
  heartbeatCapture = { screenOk: true, desktopCameraOk: true };
  const viewer = await context.newPage(); await viewer.goto(base + '/__reaction_e2e');
  await viewer.addScriptTag({ path: path.resolve('tests/reaction-e2e-browser.js') });
  await viewer.evaluate((input: any) => (globalThis as any).startReactionViewers(input), { sessionId: f.sessionId });
  const stats = await waitFor(async () => { const values = await viewer.evaluate<any[]>('reactionE2E.readerStats()'); return values.every((v: any) => v.framesDecoded > 5 && v.width > 16) ? values : false; }, 60000, 'WHEP frames');
  check('Camera and Desktop WHEP decoded', stats);
  await viewer.screenshot({ path: path.join(output, 'whep-simulated.png') });
  if (mode === 'publish') {
    await delay(Number(process.env.REACTION_E2E_PUBLISH_SECONDS || 120) * 1000);
    report.uploads = await publisher.evaluate('reactionE2E.uploads'); report.publisherErrors = await publisher.evaluate('reactionE2E.errors'); return;
  }
  console.log(mode === 'edge' ? 'Preparing live source segments for interruption/reconnect checks.' : 'Warming 60 second rolling cache (95 seconds for independent segment upload and cleanup).');
  await delay(mode === 'edge' ? 15000 : 95000);
  const snapshotAt = new Date();
  const deleted = await prisma.mediaSegment.count({ where: { examId: f.examId, sessionId: f.sessionId, reactionCache: true, deletedAt: { not: null } } });
  const active = await prisma.mediaSegment.findMany({ where: { examId: f.examId, sessionId: f.sessionId, reactionCache: true, deletedAt: null, reactionSegments: { none: {} } }, orderBy: { startedAt: 'asc' } });
  const protectedSegments = await prisma.mediaSegment.count({ where: { examId: f.examId, reactionCache: true, deletedAt: null, reactionSegments: { some: {} } } });
  if (mode !== 'edge') {
    assert(deleted >= 2, 'Expired ordinary cache must be deleted');
    assert(active.length >= 10, 'Both channels must retain a recoverable window');
    assert(active.every(segment => segment.endedAt && segment.endedAt.getTime() >= snapshotAt.getTime() - 64000), 'Unreferenced cache must expire beyond 60 seconds plus the 4 second scheduling allowance');
    check('60 second cache expiry', { snapshotAt, currentSessionDeletedSegments: deleted, ordinarySegments: active.length, ordinaryOldestStartedAt: active[0]?.startedAt, ordinaryOldestEndedAt: active[0]?.endedAt, protectedSegments });
  }
  const initialCount = await prisma.reaction.count({ where: { examId: f.examId } });
  feedAbort = new AbortController();
  const feed = await fetch(f.nova.base + '/api/ccs/contests/' + f.nova.contestId + '/event-feed?runs=false', { headers: { Authorization: 'Basic ' + Buffer.from(f.nova.adminUsername + ':' + f.nova.adminPassword).toString('base64') }, signal: feedAbort.signal });
  assert.equal(feed.status, 200);
  feedTask = (async () => { let pending = ''; const decoder = new TextDecoder(); try { for await (const chunk of feed.body as any) { pending += decoder.decode(chunk, { stream: true }); let index; while ((index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, index); pending = pending.slice(index + 1); if (line.trim()) { const e = JSON.parse(line); if (['submissions', 'judgements'].includes(e.type)) feedEvents.push({ observedAt: new Date().toISOString(), ...e }); } } } } catch (e) { if (!feedAbort?.signal.aborted) throw e; } })();
  async function submit(verdict: 'AC' | 'WA') {
    const login = await jsonRequest(f.nova.base + '/api/cli/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': f.nova.apiKey }, body: JSON.stringify({ username: f.nova.teamUsername, password: f.nova.teamPassword, contestId: f.nova.contestId, loginSource: 'PROCTORING' }) });
    const code = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<' + (verdict === 'AC' ? 'a+b' : 'a-b') + '<<"\\n";}\n';
    const response = await jsonRequest(f.nova.base + '/api/cli/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token, 'x-novajudge-proctor-key': login.proctoringKey }, body: JSON.stringify({ contestId: f.nova.contestId, problem: 'A', language: 'cpp', code }) });
    return { expected: verdict, ...response.submission };
  }
  if (mode === 'edge') {
    console.log('Observing the actual recorder network timeout/reconnect and historical replay.');
    const transitions: { at: string; status: string }[] = [];
    let disconnected = false, connectedAgain = false;
    let firstLease: string | null | undefined;
    const deadline = Date.now() + 140000;
    while (Date.now() < deadline && !connectedAgain) {
      const config = await prisma.reactionConfig.findUniqueOrThrow({ where: { examId: f.examId } });
      firstLease ??= config.leaseToken;
      if (transitions.at(-1)?.status !== config.feedStatus) transitions.push({ at: new Date().toISOString(), status: config.feedStatus });
      if (config.feedStatus === 'RECONNECTING') disconnected = true;
      if ((disconnected || Boolean(firstLease && config.leaseToken && firstLease !== config.leaseToken)) && config.feedStatus === 'CONNECTED') connectedAgain = true;
      await delay(200);
    }
    assert(connectedAgain, 'Actual feed reconnect transition must be observed');
    await delay(3000);
    assert.equal(await prisma.reaction.count({ where: { examId: f.examId } }), initialCount);
    check('Actual CCS reconnect does not duplicate historical reactions', { initialCount, transitions });
    await publisher.evaluate("reactionE2E.stopChannel('DESKTOP_CAMERA')");
    heartbeatCapture.desktopCameraOk = false;
    await delay(4000);
    const submission = await submit('WA'); report.submissions = [submission];
    const partial = await waitFor(async () => {
      const row = await prisma.reaction.findUnique({ where: { examId_submissionId: { examId: f.examId, submissionId: submission.id } } });
      return row?.finalizedAt ? row : false;
    }, 180000, 'real interrupted-source reaction');
    assert(['PARTIAL', 'MISSING'].includes(partial.status), 'Interrupted camera cannot be COMPLETE: ' + partial.status);
    assert.equal(partial.verdict, 'WA'); assert(partial.error); assert(partial.desktopPath);
    const queued = await api(endpoint + '/generate', { method: 'POST', body: JSON.stringify({ reactionIds: [partial.id] }) }); assert.equal(queued.queued, 0);
    check('Real camera interruption returns explicit incomplete status', { submissionId: submission.id, verdict: partial.verdict, status: partial.status, error: partial.error, desktopSaved: Boolean(partial.desktopPath), generatorQueued: queued.queued });
    report.uploads = await publisher.evaluate('reactionE2E.uploads');
    report.finishedAt = new Date().toISOString(); report.passed = true; return;
  }
  const submissions = [await submit('AC'), await submit('WA')]; report.submissions = submissions;
  const reactions = await waitFor(async () => {
    const rows = await prisma.reaction.findMany({ where: { examId: f.examId, submissionId: { in: submissions.map(s => s.id) } } });
    if (rows.some(r => ['FAILED','MISSING','PARTIAL','TIMEOUT'].includes(r.status))) throw new Error('Unexpected incomplete Reaction: ' + rows.map(r => r.status + ':' + r.error).join(','));
    return rows.length === 2 && rows.every(r => r.status === 'COMPLETE') ? rows : false;
  }, 180000, 'two complete Reaction clips');
  for (const submission of submissions) {
    const r = reactions.find(value => value.submissionId === submission.id)!;
    assert.equal(r.verdict, submission.expected);
    assert.equal(r.windowStart.getTime(), r.sourceSubmittedAt.getTime() - 3000);
    assert.equal(r.windowEnd!.getTime(), r.judgementObservedAt!.getTime() + 10000);
    assert(feedEvents.some(e => e.type === 'submissions' && e.data.id === submission.id));
    assert(feedEvents.some(e => e.type === 'judgements' && e.data.submission_id === submission.id && e.data.judgement_type_id === submission.expected));
  }
  check('Real AC and WA judgements via CCS', submissions.map(s => ({ id: s.id, expected: s.expected })));
  check('Submission -3s / observed judgement +10s', reactions.map(r => ({ submissionId: r.submissionId, start: r.windowStart, end: r.windowEnd, observed: r.judgementObservedAt })));
  assert.equal(await prisma.reaction.count({ where: { examId: f.examId } }), initialCount + 2, 'No historical reactions generated');
  const links = await prisma.reactionSegment.findMany({ where: { reactionId: { in: reactions.map(r => r.id) } } });
  const shared = links.filter((link, index) => links.findIndex(other => other.segmentId === link.segmentId) !== index).length;
  assert(shared > 0); check('Overlapping submissions share source segments', { shared });
  report.uploads = await publisher.evaluate('reactionE2E.uploads'); report.publisherErrors = await publisher.evaluate('reactionE2E.errors');
  assert.equal(report.publisherErrors.length, 0, JSON.stringify(report.publisherErrors));
  assert(!report.heartbeatError, report.heartbeatError);
  await publisher.evaluate('reactionE2E.stop()'); publisher = undefined; await viewer.evaluate('reactionE2E.closeReaders()');
  heartbeatCapture = { screenOk: false, desktopCameraOk: false };
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
  await api(endpoint + '/generate', { method: 'POST', body: JSON.stringify({ reactionIds: reactions.map(r => r.id) }) });
  const generated = await waitFor(async () => { const rows = await prisma.reaction.findMany({ where: { id: { in: reactions.map(r => r.id) } } }); if (rows.some(r => r.generationStatus === 'FAILED')) throw new Error(rows.map(r => r.generationError).join(',')); return rows.every(r => Boolean(r.reactionPath)) ? rows : false; }, 1200000, 'official generator');
  for (const r of generated) {
    const directory = path.join(output, r.submissionId); await fs.mkdir(directory, { recursive: true });
    const probes: any = {};
    for (const kind of ['camera', 'desktop', 'reaction', 'metadata']) {
      const url = endpoint + '/' + r.id + '/files/' + kind;
      const response = await fetch(url, { headers }); assert.equal(response.status, 200);
      const file = path.join(directory, kind + (kind === 'metadata' ? '.json' : '.mp4'));
      const data = Buffer.from(await response.arrayBuffer()); assert(data.length > 0); await fs.writeFile(file, data);
      if (kind !== 'metadata') {
        const { stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v','error','-show_format','-show_streams','-of','json',file], { windowsHide: true });
        const probe = JSON.parse(stdout); assert(Number(probe.format.duration) > 10);
        await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v','error','-threads','1','-i',file,'-f','null','-'], { windowsHide: true, timeout: 120000 });
        probes[kind] = probe;
        if (kind === 'reaction') { const video = probe.streams.find((stream: any) => stream.codec_type === 'video'); assert.equal(video.width, 1080); assert.equal(video.height, 1920); }
      }
    }
    assert(Math.abs(Number(probes.camera.format.duration) - Number(probes.desktop.format.duration)) <= 0.1);
    assert(Math.abs(Number(probes.camera.format.duration) - Number(r.durationSeconds)) <= 0.25);
    await fs.writeFile(path.join(directory, 'ffprobe.json'), JSON.stringify(probes, null, 2));
    report.artifacts.push({ submissionId: r.submissionId, verdict: r.verdict, directory, duration: probes.camera.format.duration });
  }
  check('MP4 decode / 1080x1920 official render / synchronized durations', report.artifacts);
  const noAuth = await fetch(endpoint + '/' + generated[0].id + '/files/camera'); assert.equal(noAuth.status, 401); check('Download requires authorization', noAuth.status);
  const ui = await context.newPage(); await ui.goto(base + '/dashboard/exams/' + f.examId + '/reactions');
  await ui.getByRole('button', { name: 'Camera 预览', exact: true }).first().click();
  await ui.locator('video').waitFor();
  await ui.locator('video').evaluate((video: HTMLVideoElement) => video.play());
  await ui.waitForFunction(() => { const video = document.querySelector('video'); return !!video && video.currentTime > 0 && video.videoWidth > 16; });
  await ui.screenshot({ path: path.join(output, 'admin-preview.png'), fullPage: true });
  check('Management page actual video playback', '/dashboard/exams/' + f.examId + '/reactions');
  report.finishedAt = new Date().toISOString(); report.passed = true;
}
try { await main(); } catch (error) { report.passed = false; report.error = redact(error instanceof Error ? error.message : String(error)); console.error(report.error); process.exitCode = 1; }
finally {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  feedAbort?.abort(); await feedTask?.catch(() => {});
  if (publisher) { report.publisherErrors = await publisher.evaluate('reactionE2E.errors').catch(() => []); await publisher.evaluate('reactionE2E.stop?.()').catch(() => {}); }
  await browser?.close(); await prisma.$disconnect();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), redact(JSON.stringify(report, null, 2)));
  await fs.writeFile(path.join(output, 'ccs-events.ndjson'), feedEvents.map(value => JSON.stringify(value)).join('\n') + '\n');
  console.log('Evidence: ' + output);
}
