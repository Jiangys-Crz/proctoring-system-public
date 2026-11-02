import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { createMediaPublishToken } from '../src/lib/media-publish-token';
import { mediaApiToken } from '../src/lib/media-api-auth';

// This integration runs against an isolated QA database and media container.
// It never creates keys or publishes synthetic streams on either live server.
const database = new URL(process.env.DATABASE_URL!);
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '33309'); assert.equal(database.pathname, '/proctor_novajudge_qa');
const root = path.resolve('../..'), dir = path.join(root, 'tmp/release-1.0.4'), base = 'http://127.0.0.1:43439';
process.env.APP_BASE_URL = base;
const req = createRequire(path.join(root, 'apps/desktop/package.json')), ffmpeg = req('ffmpeg-static') as string;
const marker = 'rtc-qa-' + Date.now(), examCode = String(1000000000 + Number(BigInt('0x' + randomBytes(5).toString('hex')) % 8999999999n));
const children: ChildProcess[] = [], keyIds: string[] = [];
let adminId = '', viewerId = '', examId = '';
await mkdir(dir, { recursive: true });
const configPath = path.join(dir, 'rtc-native-config.json');
async function poll(fn: () => Promise<boolean>, message: string) { const until = Date.now() + 30000; while (Date.now() < until) { if (await fn().catch(() => false)) return; await new Promise(r => setTimeout(r, 300)); } throw Error(message); }
async function main() {
  const settingsBefore = await prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
  try {
    const admin = await prisma.user.create({ data: { username: marker, role: 'SUPER_ADMIN' } }); adminId = admin.id;
    const viewer = await prisma.user.create({ data: { username: marker + '-viewer', role: 'ADMIN' } }); viewerId = viewer.id;
    const token = createSessionToken(admin), cookie = 'cwnupaa_proctor_session=' + token;
    const request = (url: string, method = 'GET', body?: unknown, customCookie = cookie) => fetch(base + url, { method, headers: { Cookie: customCookie, Origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const exam = await prisma.exam.create({ data: { examCode, name: marker, createdById: admin.id, startAt: new Date(Date.now() - 60000), latestStartAt: new Date(Date.now() + 3600000), endAt: new Date(Date.now() + 3600000), durationMinutes: 60, platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: 'local', contestType: 'INDIVIDUAL', rules: 'Isolated WebRTC verification', requireFrontCamera: true, requireMiniProgram: true } }); examId = exam.id;
    const candidate = await prisma.candidate.create({ data: { examId, name: 'WebRTC 测试', examNumber: marker, password: randomBytes(16).toString('hex'), seatNo: 'QA' } });
    await prisma.examRoom.create({ data: { examId, name: marker, requireFrontCamera: true, requireSecondCamera: true, candidates: { create: { candidateId: candidate.id } } } });
    const session = await prisma.clientSession.create({ data: { examId, candidateId: candidate.id, status: 'IN_EXAM', startedAt: new Date(), approvedAt: new Date(), lastDesktopSeenAt: new Date(), lastMiniProgramSeenAt: new Date(), desktopTokenHash: randomBytes(32).toString('hex'), miniProgramTokenHash: randomBytes(32).toString('hex') } });
    assert.equal((await request('/api/settings/live-api-keys', 'GET', undefined, '')).status, 401);
    assert.equal((await request('/api/settings/live-api-keys', 'GET', undefined, 'cwnupaa_proctor_session=' + createSessionToken(viewer))).status, 403);
    assert.equal((await fetch(base + '/api/settings/live-api-keys', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ name: marker }) })).status, 403);
    const createKey = async (name: string) => { const r = await request('/api/settings/live-api-keys', 'POST', { name, enabled: true }); assert.equal(r.status, 201); const k = (await r.json()).data; keyIds.push(k.id); const saved = await prisma.liveApiKey.findUniqueOrThrow({ where: { id: k.id } }); assert.notEqual(saved.keyHash, k.apiKey); return k; };
    const primary = await createKey(marker), secondary = await createKey(marker + '-secondary');
    for (const [channel, color] of [['DESKTOP_SCREEN', 'red'], ['DESKTOP_CAMERA', 'green'], ['MOBILE_CAMERA', 'blue']] as const) {
      const publishToken = createMediaPublishToken(session, channel).token;
      const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=15`, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '15', '-f', 'flv', `rtmp://127.0.0.1:44935/live/${session.id}_${channel}?token=${publishToken}`], { stdio: ['ignore', 'ignore', 'pipe'] }); children.push(child);
      let errors = ''; child.stderr?.on('data', x => { errors += x.toString().replaceAll(publishToken, '[redacted]'); }); child.on('exit', () => void writeFile(path.join(dir, channel + '-rtc.log'), errors));
    }
    const mediaPaths = async () => (await (await fetch('http://127.0.0.1:44997/v3/paths/list', { headers: { Authorization: 'Bearer ' + mediaApiToken() } })).json()).items;
    await poll(async () => (await mediaPaths()).filter((x: { ready: boolean; bytesReceived: number }) => x.ready && x.bytesReceived > 0).length === 3, 'Synthetic publishers did not reach QA media');
    for (const camera of ['1', '2', '3']) { const r = await fetch(`${base}/api/${examCode}/${marker}/${camera}/apikey=${primary.apiKey}`); assert.equal(r.status, 200); assert.match(r.headers.get('content-type')!, /text\/html/); }
    assert.equal((await fetch(`${base}/api/${examCode}/${marker}/1/apikey=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/api/${examCode}/${marker}/4/apikey=${primary.apiKey}`)).status, 400);
    assert.equal((await fetch(`${base}/api/${examCode}/${marker}/1/apikey=${primary.apiKey}/index.m3u8`)).status, 400);
    await writeFile(configPath, JSON.stringify({ base, token, examId, examCode, examNumber: marker, primary, secondary, proof: path.join(dir, 'live-rtc-integration-proof.json') }), { mode: 0o600 });
    const native = spawn(path.join(root, 'apps/desktop/node_modules/.bin/electron'), [path.join(root, 'apps/web/tests/live-webrtc-native.cjs'), configPath], { cwd: root, stdio: 'inherit' }); children.push(native);
    assert.equal(await new Promise<number | null>((resolve, reject) => { native.on('exit', resolve); native.on('error', reject); }), 0);
    assert.equal(await prisma.liveWebRtcConnection.count({ where: { keyId: { in: keyIds } } }), 0);
    assert.equal((await mediaPaths()).filter((x: { ready: boolean }) => x.ready).length, 3, 'Key revocation must not stop publishers');
    assert.equal((await fetch(`${base}/api/${examCode}/${marker}/1/apikey=${primary.apiKey}`)).status, 401);
    await request('/api/settings/live-api-keys', 'PATCH', { id: primary.id, enabled: true });
    assert.equal((await fetch(`${base}/api/${examCode}/${marker}/1?apikey=${primary.apiKey}`)).status, 200);
    await prisma.clientSession.update({ where: { id: session.id }, data: { status: 'FINISHED' } });
    assert.equal((await fetch(`${base}/api/${examCode}/${marker}/1/apikey=${primary.apiKey}`)).status, 404);
    assert.deepEqual(await prisma.systemSetting.findMany({ orderBy: { key: 'asc' } }), settingsBefore);
    console.log('PASS key hashing, roles, origin protection, three WebRTC channels, revocation isolation and finished-session denial.');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await unlink(configPath).catch(() => {});
    await prisma.liveApiKey.deleteMany({ where: { id: { in: keyIds } } }); if (examId) await prisma.exam.delete({ where: { id: examId } });
    if (viewerId) await prisma.user.delete({ where: { id: viewerId } }); if (adminId) await prisma.user.delete({ where: { id: adminId } }); await prisma.$disconnect();
  }
}
void main().catch(e => { console.error(e.message); process.exitCode = 1; });
