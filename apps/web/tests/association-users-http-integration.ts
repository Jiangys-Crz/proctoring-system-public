// Requires an isolated production server and database, never a shared deployment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';

const base = process.env.PROCTOR_ASSOCIATION_HTTP_BASE || 'http://localhost:4141';
const marker = randomUUID();
const ids: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const admin = await prisma.user.create({ data: { username: `http-admin-${marker}`, role: 'SUPER_ADMIN' } }); ids.push(admin.id);
const ordinary = await prisma.user.create({ data: { username: `http-user-${marker}`, role: 'ADMIN' } }); ids.push(ordinary.id);
const cookie = (user: typeof admin) => `cwnupaa_proctor_session=${createSessionToken(user)}`;
async function request(path: string, method: string, body?: object, authentication = '') {
  const result = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: authentication }, body: body ? JSON.stringify(body) : undefined });
  return { status: result.status, body: await result.json() };
}
try {
  const row = { realName: `HTTP测试${marker}`, numberId: `HTTP${marker}` };
  assert.equal((await request('/api/users/association', 'POST', { users: [row] })).status, 401);
  assert.equal((await request('/api/users/association', 'POST', { users: [row] }, cookie(ordinary))).status, 403);
  assert.equal((await request('/api/users/association', 'POST', { users: [] }, cookie(admin))).status, 400);
  assert.equal((await request('/api/users/association', 'POST', { users: [row, row] }, cookie(admin))).status, 400);
  assert.equal((await request('/api/users/association', 'POST', { users: [row] }, cookie(admin))).status, 200);
  const pending = await prisma.user.findUniqueOrThrow({ where: { realName_numberId: row } }); ids.push(pending.id);
  assert.equal((await request(`/api/users/${pending.id}`, 'PATCH', { password: 'fixture-new-password' }, cookie(admin))).status, 400);
  assert.equal((await request(`/api/users/${pending.id}`, 'PATCH', { username: '', realName: row.realName, numberId: row.numberId, school: '', email: '', status: 'DISABLED', role: 'ADMIN' }, cookie(admin))).status, 200);
  assert.equal((await request('/api/users/association', 'POST', { users: [row] }, cookie(admin))).status, 200);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: pending.id } })).status, 'DISABLED');
  const listing = await request('/api/users', 'GET', undefined, cookie(admin));
  assert.equal(listing.status, 200); assert.equal(JSON.stringify(listing.body).includes('passwordHash'), false);
  // Browser checks cover hydration, import preview, the test verification fields and mobile overflow.
  browser = await chromium.launch({ executablePath: process.env.PROCTOR_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(admin), url: base }]);
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/dashboard/users');
  await page.getByRole('button', { name: '导入协会用户', exact: true }).click();
  await page.locator('#association-user-import').fill('张三+001\n李四+002');
  await page.getByRole('button', { name: '导入 2 位用户' }).waitFor();
  await page.locator('#association-user-import').fill('错误行');
  assert.equal(await page.getByRole('button', { name: /导入.*位用户/ }).isDisabled(), true);
  await page.goto(base + '/test');
  await page.getByText('官网账号或邮箱', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox').count(), 1, 'only the test acknowledgement checkbox is shown');
  assert.equal(await page.locator('input:not([type="checkbox"]):not([type="radio"])').count(), 2, 'enrollment requires only the official account and password');
  assert.equal(await page.getByRole('button', { name: '领取我的测试账号' }).isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'test page fits mobile screen');
  assert.deepEqual(errors, []);
  console.log('PASS: HTTP import authentication/authorization, bad input, duplicate handling, pending password restriction, editing, safe listing, import modal hydration/preview, official verification fields and mobile layout.');
} finally {
  await browser?.close();
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
}
