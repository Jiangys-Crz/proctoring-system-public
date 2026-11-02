// Real Electron 22 publishers and Chrome monitor; only generated screen/audio.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { chromium, type Page } from 'playwright-core';
import { createSessionToken } from '../src/lib/auth';
import { createClientSessionToken } from '../src/lib/client-auth';
const configFile = process.env.VOICE_QA_CONFIG || '';
assert.match(configFile, /^\/tmp\/proctor-voice-qa\.[A-Za-z0-9]+\/environment\.json$/);
const config = JSON.parse(readFileSync(configFile, 'utf8')), directory = config.directory, base = `http://127.0.0.1:${config.web}`;
process.env.SESSION_SECRET = config.secret;
const db = new PrismaClient({ datasourceUrl: `mysql://root@127.0.0.1:${config.mysql}/proctor_voice_qa` });
const runId = randomUUID();
let examId = '', ownerId = '', native: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function peak(page: Page, selector: string) {
  return page.evaluate(async selector => {
    const media = document.querySelector(selector) as HTMLMediaElement;
    if (!(media.srcObject instanceof MediaStream) || !media.srcObject.getAudioTracks().length) throw new Error('Current screen has no microphone track');
    const context = new AudioContext(), source = context.createMediaStreamSource(media.srcObject), analyser = context.createAnalyser(), silent = context.createGain();
    analyser.fftSize = 8192; silent.gain.value = 0; source.connect(analyser); analyser.connect(silent); silent.connect(context.destination); await context.resume();
    await new Promise(resolve => setTimeout(resolve, 300)); const samples = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(samples);
    let index = 0; for (let i = 1; i < samples.length; i++) if (samples[i] > samples[index]) index = i;
    const hz = index * context.sampleRate / analyser.fftSize; source.disconnect(); await context.close(); return hz;
  }, selector);
}
try {
  const marker = 'audio-' + randomUUID(), now = Date.now(), tokens = [createClientSessionToken(), createClientSessionToken()];
  const owner = await db.user.create({ data: { username: marker, role: 'ADMIN', realName: '声音测试监考' } }); ownerId = owner.id;
  const exam = await db.exam.create({ data: { name: marker, createdById: owner.id, examCode: String(randomInt(1_000_000_000, 10_000_000_000)),
    startAt: new Date(now - 600000), latestStartAt: new Date(now), endAt: new Date(now + 3600000), durationMinutes: 60,
    platform: 'HYDRO', platformBaseUrl: 'https://judge.invalid', platformContestId: marker, contestType: 'INDIVIDUAL', contestRule: 'XCPC', rules: '', requireFrontCamera: false, requireMiniProgram: false } }); examId = exam.id;
  const room = await db.examRoom.create({ data: { examId, name: '无摄像头声音测试室', requireFrontCamera: false, requireSecondCamera: false } });
  const sessions = [];
  for (let i = 0; i < 2; i++) {
    const candidate = await db.candidate.create({ data: { examId, name: i ? '声音考生乙' : '声音考生甲', examNumber: `00${i + 1}`, seatNo: `00${i + 1}`, password: marker, status: 'ONLINE_NORMAL', startedAt: new Date(now - 60000) } });
    const session = await db.clientSession.create({ data: { examId, candidateId: candidate.id, status: 'IN_EXAM', desktopTokenHash: tokens[i].tokenHash, lastDesktopSeenAt: new Date(now + 3600000), startedAt: candidate.startedAt } });
    await db.examRoomCandidate.create({ data: { roomId: room.id, candidateId: candidate.id } });
    sessions.push({ id: session.id, token: tokens[i].token });
  }
  writeFileSync(directory + '/native-fixture.json', JSON.stringify({ base, sessions, runId }));
  const nativeLog: string[] = [];
  native = spawn(new URL('../../desktop/node_modules/.bin/electron', import.meta.url).pathname,
    [new URL('../../desktop/scripts/test-desktop-audio-runtime.cjs', import.meta.url).pathname], { env: { ...process.env, VOICE_NATIVE_FIXTURE: directory + '/native-fixture.json' }, stdio: ['ignore', 'pipe', 'pipe'] });
  native.stdout?.on('data', chunk => nativeLog.push(chunk.toString())); native.stderr?.on('data', chunk => nativeLog.push(chunk.toString()));
  const ready = () => { try { return JSON.parse(readFileSync(directory + '/native-ready.json', 'utf8')).runId === runId; } catch { return false; } };
  for (let i = 0; i < 120 && !ready(); i++) { if (native.exitCode !== null) throw new Error(nativeLog.join('')); await pause(500); }
  assert.ok(ready(), nativeLog.join(''));
  const nativeProof = JSON.parse(readFileSync(directory + '/native-ready.json', 'utf8'));
  assert.equal(nativeProof.electron, '22.3.27'); assert.ok(nativeProof.recordedAudioRms > .01);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await context.addInitScript('window.__name = value => value;');
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(owner), url: base }]);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + `/dashboard/exams/${examId}/monitor`);
  await page.locator('.candidate-feed > strong').getByText('声音考生甲', { exact: true }).waitFor();
  const screen = '.desktop-screen-cell video';
  await page.waitForFunction(selector => { const video = document.querySelector(selector) as HTMLVideoElement; return video?.readyState >= 2 && video.srcObject instanceof MediaStream && video.srcObject.getAudioTracks().length === 1; }, screen, { timeout: 20000 });
  assert.equal(await page.locator(screen).evaluate((video: HTMLVideoElement) => video.muted), false);
  const firstHz = await peak(page, screen); assert.ok(Math.abs(firstHz - 330) < 35, String(firstHz));
  const oldScreen = await page.locator(screen).elementHandle();
  await page.getByTitle('下一页', { exact: true }).click();
  await page.locator('.candidate-feed > strong').getByText('声音考生乙', { exact: true }).waitFor();
  await page.waitForFunction(selector => { const video = document.querySelector(selector) as HTMLVideoElement; return video?.readyState >= 2 && video.srcObject instanceof MediaStream && video.srcObject.getAudioTracks().length === 1; }, screen, { timeout: 20000 });
  const secondHz = await peak(page, screen); assert.ok(Math.abs(secondHz - 660) < 35, String(secondHz));
  assert.equal(await oldScreen!.evaluate((video: HTMLVideoElement) => video.srcObject === null && video.muted), true, 'previous candidate audio is detached immediately');
  await page.getByRole('button', { name: '当前考生声音：开', exact: true }).click(); assert.equal(await page.locator(screen).evaluate((video: HTMLVideoElement) => video.muted), true);
  await page.getByRole('button', { name: '当前考生声音：关', exact: true }).click();
  await page.locator('.monitor-layout-switch select').selectOption('4');
  assert.equal(await page.locator('.monitor-card video').evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).muted)), true);
  await page.locator('.monitor-layout-switch select').selectOption('1');
  await page.locator('.candidate-feed > strong').getByText('声音考生甲', { exact: true }).waitFor();
  await page.getByRole('button', { name: '语音通话', exact: true }).click();
  await page.locator('.voice-panel').getByText(/实时通话中/).waitFor();
  assert.equal(await page.locator('.monitor-card video').evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).muted)), true, 'ambient feeds are muted while the phone audio plays');
  const callHz = await peak(page, '.voice-panel audio'); assert.ok(Math.abs(callHz - 330) < 35, String(callHz));
  assert.equal(JSON.parse(readFileSync(directory + '/native-state.json', 'utf8')).microphoneAvailable, true);
  await page.getByTitle('下一页', { exact: true }).click();
  await page.locator('.candidate-feed > strong').getByText('声音考生乙', { exact: true }).waitFor();
  assert.equal(await page.locator('.call-recipient > strong').textContent(), '声音考生甲');
  await page.locator('.voice-panel').getByRole('button', { name: '挂断', exact: true }).click();
  await page.waitForFunction(selector => { const video = document.querySelector(selector) as HTMLVideoElement; return video?.readyState >= 2 && !video.muted && video.srcObject instanceof MediaStream; }, screen, { timeout: 20000 });
  const resumedHz = await peak(page, screen); assert.ok(Math.abs(resumedHz - 660) < 35, String(resumedHz));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: directory + '/monitor-audio.png', fullPage: true });
  console.log(JSON.stringify({ electron: nativeProof.electron, chromium: nativeProof.chromium, noCameraRequired: true, screenRecordingContainsAudio: true,
    recordedSeconds: nativeProof.recordedSeconds, recordedAudioRms: nativeProof.recordedAudioRms, firstCandidateHz: Math.round(firstHz), secondCandidateHz: Math.round(secondHz),
    phonePeerHz: Math.round(callHz), afterHangupCurrentCandidateHz: Math.round(resumedHz), fourPersonViewMuted: true, previousAudioDetached: true }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page && !page.isClosed()) {
    await page.screenshot({ path: directory + '/monitor-audio-failure.png', fullPage: true }).catch(() => {});
    console.error(await page.locator('body').innerText().catch(() => 'Unable to inspect the failed monitor page'));
  }
  throw error;
} finally {
  writeFileSync(directory + '/native-stop', runId);
  await browser?.close();
  if (native) { for (let i = 0; i < 20 && native.exitCode === null; i++) await pause(500); if (native.exitCode === null) native.kill('SIGTERM'); }
  if (examId) await db.exam.delete({ where: { id: examId } }); if (ownerId) await db.user.delete({ where: { id: ownerId } }); await db.$disconnect();
}
