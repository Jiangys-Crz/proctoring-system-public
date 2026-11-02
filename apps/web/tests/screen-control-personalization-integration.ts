// Run against an isolated local MySQL schema and the web server using that schema.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
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
  await page.getByRole('button', { name: '添加考生信息', exact: true }).click();
  console.log('Checking template editor controls.');
  await page.getByRole('button', { name: '添加文字块', exact: true }).click();
  await page.getByLabel('文字内容', { exact: true }).fill('姓名：<name>\n学校：<school>\n学院：<college>\n组别：<group>');
  await page.getByLabel('文字框高（%）', { exact: true }).fill('50');
  await page.getByLabel('字号（1000 像素图）', { exact: true }).fill('40');
  const dragBox = page.getByRole('button', { name: '定位文字块 1', exact: true });
  await dragBox.scrollIntoViewIfNeeded();
  const rect = (await dragBox.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 + 25, rect.y + rect.height / 2 + 18, { steps: 5 }); await page.mouse.up();
  assert.ok(Number(await page.getByLabel('横向位置（%）', { exact: true }).inputValue()) > 10);
  console.log('Checking candidate preview and selected image layouts.');
  const realPreviewResponse = page.waitForResponse(response => response.url().endsWith(`/images/${group.images[0].id}/preview`) && response.ok() && response.request().postDataJSON().candidateId === alice.id);
  await page.getByLabel('预览身份', { exact: true }).selectOption(alice.id);
  await realPreviewResponse;
  await page.locator('.screen-template-images input[type="checkbox"]').nth(0).check();
  await page.locator('.screen-template-images input[type="checkbox"]').nth(1).check();
  await page.getByRole('button', { name: '将当前布局应用到所选 2 张图片', exact: true }).click();
  await page.getByRole('button', { name: '查看成品', exact: true }).click();
  await page.getByText('实际考生资料', { exact: true }).waitFor();
  assert.equal(await page.locator('.screen-template-properties').evaluate(element => element.scrollWidth <= element.clientWidth), true, 'long template content must not overflow the properties panel');
  assert.equal(await page.locator('.screen-template-dialog').evaluate(element => {
    const bounds = element.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  }), true, 'dialog must remain within the viewport after opening from a scrolled page');
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, 'individual-editor.png'), fullPage: true });
  await page.getByRole('button', { name: '保存全部图片', exact: true }).click();
  await page.getByText('考生信息模板已保存，推送时将自动生成各考生对应的图片', { exact: true }).waitFor();
  const saved = (await getAdminScreenControl(individual.id)).groups[0];
  assert.deepEqual(saved.images[0].template, saved.images[1].template);
  assert.equal(saved.images[2].template?.blocks.length || 0, 0);
  const template = saved.images[0].template!;
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

  const teamTemplate: ScreenImageTemplate = { version: 1, blocks: [{ ...template.blocks[0], content: '队伍：<teamname>\n成员：<members>\n学校：<school>\n学院：<college>\n组别：<group>' }] };
  console.log('Checking both team account modes.');
  for (const [exam, images] of [[membersExam, memberGroup], [accountExam, accountGroup]] as const) {
    await updateScreenControlGroup(exam.id, images.id, { templates: [{ imageId: images.images[0].id, template: teamTemplate }] });
    assert.equal((await request(`/api/exams/${exam.id}/screen-control`, 'POST', { groupId: images.id })).status, 201);
  }
  const memberValues = await screenControlTextValues(membersExam.id, teammate1.id);
  assert.equal(memberValues.members, '张三、王五'); assert.equal(memberValues.college, '计算机学院、数学学院'); assert.equal(memberValues.group, '正式参赛');
  const otherMemberValues = await screenControlTextValues(membersExam.id, teammate2.id);
  assert.equal(memberValues.teamname, otherMemberValues.teamname); assert.equal(memberValues.members, otherMemberValues.members);
  assert.equal(memberValues.school, otherMemberValues.school); assert.equal(memberValues.college, otherMemberValues.college);
  const teammateImage1 = Buffer.from(await (await readClient(2, memberGroup.images[0].id)).arrayBuffer());
  const teammateImage2 = Buffer.from(await (await readClient(3, memberGroup.images[0].id)).arrayBuffer());
  assert.deepEqual(teammateImage1, teammateImage2);
  assert.deepEqual(teammateImage1, await renderScreenControlImage(background.buffer, teamTemplate, memberValues));
  const accountValues = await screenControlTextValues(accountExam.id, account.id);
  assert.equal(accountValues.members, '赵六、孙七、周八'); assert.equal(accountValues.group, '女生队伍');
  assert.deepEqual(Buffer.from(await (await readClient(4, accountGroup.images[0].id)).arrayBuffer()), await renderScreenControlImage(background.buffer, teamTemplate, accountValues));

  // A locked group remains previewable and the dialog works on narrow screens.
  await page.reload();
  await page.locator('.screen-control-groups .screen-control-preview-strip button').first().click();
  await page.getByLabel('预览身份', { exact: true }).selectOption(alice.id);
  await page.getByText('实际考生资料', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, 'individual-preview.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifactDir, 'mobile-preview.png'), fullPage: true });
  assert.equal(await page.locator('.screen-template-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 1480, height: 1100 });
  await page.goto(`${base}/dashboard/exams/${membersExam.id}/screen`);
  await page.locator('.screen-control-groups .screen-control-preview-strip button').first().click();
  await page.getByLabel('预览身份', { exact: true }).selectOption(teammate1.id);
  await page.getByText('实际考生资料', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, 'team-preview.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);
  console.log('PASS: drag editor, save/reopen, selected multi-image layouts, candidate preview, original image fallback, stale/foreign/duplicate template rejection, active group lock, image/token/exam isolation, unchanged desktop protocol, both team account modes, desktop and mobile previews.');
} catch (error) {
  await mkdir(artifactDir, { recursive: true });
  console.error('Browser errors:', pageErrors);
  console.error('Visible dialog:', await testPage?.locator('.screen-template-dialog').innerText({ timeout: 1000 }).catch(() => 'No dialog'));
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
