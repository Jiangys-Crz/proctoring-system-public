// Start a production test server against the same disposable DB before running.
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { storeBuffer } from '../src/lib/storage';
import { uploadDesktopArtifact, publishDesktopRelease } from '../src/lib/desktop-releases';
import { chromium } from 'playwright-core';

const base = process.env.FILE_QA_BASE!;
assert.ok(base?.startsWith('http://127.0.0.1:4341'));
const marker = 'http-delete-' + randomUUID(), users: string[] = [], exams: string[] = [], assets: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const admin = await prisma.user.create({ data: { username: marker, role: 'SUPER_ADMIN' } }); users.push(admin.id);
  const owner = await prisma.user.create({ data: { username: marker + '-owner', role: 'ADMIN' } }); users.push(owner.id);
  const viewer = await prisma.user.create({ data: { username: marker + '-viewer', role: 'ADMIN' } }); users.push(viewer.id);
  const cookie = (u: typeof admin) => 'cwnupaa_proctor_session=' + createSessionToken(u);
  async function request(url: string, user: typeof admin | null = admin, method = 'GET', body?: unknown, origin?: string) {
    return fetch(base + url, { method, headers: { ...(user ? { cookie: cookie(user) } : {}), 'content-type': 'application/json', ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual' });
  }
  const now = Date.now();
  const exam = await prisma.exam.create({ data: { examCode: String(randomInt(1000000000,10000000000)), name: marker,
    startAt: new Date(now - 3600000), latestStartAt: new Date(now - 1800000), endAt: new Date(now - 60000), durationMinutes: 60,
    platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker, contestType: 'INDIVIDUAL', rules: marker, createdById: owner.id } }); exams.push(exam.id);
  const room = await prisma.examRoom.create({ data: { examId: exam.id, name: 'QA Room', proctors: { create: { userId: viewer.id } } } });
  const candidate = await prisma.candidate.create({ data: { examId: exam.id, examNumber: marker, password: marker, seatNo: 'QA', rooms: { create: { roomId: room.id } } } });
  const stored = await storeBuffer(Buffer.from(marker), { prefix: `${exam.id}/${candidate.id}`, filename: 'qa.webm' });
  await prisma.mediaSegment.create({ data: { examId: exam.id, candidateId: candidate.id, channel: 'DESKTOP_CAMERA', objectPath: stored.objectPath, byteSize: marker.length } });
  const alert = await prisma.alert.create({ data: { examId: exam.id, candidateId: candidate.id, type: 'PROCESS_POLICY', message: marker } });
  const exe = Buffer.alloc(2048); exe.write('MZ'); exe.writeUInt32LE(128,60); exe.write('PE\0\0',128);
  async function asset(version: string) {
    const a = await uploadDesktopArtifact(new Request(base + `/upload?target=windows&kind=installer&version=${version}`, { method: 'POST', headers: { 'content-length': String(exe.length) }, body: Uint8Array.from(exe) }), admin.id); assets.push(a.id); return a;
  }
  const old = await asset('8.1.0'), active = await asset('8.2.0');
  for (const a of [old, active]) await publishDesktopRelease({ channel: 'public', target: 'windows', version: a.version, installerId: a.id, updateId: a.id, notes: '', installationMode: 'manual' });
  assert.equal((await request('/api/settings/desktop-releases', null, 'DELETE', { ids: [old.id] })).status, 401);
  assert.equal((await request('/api/settings/desktop-releases', owner, 'DELETE', { ids: [old.id] })).status, 403);
  assert.equal((await request('/api/settings/desktop-releases', admin, 'DELETE', { ids: [old.id] }, 'https://evil.example')).status, 403);
  assert.equal((await request('/api/settings/desktop-releases', admin, 'DELETE', { ids: [old.id, active.id] })).status, 409);
  assert.equal((await request(`/api/settings/desktop-releases/files/${old.id}`, owner)).status, 403);
  assert.equal((await request(`/api/settings/desktop-releases/files/${old.id}`)).status, 200);
  assert.equal((await request('/api/recordings', null, 'DELETE', { examIds: [exam.id] })).status, 401);
  assert.equal((await request('/api/recordings', viewer, 'DELETE', { examIds: [exam.id] })).status, 403);
  assert.equal((await request('/api/recordings', owner, 'DELETE', { examIds: [exam.id] }, 'https://evil.example')).status, 403);
  const records = (await (await request('/api/recordings', owner)).json()).data;
  assert.equal(records.find((e: { id: string }) => e.id === exam.id).canDelete, true);
  assert.equal(records.find((e: { id: string }) => e.id === exam.id).mediaCount, 1, 'full-only footage is visible for deletion');
  const viewed = (await (await request('/api/recordings', viewer)).json()).data;
  assert.equal(viewed.find((e: { id: string }) => e.id === exam.id).canDelete, false);
  const result = (await (await request('/api/settings/desktop-releases')).json()).data;
  assert.equal(result.artifacts.find((a: { id: string }) => a.id === old.id).status, 'historical');
  assert.equal(result.artifacts.find((a: { id: string }) => a.id === active.id).status, 'active');
  assert.equal((await request('/api/file-cleanup?kind=INSTALLER', owner)).status, 403);
  assert.equal((await request('/api/file-cleanup', owner, 'POST', { kind: 'INSTALLER' })).status, 403);

  // Real browser verification: panels render, current installers stay protected,
  // and a room proctor can view footage without receiving deletion controls.
  const executablePath = process.env.FILE_QA_CHROMIUM;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.context().addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(admin), url: base }]);
  await page.goto(base + '/dashboard/system');
  await page.getByRole('button', { name: '客户端发布与安装包管理' }).click();
  await page.getByRole('heading', { name: '安装包文件管理' }).waitFor();
  if (process.env.FILE_QA_SCREENSHOT_DIR) await page.screenshot({ path: process.env.FILE_QA_SCREENSHOT_DIR + '/installers.png', fullPage: true });
  const row = page.getByRole('row').filter({ hasText: active.name });
  assert.equal(await row.getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
  await page.context().clearCookies(); await page.context().addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(owner), url: base }]);
  await page.goto(base + '/dashboard/recordings');
  await page.getByRole('button', { name: '删除整场录像' }).waitFor();
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: '删除所选考试录像' }).waitFor();
  if (process.env.FILE_QA_SCREENSHOT_DIR) await page.screenshot({ path: process.env.FILE_QA_SCREENSHOT_DIR + '/recordings.png', fullPage: true });
  await page.context().clearCookies(); await page.context().addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(viewer), url: base }]);
  await page.goto(base + '/dashboard/recordings'); await page.getByRole('heading', { name: '历史录像' }).waitFor();
  await page.getByRole('button', { name: new RegExp(marker) }).waitFor();
  assert.equal(await page.getByRole('button', { name: '删除整场录像' }).count(), 0);
  assert.deepEqual(errors, []);

  assert.equal((await request('/api/recordings', owner, 'DELETE', { alertIds: [alert.id] })).status, 200);
  const candidateRecords = (await (await request(`/api/recordings?candidateId=${candidate.id}`, owner)).json()).data;
  assert.equal(candidateRecords.total, 0, 'deleted evidence disappears while the audit alert remains');
  assert.equal((await request('/api/recordings', owner, 'DELETE', { examIds: [exam.id] })).status, 200);
  assert.equal((await request('/api/settings/desktop-releases', admin, 'DELETE', { ids: [old.id] })).status, 200);
  assert.equal((await request(`/api/desktop/releases/files/${old.id}.exe`)).status, 404);
  assert.equal((await request(`/api/desktop/releases/files/${active.id}.exe`)).status, 200);
  console.log('PASS: real HTTP authorization and origin checks; batch active-release protection; admin downloads; owner/viewer recording scopes; full-only counts; deletion endpoints and revoked downloads; browser panels and controls; no client runtime errors.');
} finally {
  await browser?.close();
  await prisma.fileDeletionJob.deleteMany({ where: { requestedById: { in: users } } });
  await prisma.systemSetting.deleteMany({ where: { key: { in: [...assets.flatMap(id => ['desktop.asset.' + id, 'desktop.published.' + id]), 'desktop.active.unified.windows'] } } });
  await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
}
