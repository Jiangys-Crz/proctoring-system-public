// An isolated Next/MySQL/MediaMTX stack and synthetic tones only. No real mic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { chromium, type Page } from 'playwright-core';
import { createSessionToken } from '../src/lib/auth';
import { createClientSessionToken } from '../src/lib/client-auth';

const configFile = process.env.VOICE_QA_CONFIG || '';
assert.match(configFile, /^\/tmp\/proctor-voice-qa\.[A-Za-z0-9]+\/environment\.json$/);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
process.env.SESSION_SECRET = config.secret;
process.env.MEDIA_PUBLISH_SECRET = config.secret;
const db = new PrismaClient({ datasourceUrl: `mysql://root@127.0.0.1:${config.mysql}/proctor_voice_qa` });
const base = `http://127.0.0.1:${config.web}`;
const marker = `voice-${randomUUID()}`;
const desktop = createClientSessionToken(), mobile = createClientSessionToken(), otherToken = createClientSessionToken();
const helper = new URL('../../../packages/shared/src/realtime-voice.js', import.meta.url);
let examId = '', users: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function post(path: string, body: object, cookie = '', token = '') {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base,
    ...(cookie ? { cookie: `cwnupaa_proctor_session=${cookie}` } : {}), ...(token ? { 'x-proctor-session-token': token } : {}) }, body: JSON.stringify(body) });
  const text = await response.text();
  assert.match(text, /^\{/, `${path} HTTP ${response.status}: ${text.slice(0, 200)}`);
  return { response, body: JSON.parse(text) };
}
async function install(page: Page, side: 'ADMIN' | 'DESKTOP', sessionId: string, token: string, frequency: number) {
  await page.addInitScript('window.__name = value => value;');
  await page.goto(base + '/api/health');
  await page.addScriptTag({ path: helper.pathname });
  await page.evaluate(({ side, sessionId, token, frequency }) => {
    const w = window as any;
    w.__voicePeers = [];
    const Native = window.RTCPeerConnection;
    w.RTCPeerConnection = function (...args: any[]) { const peer = new Native(...args); w.__voicePeers.push(peer); return peer; };
    w.RTCPeerConnection.prototype = Native.prototype;
    const audio = document.createElement('audio'); audio.autoplay = true; audio.volume = 0; document.body.appendChild(audio); w.__voiceAudio = audio;
    w.__voice = globalThis.createProctorVoiceCall({ side, sessionId, audio,
      request: async body => {
        const response = await fetch(side === 'ADMIN' ? '/api/voice/calls' : '/api/client/voice/calls', { method: 'POST',
          headers: { 'content-type': 'application/json', ...(side === 'DESKTOP' ? { 'x-proctor-session-token': token } : {}) }, body: JSON.stringify(body) });
        const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.message); return result.data;
      },
      getMicrophone: async () => {
        w.__captures = (w.__captures || 0) + 1;
        const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
        oscillator.frequency.value = frequency; gain.gain.value = .08; oscillator.connect(gain); gain.connect(output); oscillator.start(); await context.resume();
        w.__voiceTone = { context, oscillator, output }; return output.stream;
      }, onState: state => { w.__voiceState = state; }
    });
    if (side === 'DESKTOP') w.__voice.listen();
  }, { side, sessionId, token, frequency });
}
async function spectrum(page: Page) {
  return page.evaluate(async () => {
    const w = window as any, stream = w.__voiceAudio.srcObject as MediaStream;
    const context = new AudioContext(), source = context.createMediaStreamSource(stream), analyser = context.createAnalyser(), silent = context.createGain();
    analyser.fftSize = 8192; silent.gain.value = 0; source.connect(analyser); analyser.connect(silent); silent.connect(context.destination); await context.resume();
    await new Promise(resolve => setTimeout(resolve, 300));
    const frequency = new Float32Array(analyser.frequencyBinCount), samples = new Float32Array(analyser.fftSize);
    analyser.getFloatFrequencyData(frequency); analyser.getFloatTimeDomainData(samples);
    let peak = 0; for (let i = 1; i < frequency.length; i++) if (frequency[i] > frequency[peak]) peak = i;
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    const stats: any[] = [];
    for (const peer of w.__voicePeers) { const report = await peer.getStats(); report.forEach((row: any) => { if (row.type === 'inbound-rtp' && (row.kind === 'audio' || row.mediaType === 'audio')) stats.push({ bytesReceived: row.bytesReceived, totalAudioEnergy: row.totalAudioEnergy }); }); }
    source.disconnect(); analyser.disconnect(); silent.disconnect(); await context.close();
    return { frequency: peak * context.sampleRate / analyser.fftSize, rms, stats };
  });
}
try {
  await db.systemSetting.upsert({ where: { key: 'bootstrap.admin.v1' }, create: { key: 'bootstrap.admin.v1', value: { complete: true } }, update: { value: { complete: true } } });
  const owner = await db.user.create({ data: { username: marker + '-owner', realName: '语音测试监考', role: 'ADMIN' } });
  const second = await db.user.create({ data: { username: marker + '-second', role: 'ADMIN' } });
  const outsider = await db.user.create({ data: { username: marker + '-outsider', role: 'ADMIN' } });
  users = [owner.id, second.id, outsider.id];
  const ownerCookie = createSessionToken(owner), secondCookie = createSessionToken(second), outsiderCookie = createSessionToken(outsider);
  const now = Date.now();
  const exam = await db.exam.create({ data: { examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: marker,
    createdById: owner.id, administrators: { create: { userId: second.id } }, startAt: new Date(now - 600000), latestStartAt: new Date(now),
    endAt: new Date(now + 3600000), durationMinutes: 60, platform: 'HYDRO', platformBaseUrl: 'https://judge.invalid', platformContestId: marker,
    contestType: 'INDIVIDUAL', contestRule: 'XCPC', rules: '', requireFrontCamera: false, requireMiniProgram: false } }); examId = exam.id;
  const candidate = await db.candidate.create({ data: { examId, name: '实时声音测试考生', examNumber: '001', seatNo: '001', password: marker, startedAt: new Date(now - 60000) } });
  const other = await db.candidate.create({ data: { examId, name: '其他考生', examNumber: '002', seatNo: '002', password: marker, startedAt: new Date(now - 60000) } });
  const session = await db.clientSession.create({ data: { examId, candidateId: candidate.id, status: 'IN_EXAM', desktopDeviceId: marker,
    desktopTokenHash: desktop.tokenHash, miniProgramTokenHash: mobile.tokenHash, lastDesktopSeenAt: new Date(), startedAt: candidate.startedAt } });
  const otherSession = await db.clientSession.create({ data: { examId, candidateId: other.id, status: 'IN_EXAM', desktopTokenHash: otherToken.tokenHash, startedAt: other.startedAt } });
  assert.equal((await post('/api/voice/calls', { action: 'START', sessionId: session.id })).response.status, 401);
  assert.equal((await post('/api/voice/calls', { action: 'START', sessionId: session.id }, outsiderCookie)).response.status, 403);
  assert.equal((await post('/api/client/voice/calls', { action: 'POLL', sessionId: session.id }, '', mobile.token)).response.status, 401);
  assert.equal((await post('/api/client/voice/calls', { action: 'START', sessionId: session.id }, '', desktop.token)).response.status, 403);
  assert.equal((await post('/api/voice/calls', { action: 'START', sessionId: session.id, target: 'MINIPROGRAM' }, ownerCookie)).response.status, 400);

  const races = await Promise.all(Array.from({ length: 12 }, (_, i) => post('/api/voice/calls', { action: 'START', sessionId: session.id }, i % 2 ? ownerCookie : secondCookie)));
  assert.equal(races.filter(r => r.response.status === 201).length, 1);
  assert.ok(races.every(r => [201, 409].includes(r.response.status)));
  const first = races.find(r => r.response.status === 201)!.body.data.call;
  const firstRow = await db.voiceCall.findUniqueOrThrow({ where: { id: first.id } });
  const firstCookie = firstRow.callerId === owner.id ? ownerCookie : secondCookie, anotherCookie = firstRow.callerId === owner.id ? secondCookie : ownerCookie;
  assert.equal((await post('/api/voice/calls', { action: 'POLL', callId: first.id }, anotherCookie)).response.status, 403);
  assert.equal((await post('/api/client/voice/calls', { action: 'POLL', callId: first.id }, '', otherToken.token)).response.status, 401);
  assert.equal((await post('/api/voice/calls', { action: 'ACCEPT', callId: first.id }, firstCookie)).response.status, 403);
  await post('/api/voice/calls', { action: 'END', callId: first.id, reason: 'CANCELLED' }, firstCookie);
  assert.equal((await db.voiceCall.findUniqueOrThrow({ where: { id: first.id } })).activeSessionId, null);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const adminContext = await browser.newContext(), clientContext = await browser.newContext();
  await adminContext.addCookies([{ name: 'cwnupaa_proctor_session', value: ownerCookie, url: base }]);
  const admin = await adminContext.newPage(), client = await clientContext.newPage();
  await install(admin, 'ADMIN', session.id, '', 220); await install(client, 'DESKTOP', session.id, desktop.token, 880);
  await admin.evaluate(sessionId => (window as any).__voice.start(sessionId), session.id);
  await client.waitForFunction(() => (window as any).__voiceState?.phase === 'incoming', null, { timeout: 10000 });
  assert.equal(await client.evaluate(() => (window as any).__captures || 0), 0, 'the call does not acquire a microphone before answering');
  await client.evaluate(() => (window as any).__voice.accept());
  await Promise.all([admin, client].map(page => page.waitForFunction(() => (window as any).__voiceState?.phase === 'active', null, { timeout: 25000 })));
  await new Promise(resolve => setTimeout(resolve, 1200));
  const adminSound = await spectrum(admin), clientSound = await spectrum(client);
  assert.ok(Math.abs(adminSound.frequency - 880) < 35, JSON.stringify(adminSound));
  assert.ok(Math.abs(clientSound.frequency - 220) < 35, JSON.stringify(clientSound));
  assert.ok(adminSound.rms > .01 && clientSound.rms > .01);
  assert.ok(adminSound.stats.some(s => s.bytesReceived > 0) && clientSound.stats.some(s => s.bytesReceived > 0));
  const callId = await admin.evaluate(() => (window as any).__voiceState.call.id as string);
  assert.equal(await db.voiceCallConnection.count({ where: { callId } }), 4, 'two publishers and two readers form the duplex call');
  const connectionRows = await db.voiceCallConnection.findMany({ where: { callId } });
  const apiToken = createHmac('sha256', config.secret).update('proctor-private-media-api-v1').digest('base64url');
  const sessionsResponse = await fetch(`http://127.0.0.1:${config.mediaApi}/v3/webrtcsessions/list`, { headers: { authorization: `Bearer ${apiToken}` } });
  assert.equal(sessionsResponse.status, 200);
  const mediaSessions = await sessionsResponse.json();
  assert.ok(connectionRows.every(row => mediaSessions.items.some((item: any) => item.id === row.id)), 'stored media identifiers must be usable by the server control API');
  await admin.evaluate(() => (window as any).__voice.mute()); await new Promise(resolve => setTimeout(resolve, 1200));
  const muted = await spectrum(client); assert.ok(muted.rms < .005, JSON.stringify(muted));
  await admin.evaluate(() => (window as any).__voice.mute());
  await client.evaluate(() => (window as any).__voice.hangup());
  await admin.waitForFunction(() => (window as any).__voiceState?.phase === 'ended');
  assert.equal(await admin.evaluate(() => (window as any).__voicePeers.every((p: RTCPeerConnection) => p.connectionState === 'closed')), true);
  assert.equal(await client.evaluate(() => (window as any).__voiceTone.output.stream.getTracks().every((t: MediaStreamTrack) => t.readyState === 'ended')), true);
  assert.equal(await db.voiceCallConnection.count({ where: { callId } }), 0, 'hanging up closes all server media resources');
  assert.equal(await db.voiceMessage.count({ where: { examId } }), 0, 'a real-time call never becomes a stored voice-message clip');

  const timed = (await post('/api/voice/calls', { action: 'START', sessionId: otherSession.id }, ownerCookie)).body.data.call;
  await db.voiceCall.update({ where: { id: timed.id }, data: { createdAt: new Date(Date.now() - 46000) } });
  const expired = await post('/api/voice/calls', { action: 'POLL', callId: timed.id }, ownerCookie);
  assert.equal(expired.body.data.call.endReason, 'UNANSWERED');
  const revoked = (await post('/api/voice/calls', { action: 'START', sessionId: otherSession.id }, ownerCookie)).body.data.call;
  await db.clientSession.update({ where: { id: otherSession.id }, data: { revokedAt: new Date() } });
  assert.equal((await post('/api/voice/calls', { action: 'POLL', callId: revoked.id }, ownerCookie)).body.data.call.endReason, 'SESSION_ENDED');
  console.log(JSON.stringify({ concurrentStarts: 12, uniqueRingingCalls: 1, target: 'DESKTOP', browserPeers: 4,
    adminReceivedHz: Math.round(adminSound.frequency), desktopReceivedHz: Math.round(clientSound.frequency), muteRms: muted.rms,
    unauthorizedAndWrongSideDenied: true, hangupReleasedServerResources: true, recordedVoiceClips: 0 }));
} finally {
  await browser?.close();
  if (examId) await db.exam.delete({ where: { id: examId } });
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
}
