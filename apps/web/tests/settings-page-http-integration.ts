// Run only with an isolated production web server and the fixture MySQL database.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { HYDRO_SETTINGS_VERSION } from '../src/lib/hydro-settings-contract';

if (!process.env.DATABASE_URL?.includes('proctor_settings_qa')) throw new Error('Use the settings fixture database.');
const base = process.env.PROCTOR_SETTINGS_QA_BASE || 'http://localhost:4141';
let protocol: 'modern' | 'old' | 'invalid' = 'modern';
let calls = 0;
const mock = createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain */ }
  assert.equal(request.url, '/api/proctor/config-check');
  assert.equal(request.headers['x-proctor-api-key'], 'fixture-key');
  assert.equal(request.headers['x-proctor-signature'], undefined);
  assert.equal(request.headers['x-proctor-timestamp'], undefined);
  calls++;
  response.setHeader('content-type', 'application/json');
  const modern = { configured: true, problemDomainId: 'Problems', authMode: 'api-key', pluginVersion: '0.2.1' };
  const old = { configured: true, problemDomainId: 'Problems', judgeUsername: 'legacy-user', ownerUid: 1 };
  response.end(protocol === 'invalid' ? '<html>wrong upstream</html>' : JSON.stringify({ ok: true, data: protocol === 'modern' ? modern : old }));
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address(); assert.ok(address && typeof address === 'object');
const user = await prisma.user.create({ data: { username: `settings-qa-${randomUUID()}`, role: 'SUPER_ADMIN' } });
const legacy = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-key', problemDomainId: 'Problems', sharedSecret: 'fixture-old-signing-secret', judgeUsername: 'legacy-user', judgePassword: 'fixture-old-password' };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await prisma.systemSetting.create({ data: { key: 'hydro', value: legacy } });
  const authentication = { cookie: `cwnupaa_proctor_session=${createSessionToken(user)}` };
  const response = await fetch(base + '/api/settings/hydro', { headers: authentication });
  const body = await response.json();
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.deepEqual(Object.keys(body.data).sort(), ['apiKey', 'baseUrl', 'problemDomainId', 'settingsVersion'].sort());
  assert.equal(body.data.settingsVersion, HYDRO_SETTINGS_VERSION);
  const health = await (await fetch(base + '/api/health')).json(); assert.equal(health.data.settingsVersion, HYDRO_SETTINGS_VERSION);
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext(); await context.addCookies([{ name: 'cwnupaa_proctor_session', value: createSessionToken(user), url: base }]);
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const navigation = await page.goto(base + '/dashboard/system'); assert.match(navigation?.headers()['cache-control'] || '', /no-store/);
  await page.getByText(`评测设置版本：${HYDRO_SETTINGS_VERSION}`, { exact: true }).waitFor();
  const save = page.getByRole('button', { name: '保存评测服务设置', exact: true });
  await save.waitFor();
  assert.equal(await page.getByLabel('签名密钥', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('服务账号用户名', { exact: true }).count(), 0);
  await page.getByLabel('题库域 ID', { exact: true }).fill('Other');
  await save.click(); await page.getByText('已保存评测服务设置', { exact: true }).waitFor();
  const stored = (await prisma.systemSetting.findUniqueOrThrow({ where: { key: 'hydro' } })).value as any;
  assert.equal(stored.problemDomainId, 'Other');
  assert.equal(stored.sharedSecret, legacy.sharedSecret); assert.equal(stored.judgeUsername, legacy.judgeUsername); assert.equal(stored.judgePassword, legacy.judgePassword);
  await page.getByLabel('题库域 ID', { exact: true }).fill('Problems');
  const check = page.getByRole('button', { name: '检测连接与配置', exact: true });
  await check.click(); await page.getByText('已加载 0.2.1，使用 API-Key 认证', { exact: true }).waitFor();
  await page.getByText('连接正常，已核对的配置一致', { exact: true }).waitFor();
  protocol = 'old'; await check.click(); await page.getByText(/评测服务仍返回旧插件配置/).waitFor();
  assert.equal(await page.getByText('连接正常，已核对的配置一致', { exact: true }).count(), 0);
  protocol = 'invalid'; await check.click(); await page.getByText(/评测服务返回的配置检测结果无效/).waitFor();
  await page.getByRole('button', { name: '客户端发布与安装包管理', exact: true }).click();
  await page.getByText(/公网和内网共用同一软件版本/).waitFor();
  assert.equal(await page.getByLabel('版本类型', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('option', { name: /公网|内网/ }).count(), 0);
  await page.route('**/api/settings/hydro', route => route.fulfill({ json: { ok: true, data: legacy } }));
  await page.reload(); await page.getByText(/当前后台服务仍是旧版本/).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存评测服务设置', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []); assert.equal(calls, 3);
  console.log('PASS: real settings UI has only three connection fields, old credentials never returned or overwritten, page/service version detection, no-cache headers, modern/old/bad response handling, unified release UI and stale service guard.');
} finally {
  await browser?.close();
  await prisma.systemSetting.deleteMany({ where: { key: 'hydro' } });
  await prisma.user.delete({ where: { id: user.id } });
  mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));
  await prisma.$disconnect();
}
