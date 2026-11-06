/** Local operator tool: publish clearly labelled synthetic media for an EXISTING exam/team.
 * Never creates contests/candidates, calls NovaJudge login, or changes exam configuration.
 * Uses canonical project-issued session tokens and real WHIP/WHEP/upload endpoints.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createClientSessionToken } from '../src/lib/client-auth';
import { createSessionToken } from '../src/lib/auth';
import { canManageExam } from '../src/lib/permissions';

const mode = process.argv[2] || 'inspect';
const examId = process.env.REACTION_MEDIA_EXAM_ID || process.env.REACTION_MANUAL_EXAM_ID || '';
const examNumber = process.env.REACTION_MEDIA_EXAM_NUMBER || process.env.REACTION_MANUAL_TEAM || '';
const base = (process.env.REACTION_MEDIA_URL || process.env.APP_BASE_URL || 'http://localhost:4031').replace(/\/$/, '');
assert(/^[a-zA-Z0-9_-]+$/.test(examId), 'Set REACTION_MEDIA_EXAM_ID to the existing local exam ID');
assert(examNumber.length > 0 && examNumber.length < 100, 'Set the exact REACTION_MEDIA_EXAM_NUMBER');
assert(['inspect', 'run', 'status', 'stop'].includes(mode), 'Mode must be inspect, run, status, or stop');
const local = path.resolve('.local/reaction-media', examId);
const statusPath = path.join(local, 'status.json');
const stopPath = path.join(local, 'stop.request');
const lockPath = path.join(local, 'runner.lock');
const credentialsPath = path.join(local, 'session.private.json');
const artifacts = process.env.REACTION_E2E_OUTPUT ? path.resolve(process.env.REACTION_E2E_OUTPUT, 'media') : local;
let browser: Browser | undefined, publisher: Page | undefined, viewer: Page | undefined;
let ownsLock = false, stopReason = '', sessionId = '', tokenHash = '', deviceId = '';
let clientToken = '', adminToken = '';
const state: Record<string, unknown> = { mode, mediaKind: 'SIMULATED_CANVAS_VIA_AUTHENTICATED_MEDIAMTX', pid: process.pid, startedAt: new Date().toISOString(), examId, examNumber, base, status: 'STARTING' };
const redact = (value: string) => [clientToken, adminToken].filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
const message = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
async function saveStatus() {
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(statusPath + '.tmp', JSON.stringify(state, null, 2));
  await fs.rename(statusPath + '.tmp', statusPath);
}
async function exists(file: string) { try { await fs.access(file); return true; } catch { return false; } }
async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (body.message || body.error || 'request failed'));
  return body.data;
}
async function conflicts(candidateId: string) {
  const cutoff = new Date(Date.now() - 120000);
  return prisma.clientSession.findMany({ where: {
    candidateId, id: sessionId ? { not: sessionId } : undefined,
    revokedAt: null, status: { not: 'FINISHED' },
    OR: [{ lastDesktopSeenAt: { gte: cutoff } }, { lastMiniProgramSeenAt: { gte: cutoff } }, { createdAt: { gte: cutoff } }]
  }, select: { id: true, status: true, lastDesktopSeenAt: true, lastMiniProgramSeenAt: true } });
}
async function inspect() {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Only a local HTTP server is allowed');
  const database = new URL(process.env.DATABASE_URL || 'mysql://invalid/invalid');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname), 'Only a local database is allowed');
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, select: {
    id: true, examCode: true, platform: true, published: true, startAt: true, endAt: true,
    reactionEnabled: true, createdById: true, platformContestId: true
  } });
  assert.equal(exam.platform, 'NOVAJUDGE', 'Existing exam must be linked to NovaJudge');
  const candidates = await prisma.candidate.findMany({ where: { examId, examNumber }, select: { id: true, name: true, examNumber: true } });
  assert.equal(candidates.length, 1, 'Exactly one candidate must match the exact examNumber');
  const candidate = candidates[0];
  const adminId = process.env.REACTION_MEDIA_ADMIN_ID || exam.createdById;
  assert(adminId, 'The existing exam must have an administrator');
  const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
  assert.equal(admin.status, 'ACTIVE', 'Administrator is not active');
  assert(await canManageExam(admin, examId), 'Administrator cannot manage the specified exam');
  const activeSessions = await conflicts(candidate.id);
  return { exam, candidate, admin, activeSessions };
}
async function main() {
  if (mode === 'status') { console.log(await fs.readFile(statusPath, 'utf8')); return; }
  if (mode === 'stop') {
    assert(await exists(lockPath), 'No running media process has claimed this exam');
    await fs.writeFile(stopPath, new Date().toISOString());
    console.log('Graceful stop requested. Status: ' + statusPath); return;
  }
  const { exam, candidate, admin, activeSessions } = await inspect();
  const safe = { examId, examCode: exam.examCode, examNumber, candidateId: candidate.id, contestId: exam.platformContestId, reactionEnabled: exam.reactionEnabled, published: exam.published, startAt: exam.startAt, endAt: exam.endAt, activeSessions };
  if (mode === 'inspect') { console.log(JSON.stringify(safe, null, 2)); return; }
  assert.equal(activeSessions.length, 0, 'Active client session exists; stop the simulation request and keep the real client unchanged');
  assert(exam.published && exam.reactionEnabled, 'Publish and enable Reaction on the existing exam before publishing media');
  assert(+exam.startAt <= Date.now() && +exam.endAt > Date.now(), 'Existing exam must currently be running');
  const durationSeconds = Number(process.env.REACTION_MEDIA_DURATION_SECONDS || 3600);
  assert(Number.isFinite(durationSeconds) && durationSeconds >= 20 && durationSeconds <= 43200, 'Duration must be 20..43200 seconds');
  assert.equal((await fetch(base, { signal: AbortSignal.timeout(15000) })).status, 200, 'Proctoring HTTP server is not ready');
  await fs.mkdir(local, { recursive: true });
  await fs.mkdir(artifacts, { recursive: true });
  const lock = await fs.open(lockPath, 'wx'); ownsLock = true;
  await lock.writeFile(JSON.stringify({ pid: process.pid, examId, examNumber, startedAt: state.startedAt })); await lock.close();
  await fs.rm(stopPath, { force: true });
  // Recheck after acquiring our runner lock. Existing client sessions are never revoked.
  assert.equal((await conflicts(candidate.id)).length, 0, 'A client connected while preparing simulation; no existing session changed');
  const issued = createClientSessionToken(); clientToken = issued.token; tokenHash = issued.tokenHash;
  adminToken = createSessionToken(admin); deviceId = 'reaction-manual-sim-' + randomBytes(12).toString('hex');
  const session = await prisma.clientSession.create({ data: {
    examId, candidateId: candidate.id, desktopDeviceId: deviceId, desktopTokenHash: tokenHash,
    status: 'IN_EXAM', startedAt: new Date(), approvedAt: new Date(), lastDesktopSeenAt: new Date()
  } });
  sessionId = session.id;
  await fs.writeFile(credentialsPath, JSON.stringify({ examId, examNumber, candidateId: candidate.id, adminId: admin.id, sessionId, deviceId, clientToken, adminToken }, null, 2));
  Object.assign(state, safe, { sessionId, status: 'CONNECTING' }); await saveStatus();
  const heartbeat = async (connected = true) => {
    const data = await request(base + '/api/client/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-session-token': clientToken }, body: JSON.stringify({ sessionId, deviceId, side: 'DESKTOP', capture: connected ? { screenOk: true, desktopCameraOk: true } : {} }) });
    if (!data?.session || data.session.status === 'FINISHED') throw new Error('The simulation session ended or was revoked; real sessions remain unchanged');
  };
  await heartbeat(false);
  browser = await chromium.launch({ executablePath: process.env.REACTION_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: adminToken, url: base, httpOnly: true, sameSite: 'Lax' }]);
  await context.route(base + '/__reaction_manual_media', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><body style="background:#0b1220;color:white"><h1>Reaction manual acceptance — SIMULATED MEDIA</h1></body>' }));
  publisher = await context.newPage(); await publisher.goto(base + '/__reaction_manual_media');
  await publisher.addScriptTag({ path: path.resolve('../desktop/src/renderer/recording-controller.js') });
  await publisher.addScriptTag({ path: path.resolve('tests/reaction-e2e-browser.js') });
  state.publisher = await publisher.evaluate((input) => (globalThis as any).startReactionPublisher(input), { examId, examNumber, candidateId: candidate.id, sessionId, clientToken });
  await heartbeat();
  viewer = await context.newPage(); await viewer.goto(base + '/__reaction_manual_media');
  await viewer.addScriptTag({ path: path.resolve('tests/reaction-e2e-browser.js') });
  await viewer.evaluate(input => (globalThis as any).startReactionViewers(input), { sessionId });
  const deadline = Date.now() + durationSeconds * 1000;
  let ready = false;
  while (!stopReason && Date.now() < deadline) {
    if (await exists(stopPath)) { stopReason = 'Operator requested stop'; break; }
    const competing = await conflicts(candidate.id);
    if (competing.length) { state.competingSessions = competing; throw new Error('Another client session is active; simulation stops to avoid source conflicts'); }
    await heartbeat();
    const readers = await viewer.evaluate(() => (globalThis as any).reactionE2E.readerStats()) as { framesDecoded: number; width: number }[];
    state.readers = readers;
    const media = await publisher.evaluate(() => { const s = (globalThis as any).reactionE2E; return {
      channels: Object.entries(s.peers).map(([channel, peer]: [string, any]) => ({ channel, connectionState: peer.connectionState })),
      uploadCount: s.uploads.length, uploads: s.uploads.slice(-8), errors: s.errors.slice(-10)
    }; });
    state.media = media;
    const readable = readers.length === 2 && readers.every(value => value.framesDecoded > 5 && value.width > 16);
    if (!ready && readable && media.uploadCount >= 2) {
      ready = true; state.readyAt = new Date().toISOString();
      await viewer.screenshot({ path: path.join(artifacts, 'whep-simulated.png') });
      console.log('READY: two genuine WHEP streams decoded and both segment channels uploaded. Exam ' + exam.examCode + ', team ' + examNumber);
    }
    if (!ready && Date.now() - +new Date(String(state.startedAt)) > 90000) throw new Error('Both WHEP streams and segment uploads did not become ready within 90 seconds');
    if (media.errors.length) throw new Error('Synthetic media error: ' + media.errors.join('; '));
    if (ready && (!readable || media.channels.some((value: { connectionState: string }) => value.connectionState !== 'connected'))) throw new Error('Media disconnected; simulation stopped with explicit failure');
    const [ordinarySegments, deletedSegments, protectedSegments] = await Promise.all([
      prisma.mediaSegment.findMany({ where: { sessionId, reactionCache: true, deletedAt: null, reactionSegments: { none: {} } }, orderBy: { startedAt: 'asc' }, select: { channel: true, startedAt: true, endedAt: true } }),
      prisma.mediaSegment.count({ where: { sessionId, reactionCache: true, deletedAt: { not: null } } }),
      prisma.mediaSegment.count({ where: { sessionId, reactionCache: true, deletedAt: null, reactionSegments: { some: {} } } })
    ]);
    state.cache = { snapshotAt: new Date().toISOString(), ordinarySegments: ordinarySegments.length, deletedSegments, protectedSegments,
      oldestStartedAt: ordinarySegments[0]?.startedAt ?? null, oldestEndedAt: ordinarySegments[0]?.endedAt ?? null,
      channels: ['DESKTOP_SCREEN', 'DESKTOP_CAMERA'].map(channel => {
        const segments = ordinarySegments.filter(segment => segment.channel === channel);
        return { channel, count: segments.length, oldestStartedAt: segments[0]?.startedAt ?? null, oldestEndedAt: segments[0]?.endedAt ?? null, newestEndedAt: segments.at(-1)?.endedAt ?? null };
      }) };
    state.status = ready ? 'READY' : 'WARMING'; await saveStatus();
    await delay(5000);
  }
  stopReason ||= 'Configured duration elapsed';
}
process.on('SIGINT', () => { stopReason = 'SIGINT'; });
process.on('SIGTERM', () => { stopReason = 'SIGTERM'; });
try { await main(); }
catch (error) { state.status = 'FAILED'; state.error = message(error); console.error(state.error); process.exitCode = 1; }
finally {
  if (ownsLock) {
    try { await publisher?.evaluate(() => (globalThis as any).reactionE2E.stop?.()); } catch (error) { state.shutdownError = message(error); }
    try { await viewer?.evaluate(() => (globalThis as any).reactionE2E.closeReaders?.()); } catch { /* browser may already be closed */ }
    await browser?.close().catch(() => {});
    if (sessionId) await prisma.clientSession.updateMany({ where: { id: sessionId, examId, desktopDeviceId: deviceId, desktopTokenHash: tokenHash }, data: { revokedAt: new Date(), endedAt: new Date(), status: 'FINISHED' } });
    if (state.status !== 'FAILED') state.status = 'STOPPED';
    state.stoppedAt = new Date().toISOString(); state.stopReason = stopReason; await saveStatus();
    await fs.rm(lockPath, { force: true }); await fs.rm(stopPath, { force: true });
    console.log('Simulation stopped; only its own session was finished. Status: ' + statusPath);
  }
  await prisma.$disconnect();
}
