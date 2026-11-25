// Run against an isolated local MySQL schema and the web server using that schema.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, type Page } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { createClientSessionToken } from '../src/lib/client-auth';
import { createScreenControlGroup, getAdminScreenControl, updateScreenControlGroup } from '../src/lib/screen-control';
import { normalizeScreenControlImage, removeScreenControlImage } from '../src/lib/screen-control-images';
import { screenControlTextValues } from '../src/lib/screen-control-personalization';
import { renderScreenControlImage } from '../src/lib/screen-control-render';
import { storeBuffer } from '../src/lib/storage';
import type { ScreenImageTemplate } from '../src/lib/screen-control-template';
import type { ClientSession } from '@prisma/client';

const database = new URL(process.env.DATABASE_URL || '');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname));
assert.equal(database.pathname, '/proctor_screen_personalization_qa');
const base = process.env.SCREEN_QA_BASE || 'http://127.0.0.1:43317';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const marker = `screen-template-${randomUUID()}`;
const exams: string[] = [], users: string[] = [], uploads: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let testPage: Page | undefined;
const pageErrors: string[] = [];
const artifactDir = path.resolve(process.env.SCREEN_QA_ARTIFACTS || '../../tmp/screen-personalization-qa');

try {
  const owner = await prisma.user.create({ data: { username: `${marker}-owner`, role: 'ADMIN' } }); users.push(owner.id);
  const outsider = await prisma.user.create({ data: { username: `${marker}-outsider`, role: 'ADMIN' } }); users.push(outsider.id);
  const newExam = async (contestType: 'INDIVIDUAL' | 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT' = 'MEMBER_ACCOUNTS') => {
    const exam = await prisma.exam.create({ data: {
      name: `${contestType === 'TEAM' ? '团队赛' : '个人赛'}图片测试`, examCode: String(randomInt(1_000_000_000, 10_000_000_000)), createdById: owner.id,
      startAt: new Date('2099-01-01'), latestStartAt: new Date('2099-01-01'), endAt: new Date('2099-01-02'), durationMinutes: 120,
      platform: 'HYDRO', platformBaseUrl: 'https://judge.invalid', platformContestId: marker,
      contestType, teamAccountMode, contestRule: 'XCPC', rules: '', requireMiniProgram: false, requireFrontCamera: false,
    } }); exams.push(exam.id); return exam;
  };
  const individual = await newExam('INDIVIDUAL'), membersExam = await newExam('TEAM'), accountExam = await newExam('TEAM', 'TEAM_ACCOUNT');
  const newCandidate = (examId: string, name: string, examNumber: string, extra: Record<string, string> = {}) => prisma.candidate.create({ data: {
    examId, name, examNumber, seatNo: examNumber, password: `${marker}-private`, school: '西华师范大学', college: '计算机学院', groupName: 'official', ...extra,
  } });
  const alice = await newCandidate(individual.id, '张三', '001'), bob = await newCandidate(individual.id, '李四', '002');
  const teammate1 = await newCandidate(membersExam.id, '张三', '001', { teamName: '星辰算法队' });
  const teammate2 = await newCandidate(membersExam.id, '王五', '002', { teamName: '星辰算法队', college: '数学学院' });
  await newCandidate(membersExam.id, '其他队员', '003', { teamName: '另一支队伍' });
  const account = await newCandidate(accountExam.id, '', '001', { teamName: '星辰算法队', teamMembers: '赵六、孙七、周八', groupName: 'girl' });
  const tokens = [alice, bob, teammate1, teammate2, account].map(() => createClientSessionToken());
  const sessions: ClientSession[] = [];
  for (const [i, candidate] of [alice, bob, teammate1, teammate2, account].entries()) {
    sessions.push(await prisma.clientSession.create({ data: { examId: candidate.examId, candidateId: candidate.id, status: 'WAITING_REVIEW', desktopTokenHash: tokens[i].tokenHash } }));
  }
  const background = await normalizeScreenControlImage(await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#f3f7f4' } })
    .composite([{ input: Buffer.from('<svg width="1000" height="600"><rect x="40" y="40" width="920" height="520" rx="16" fill="white" stroke="#b8d2c0"/><path d="M80 110H920" stroke="#28845b" stroke-width="6"/></svg>') }]).png().toBuffer());
  const makeGroup = async (examId: string, count = 1) => {
    const stored = await storeBuffer(background.buffer, { filename: 'screen.webp', prefix: `screen-control/${examId}`, contentType: background.contentType });
    uploads.push(stored.objectPath);
    const { buffer: _buffer, ...metadata } = background;
    return createScreenControlGroup(examId, '比赛须知', Array.from({ length: count }, (_, index) => ({ ...metadata, name: `须知${index + 1}.png`, objectPath: stored.objectPath })), owner.id);
  };
  const group = await makeGroup(individual.id, 3), memberGroup = await makeGroup(membersExam.id), accountGroup = await makeGroup(accountExam.id);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1100 } });
  context.setDefaultTimeout(30_000);
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(owner), url: base }]);
  const request = async (url: string, method = 'GET', body?: unknown, asOutsider = false) => fetch(`${base}${url}`, {
    method, headers: { cookie: `cwnupaa_proctor_session=${createSessionToken(asOutsider ? outsider : owner)}`, origin: base, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const controlBase = `/api/exams/${individual.id}/screen-control`;
  const page = await context.newPage(); testPage = page;
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${base}/dashboard/exams/${individual.id}/screen`);
  const participantToggle = page.getByRole('switch', { name: '本次轮播展示参赛信息图' });
  await participantToggle.waitFor();
  assert.equal(await participantToggle.isChecked(), false);
  assert.equal(await page.getByRole('button', { name: '添加考生信息', exact: true }).count(), 0);
  await page.locator('.screen-control-groups .screen-control-preview-strip button').first().click();
  const originalDialog = page.getByRole('dialog', { name: '原图预览' });
  const download = page.waitForEvent('download');
  await originalDialog.getByRole('link', { name: '下载原图' }).click();
  assert.equal((await download).suggestedFilename(), '须知1.webp');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await originalDialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await originalDialog.getByRole('button', { name: '关闭预览' }).click();
  await page.setViewportSize({ width: 1480, height: 1100 });
  await mkdir(artifactDir, { recursive: true });
  const template: ScreenImageTemplate = { version: 1, blocks: [{
    id: 'legacy', content: '姓名：<name>\\n学校：<school>', x: 10, y: 20, width: 80, height: 50,
    fontSize: 40, fontFamily: 'SANS', alignment: 'left', color: '#172033', bold: true,
  }] };
  await updateScreenControlGroup(individual.id, group.id, {
    templates: group.images.slice(0, 2).map(image => ({ imageId: image.id, template })),
  });
  const saved = (await getAdminScreenControl(individual.id)).groups[0];
  assert.deepEqual(saved.images[0].template, saved.images[1].template);
  assert.equal(saved.images[2].template?.blocks.length || 0, 0);
  console.log('Checking persisted templates, authorization and legacy client images.');
  const groupPath = `${controlBase}/groups/${group.id}`;
  assert.equal((await request(groupPath, 'PATCH', { templates: [{ imageId: memberGroup.images[0].id, template }] })).status, 400);
  assert.equal((await request(groupPath, 'PATCH', { templates: [{ imageId: group.images[0].id, template }, { imageId: group.images[0].id, template }] })).status, 400);
  assert.equal((await request(groupPath, 'PATCH', { templates: [{ imageId: group.images[0].id, template }], expectedUpdatedAt: group.updatedAt })).status, 409);
  assert.equal((await request(groupPath, 'PATCH', { templates: [{ imageId: group.images[0].id, template: { version: 1, blocks: [{ ...template.blocks[0], content: '<members>' }] } }] })).status, 400);
  assert.equal((await request(`${controlBase}/template-data`, 'GET', undefined, true)).status, 403);
  const options = await (await request(`${controlBase}/template-data?q=李四`)).json();
  assert.deepEqual(Object.keys(options.data.candidates[0]).sort(), ['examNumber', 'id', 'name', 'teamName']);
  assert.equal(options.data.candidates[0].id, bob.id);
  const previewPath = `${controlBase}/images/${group.images[0].id}/preview`;
  assert.equal((await request(previewPath, 'POST', { template, candidateId: alice.id }, true)).status, 403);
  assert.equal((await request(previewPath, 'POST', { template, candidateId: teammate1.id })).status, 404);
  const previewResponse = await request(previewPath, 'POST', { template, candidateId: alice.id });
  assert.equal(previewResponse.status, 200);
  const previewBytes = Buffer.from(await previewResponse.arrayBuffer());
  assert.deepEqual(previewBytes, await renderScreenControlImage(background.buffer, template, await screenControlTextValues(individual.id, alice.id)));
  const pushed = await request(controlBase, 'POST', { groupId: group.id }); assert.equal(pushed.status, 201);
  const legacy = (await pushed.json()).data;
  await prisma.screenControlDisplay.update({ where: { id: legacy.id }, data: { showParticipantCard: null } });
  assert.equal((await request(groupPath, 'PATCH', { templates: [{ imageId: group.images[0].id, template }] })).status, 409);
  const readClient = (sessionIndex: number, imageId: string, extra = '') => fetch(`${base}/api/client/screen-control/images/${imageId}?sessionId=${sessions[sessionIndex].id}${extra}`, { headers: { 'x-proctor-session-token': tokens[sessionIndex].token } });
  const aliceImage = await readClient(0, group.images[0].id), bobImage = await readClient(1, group.images[0].id);
  assert.equal(aliceImage.status, 200); assert.equal(bobImage.status, 200);
  assert.equal(aliceImage.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await aliceImage.arrayBuffer()), previewBytes, 'preview must match the actual legacy client image');
  assert.notDeepEqual(Buffer.from(await bobImage.arrayBuffer()), previewBytes, 'each candidate gets their own information');
  assert.deepEqual(Buffer.from(await (await readClient(0, group.images[0].id, `&candidateId=${bob.id}`)).arrayBuffer()), previewBytes, 'candidate query parameters cannot change the session identity');
  assert.deepEqual(Buffer.from(await (await readClient(0, group.images[2].id)).arrayBuffer()), background.buffer);
  assert.equal((await readClient(2, group.images[0].id)).status, 403);
  const state = await (await fetch(`${base}/api/client/screen-control?sessionId=${sessions[0].id}`, { headers: { 'x-proctor-session-token': tokens[0].token } })).json();
  assert.equal(state.data.active.images[0].url, `/api/client/screen-control/images/${group.images[0].id}?sessionId=${sessions[0].id}`);
  assert.equal(state.data.active.images[0].template, undefined);
  assert.equal(state.data.active.intervalMs, 5000);
  await prisma.clientSession.update({ where: { id: sessions[1].id }, data: { revokedAt: new Date() } });
  assert.equal((await readClient(1, group.images[0].id)).status, 401);

  const readState = async (sessionIndex: number) => (await (await fetch(`${base}/api/client/screen-control?sessionId=${sessions[sessionIndex].id}`, {
    headers: { 'x-proctor-session-token': tokens[sessionIndex].token },
  })).json()).data.active;
  const readParticipant = async (sessionIndex: number, id: string, extra = '') => {
    const response = await readClient(sessionIndex, id, extra);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.format], [1920, 1080, 'webp']);
    return bytes;
  };

  await participantToggle.check();
  const nextPush = page.waitForResponse(response => response.url() === base + controlBase && response.request().method() === 'POST');
  await page.getByRole('button', { name: '立即推送', exact: true }).click();
  assert.equal((await nextPush).status(), 201);
  const next = await readState(0);
  assert.equal(next.intervalMs, 5000);
  assert.deepEqual(next.images.slice(0, 3).map((image: { id: string }) => image.id), group.images.map(image => image.id));
  const cardId = next.images[3].id;
  assert.equal(cardId, 'participant-' + next.id);
  assert.deepEqual(Buffer.from(await (await readClient(0, group.images[0].id)).arrayBuffer()), background.buffer);
  const individualCard = await readParticipant(0, cardId);
  assert.deepEqual(await readParticipant(0, cardId, `&candidateId=${bob.id}`), individualCard);
  assert.equal((await readClient(2, cardId)).status, 403);
  await writeFile(path.join(artifactDir, 'individual-card.webp'), individualCard);

  for (const [index, [exam, images]] of [[membersExam, memberGroup], [accountExam, accountGroup]].entries()) {
    await prisma.exam.update({ where: { id: exam.id }, data: { reactionLogoMatchBy: 'COLLEGE' } });
    const response = await request(`/api/exams/${exam.id}/screen-control`, 'POST', { groupId: images.id, showParticipantCard: true });
    assert.equal(response.status, 201);
    const sessionIndex = index ? 4 : 2;
    const active = await readState(sessionIndex);
    const teamCard = await readParticipant(sessionIndex, active.images[1].id);
    assert.notDeepEqual(teamCard, individualCard);
    await writeFile(path.join(artifactDir, `team-card-${index}.webp`), teamCard);
    await prisma.exam.update({ where: { id: exam.id }, data: { reactionLogoMatchBy: 'SCHOOL' } });
    assert.notDeepEqual(await readParticipant(sessionIndex, active.images[1].id), teamCard);
  }

  const plain = await request(controlBase, 'POST', { groupId: group.id });
  assert.equal(plain.status, 201);
  assert.equal((await readState(0)).images.length, group.images.length);
  assert.equal((await readClient(0, cardId)).status, 403);
  assert.deepEqual(pageErrors, []);
  console.log('PASS: original download, legacy layouts, optional participant slide, individual and team cards, Reaction match mode, and session isolation.');
} catch (error) {
  await mkdir(artifactDir, { recursive: true });
  console.error('Browser errors:', pageErrors);
  console.error('Visible dialog:', await testPage?.locator('.screen-control-original-dialog').innerText({ timeout: 1000 }).catch(() => 'No dialog'));
  await testPage?.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await prisma.screenControlDisplay.deleteMany({ where: { examId: { in: exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await Promise.allSettled(uploads.map(removeScreenControlImage));
  await prisma.$disconnect();
}
