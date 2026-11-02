// Start a test server against a disposable database before running this test.
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { parseCandidateCsv, mergeTeamCandidateRows } from '../src/lib/candidate-import';
import { chromium } from 'playwright-core';
import * as XLSX from 'xlsx';

assert.ok(process.env.DATABASE_URL?.includes('/proctor_candidate_room_qa'), 'Use only the disposable QA database');
const base = process.env.CANDIDATE_ROOM_QA_BASE!;
assert.equal(base, 'http://127.0.0.1:4341');
const marker = 'room-import-' + randomUUID(), users: string[] = [], exams: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const owner = await prisma.user.create({ data: { username: marker, numberId: marker, realName: '测试监考', role: 'SUPER_ADMIN' } }); users.push(owner.id);
  const outsider = await prisma.user.create({ data: { username: marker + '-outsider', role: 'ADMIN' } }); users.push(outsider.id);
  async function exam(contestType: 'INDIVIDUAL' | 'TEAM' = 'INDIVIDUAL', teamAccountMode: 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT' = 'MEMBER_ACCOUNTS') {
    const row = await prisma.exam.create({ data: { examCode: String(randomInt(1000000000, 10000000000)), name: marker,
      startAt: new Date(), latestStartAt: new Date(), endAt: new Date(Date.now() + 3600000), durationMinutes: 60,
      platform: 'HYDRO', platformBaseUrl: 'http://localhost', platformContestId: marker, contestType, teamAccountMode, contestRule: 'ACM', rules: '', createdById: owner.id } });
    exams.push(row.id); return row;
  }
  async function request(examId: string, rows: unknown[], user = owner) {
    return fetch(`${base}/api/exams/${examId}/candidates`, { method: 'POST', headers: {
      cookie: 'cwnupaa_proctor_session=' + createSessionToken(user), 'content-type': 'application/json'
    }, body: JSON.stringify({ rows }) });
  }
  const single = await exam(), other = await exam(), team = await exam('TEAM'), account = await exam('TEAM', 'TEAM_ACCOUNT');
  const a = await prisma.examRoom.create({ data: { examId: single.id, name: '第一考室', requireFrontCamera: false, loginReviewMode: 'AUTO', proctors: { create: { userId: owner.id } } } });
  const b = await prisma.examRoom.create({ data: { examId: single.id, name: '第二考室', requireSecondCamera: false, proctors: { create: { userId: owner.id } } } });
  await prisma.examRoom.create({ data: { examId: other.id, name: '其他考试考室' } });
  const teamA = await prisma.examRoom.create({ data: { examId: team.id, name: '第一考室' } });
  const teamB = await prisma.examRoom.create({ data: { examId: team.id, name: '第二考室' } });
  const accountRoom = await prisma.examRoom.create({ data: { examId: account.id, name: '第一考室' } });
  const rows = parseCandidateCsv('姓名,学号,学校,考号,密码,座位号,考室\n张三,001,学校,1001,pw,A01, 第一考室 \n李四,002,学校,1002,pw,A02,');
  assert.equal((await request(single.id, rows, outsider)).status, 403);
  const imported = await request(single.id, rows); assert.equal(imported.status, 200);
  const candidates = (await imported.json()).data.candidates;
  const roomsFor = async (candidateId: string) => (await prisma.examRoomCandidate.findMany({ where: { candidateId } })).map(r => r.roomId);
  assert.deepEqual(await roomsFor(candidates[0].id), [a.id]);
  assert.deepEqual(await roomsFor(candidates[1].id), []);
  assert.equal((await request(single.id, [{ ...rows[0], roomName: '' }])).status, 200);
  assert.deepEqual(await roomsFor(candidates[0].id), [a.id], 'blank reimport preserves an existing assignment');
  assert.equal((await request(single.id, [{ ...rows[0], roomName: '第二考室' }])).status, 200);
  assert.deepEqual(await roomsFor(candidates[0].id), [b.id], 'reassignment removes the old room');
  const badRoom = await request(single.id, [{ ...rows[0], name: '不应保存', roomName: '第一考室' }, { ...rows[1], roomName: '其他考试考室' }]);
  assert.equal(badRoom.status, 400);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidates[0].id } })).name, '张三');
  assert.deepEqual(await roomsFor(candidates[0].id), [b.id]);
  const duplicate = await request(single.id, [{ ...rows[0], name: '不应保存', roomName: '第一考室' }, { ...rows[1], examNumber: '1001' }]);
  assert.equal(duplicate.status, 400, 'late candidate validation rolls back preceding updates');
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidates[0].id } })).name, '张三');
  assert.deepEqual(await roomsFor(candidates[0].id), [b.id]);

  const members = rows.map((row, index) => ({ ...row, teamName: '一队', isTeamLeader: index === 0, roomName: index === 0 ? '第一考室' : '' }));
  const teamImported = await request(team.id, members); assert.equal(teamImported.status, 200);
  const teamMembers = (await teamImported.json()).data.candidates;
  for (const member of teamMembers) assert.deepEqual(await roomsFor(member.id), [teamA.id]);
  assert.equal((await request(team.id, [{ ...members[0], roomName: '第二考室' }])).status, 200);
  for (const member of teamMembers) assert.deepEqual(await roomsFor(member.id), [teamB.id], 'existing teammates move together');
  assert.equal((await request(team.id, [{ ...members[0], roomName: '第一考室' }, { ...members[1], roomName: '第二考室' }])).status, 400);
  for (const member of teamMembers) assert.deepEqual(await roomsFor(member.id), [teamB.id]);
  const teamRows = mergeTeamCandidateRows(parseCandidateCsv('队伍名称,姓名,学号,考号,密码,学校,座位号,考室\n一队,张三,001,T1001,pw,学校,A01,\n一队,李四,002,,,学校,,第一考室'));
  const accountImported = await request(account.id, teamRows); assert.equal(accountImported.status, 200);
  assert.deepEqual(await roomsFor((await accountImported.json()).data.candidates[0].id), [accountRoom.id]);
  if (process.env.CANDIDATE_ROOM_QA_CHROMIUM) {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CANDIDATE_ROOM_QA_CHROMIUM });
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(owner), url: base }]);
    for (const e of [single, team, account]) {
      await page.goto(`${base}/dashboard/exams/${e.id}/settings/candidates`);
      await page.getByRole('button', { name: '新增考生', exact: true }).click();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载模板', exact: true }).click()]);
      const stream = await download.createReadStream(); assert.ok(stream);
      const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const workbook = XLSX.read(Buffer.concat(chunks), { type: 'buffer' });
      const sheetRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
      assert.ok(sheetRows[0].includes('考室'), 'all three UI templates include the optional room column');
      assert.equal(sheetRows[1][sheetRows[0].indexOf('考室')], '');
      const input = page.locator('.candidate-import-box input[type=file]');
      await input.setInputFiles({ name: '考生导入模板.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.concat(chunks) });
      await page.locator('.candidate-import-box [role=status]').filter({ hasText: '已识别 1 条考生数据' }).waitFor();
      assert.equal(await input.evaluate((element: HTMLInputElement) => element.files?.[0]?.name), '考生导入模板.xlsx', 'successful reads retain the selected filename');
      assert.ok(await page.getByRole('button', { name: '批量导入考生', exact: true }).isEnabled());
      assert.equal(await page.locator('.candidate-import-box tbody tr').count(), 1, 'Excel upload shows a preview for all contest modes');
      const emptyBook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(emptyBook, XLSX.utils.aoa_to_sheet([sheetRows[0]]), '空模板');
      await input.setInputFiles({ name: '空模板.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(emptyBook, { type: 'buffer', bookType: 'xlsx' }) });
      await page.locator('.candidate-import-box [role=alert]').filter({ hasText: '没有考生数据' }).waitFor();
      assert.ok(await page.getByRole('button', { name: '批量导入考生', exact: true }).isDisabled(), 'failed reads clear previously loaded data');
      await input.setInputFiles({ name: '考生导入模板.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.concat(chunks) });
      await page.locator('.candidate-import-box [role=status]').filter({ hasText: '已识别 1 条考生数据' }).waitFor();
      assert.equal(await page.locator('.candidate-import-box [role=alert]').count(), 0, 'selecting a valid file again clears the previous error');
    }
    await page.goto(`${base}/dashboard/exams/${single.id}/settings/candidates`);
    await page.getByRole('button', { name: '新增考生', exact: true }).click();
    await page.locator('.candidate-import-box input[type=file]').setInputFiles({ name: 'room-import.csv', mimeType: 'text/csv', buffer: Buffer.from('姓名,学号,学校,考号,密码,座位号,考室\n王五,003,学校,1003,pw,A03,第一考室') });
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith(`/api/exams/${single.id}/candidates`) && r.request().method() === 'POST'), page.getByRole('button', { name: '批量导入考生', exact: true }).click()]);
    assert.equal(response.status(), 200, JSON.stringify(await response.json()));
    const created = await prisma.candidate.findFirstOrThrow({ where: { examId: single.id, examNumber: '1003' } });
    assert.deepEqual(await roomsFor(created.id), [a.id], 'uploaded CSV assigns the room through the actual UI');
    assert.equal(created.studentId, '003', 'CSV import preserves leading zeroes');
    await page.locator('.candidate-import-box').waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: '新增考生', exact: true }).click();
    const editor = page.locator('.modal-panel').filter({ has: page.getByRole('heading', { name: '添加考生', exact: true }) });
    for (const [label, value] of Object.entries({ 姓名: '手动新增', 学号: '004', 学校: '学校', 考号: '1004', 密码: 'pw', 座位号: 'A04' })) {
      await editor.getByLabel(label, { exact: true }).fill(value);
    }
    await editor.getByLabel(/^考室/).selectOption(a.id);
    const [assigned] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith(`/api/exams/${single.id}/rooms`) && r.request().method() === 'POST'),
      editor.getByRole('button', { name: '保存考生', exact: true }).click(),
    ]);
    assert.equal(assigned.status(), 201, JSON.stringify(await assigned.json()));
    await editor.waitFor({ state: 'hidden' });
    const manual = await prisma.candidate.findFirstOrThrow({ where: { examId: single.id, examNumber: '1004' } });
    assert.deepEqual(await roomsFor(manual.id), [a.id], 'manual candidate creation assigns the existing room');
    assert.equal(await prisma.examRoom.count({ where: { examId: single.id } }), 2, 'assignment never creates a duplicate room');
    assert.equal((await prisma.examRoom.findUniqueOrThrow({ where: { id: a.id } })).requireFrontCamera, false, 'assignment preserves room settings');
    assert.equal((await prisma.examRoom.findUniqueOrThrow({ where: { id: a.id } })).loginReviewMode, 'AUTO');
    assert.deepEqual((await prisma.examRoomProctor.findMany({ where: { roomId: a.id } })).map(row => row.userId), [owner.id]);

    await page.getByRole('cell', { name: '1004', exact: true }).waitFor();
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: '1004', exact: true }) }).getByRole('button', { name: '修改', exact: true }).click();
    const edit = page.locator('.modal-panel').filter({ has: page.getByRole('heading', { name: '修改考生信息', exact: true }) });
    await edit.getByLabel('考号', { exact: true }).fill('1004b');
    await edit.getByLabel(/^考室/).selectOption(b.id);
    await edit.getByRole('button', { name: '保存考生', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
    assert.deepEqual(await roomsFor(manual.id), [b.id], 'editing an exam account and moving rooms removes the old assignment');
    assert.equal((await prisma.examRoom.findUniqueOrThrow({ where: { id: b.id } })).requireSecondCamera, false);

    await page.goto(`${base}/dashboard/exams/${single.id}/settings/rooms`);
    await page.locator('.room-card').filter({ has: page.getByText('第一考室', { exact: true }) }).getByRole('button', { name: '编辑考室', exact: true }).click();
    const roomEditor = page.locator('.modal-panel').filter({ has: page.getByRole('heading', { name: '修改考室', exact: true }) });
    await roomEditor.getByRole('button', { name: '添加考生', exact: true }).click();
    const add = page.locator('.room-inline-dialog');
    await add.getByLabel(/^添加方式/).selectOption('STUDENT_ID');
    await add.getByLabel('考生学号', { exact: true }).fill('002\nunknown');
    await add.getByRole('button', { name: '添加到名单', exact: true }).click();
    await add.getByRole('alert').filter({ hasText: '未找到学号为“unknown”' }).waitFor();
    assert.equal(await roomEditor.getByRole('cell', { name: '1002', exact: true }).count(), 0, 'invalid multiline input does not partially add candidates');
    await add.getByLabel('考生学号', { exact: true }).fill('002\n004\n004');
    await add.getByRole('button', { name: '添加到名单', exact: true }).click();
    await add.waitFor({ state: 'hidden' });
    assert.equal(await roomEditor.getByRole('cell', { name: '1002', exact: true }).count(), 1);
    assert.equal(await roomEditor.getByRole('cell', { name: '1004b', exact: true }).count(), 1, 'student IDs resolve to the current exam number and deduplicate');
    await roomEditor.getByRole('button', { name: '保存考室', exact: true }).click();
    await roomEditor.waitFor({ state: 'hidden' });
    assert.deepEqual(await roomsFor(candidates[1].id), [a.id]);
    assert.deepEqual(await roomsFor(manual.id), [a.id]);
    assert.deepEqual(await roomsFor(candidates[0].id), [b.id], 'unrelated candidates retain their rooms');
    assert.equal(await prisma.examRoom.count({ where: { examId: single.id } }), 2);
    assert.deepEqual(errors, []);
  }
  console.log('PASS: authenticated imports; optional rooms; rollback; team accounts; manual creation in an existing room; exam-number changes and room moves; multiline student-ID assignment; invalid-input feedback; room settings and unrelated candidates preserved.');
} finally {
  await browser?.close();
  await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
}
