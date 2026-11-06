/** Real System Settings UI acceptance. Writes only uniquely named test organizations.
 * Never changes the global default. Coordinate with tests that restore full settings.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, type Page, type Response as BrowserResponse } from 'playwright-core';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { deleteStoredObject } from '../src/lib/storage';
import type { ReactionBrandingView } from '../src/lib/reaction-branding-contract';

const base = (process.env.REACTION_TEST_BASE || process.env.APP_BASE_URL || 'http://localhost:4031').replace(/\/$/, '');
const output = path.resolve(process.env.REACTION_BRANDING_UI_OUTPUT || '.local/reaction-branding-ui');
const database = new URL(process.env.DATABASE_URL || 'mysql://invalid/invalid');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'A local HTTP server is required');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) && /reaction/i.test(database.pathname), 'A local isolated Reaction database is required');
const prefix = 'UI徽章验收-' + randomBytes(5).toString('hex');
const renamed = prefix + '-改名';
const startedAt = new Date();
const endpoint = base + '/api/settings/reaction-branding';
const logoIds = new Set<string>();
const report: { startedAt: string; checks: { name: string; result: 'PASS' | 'FAIL'; evidence?: unknown }[]; pageErrors: string[]; cleanupErrors: string[]; defaultModified: boolean; passed?: boolean } = {
  startedAt: startedAt.toISOString(), checks: [], pageErrors: [], cleanupErrors: [], defaultModified: false
};
let cookie = '', adminId = '';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
let originalDefault: ReactionBrandingView['defaultBadge'] | undefined;
async function check(name: string, run: () => Promise<unknown>) {
  try { const evidence = await run(); report.checks.push({ name, result: 'PASS', evidence }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, result: 'FAIL', evidence: error instanceof Error ? error.message : 'Operation failed' }); throw error; }
}
function remember(value: ReactionBrandingView) {
  for (const organization of value.organizations) if (organization.name.startsWith(prefix)) logoIds.add(organization.logoId);
  return value;
}
async function read() {
  const response = await fetch(endpoint, { headers: { cookie } }); assert.equal(response.status, 200);
  return remember((await response.json()).data as ReactionBrandingView);
}
async function mutation(method: string, action: () => Promise<unknown>, expected = 200) {
  const observed = page!.waitForResponse(response => response.url() === endpoint && response.request().method() === method);
  await action(); const response: BrowserResponse = await observed; assert.equal(response.status(), expected);
  const payload = await response.json();
  if (payload.ok && payload.data?.organizations) remember(payload.data);
  return payload;
}
try {
  await fs.mkdir(output, { recursive: true });
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } }); adminId = admin.id;
  cookie = 'cwnupaa_proctor_session=' + createSessionToken(admin);
  originalDefault = (await read()).defaultBadge;
  const makeImage = (color: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect x="16" y="16" width="480" height="480" rx="80" fill="${color}"/><text x="256" y="292" text-anchor="middle" font-family="Arial" font-size="112" fill="white">TEST</text></svg>`)).png().toBuffer();
  const first = await makeImage('#2468ad'), second = await makeImage('#a94d75');
  browser = await chromium.launch({ executablePath: process.env.REACTION_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await context.addCookies([{ name: 'cwnupaa_proctor_session', value: cookie.slice(cookie.indexOf('=') + 1), url: base, httpOnly: true }]);
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  const panel = page.locator('#reaction-branding');
  await check('System deep link opens the branding panel and default preview', async () => {
    const response = await page!.goto(base + '/dashboard/system#reaction-branding'); assert.equal(response?.status(), 200);
    await panel.getByLabel('组织名称', { exact: true }).waitFor();
    await panel.getByAltText('当前全局默认徽章', { exact: true }).waitFor();
    await page!.waitForFunction(() => { const image = document.querySelector('#reaction-branding img[alt="当前全局默认徽章"]') as HTMLImageElement | null; return Boolean(image?.complete && image.naturalWidth > 0); });
    return { route: '/dashboard/system#reaction-branding', defaultReadOnly: true };
  });
  await check('Actual form adds organization and shows decoded badge preview', async () => {
    await panel.getByLabel('组织名称', { exact: true }).fill(prefix);
    await panel.getByLabel('新增组织徽章图片', { exact: true }).setInputFiles({ name: 'test-organization.png', mimeType: 'image/png', buffer: first });
    await mutation('POST', () => panel.getByRole('button', { name: '添加组织徽章', exact: true }).click());
    await panel.getByAltText(prefix + ' 徽章', { exact: true }).waitFor();
    await panel.getByAltText(prefix + ' 徽章', { exact: true }).evaluate((image: HTMLImageElement) => image.decode());
    assert(await panel.getByAltText(prefix + ' 徽章', { exact: true }).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0));
    const value = await read(); const entry = value.organizations.find(item => item.name === prefix); assert(entry); return { logoId: entry.logoId };
  });
  await check('Organization can be renamed without re-upload', async () => {
    const old = (await read()).organizations.find(item => item.name === prefix)!;
    await panel.getByRole('button', { name: `修改 ${prefix} 名称`, exact: true }).click();
    await panel.getByLabel(`重命名 ${prefix}`, { exact: true }).fill(renamed);
    await mutation('PATCH', () => panel.getByRole('button', { name: '保存名称', exact: true }).click());
    await panel.getByAltText(renamed + ' 徽章', { exact: true }).waitFor();
    assert.equal((await read()).organizations.find(item => item.name === renamed)?.logoId, old.logoId);
  });
  await check('Replacement uploads an immutable new image and updates preview', async () => {
    const old = (await read()).organizations.find(item => item.name === renamed)!;
    await panel.getByRole('button', { name: `替换 ${renamed} 徽章`, exact: true }).click();
    await panel.getByLabel(`选择 ${renamed} 新徽章`, { exact: true }).setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: second });
    await mutation('POST', () => panel.getByRole('button', { name: '保存替换', exact: true }).click());
    const updated = (await read()).organizations.find(item => item.name === renamed)!; assert.notEqual(updated.logoId, old.logoId);
    await page!.waitForFunction(({ alt, url }) => Array.from(document.images).some(image => image.alt === alt && image.getAttribute('src') === url), { alt: renamed + ' 徽章', url: updated.previewUrl });
    await panel.getByAltText(renamed + ' 徽章', { exact: true }).evaluate((image: HTMLImageElement) => image.decode());
    assert.equal(await panel.getByAltText(renamed + ' 徽章', { exact: true }).getAttribute('src'), updated.previewUrl);
    return { oldLogoId: old.logoId, replacementLogoId: updated.logoId };
  });
  await check('Duplicate organization is rejected visibly without replacing its image', async () => {
    const existing = (await read()).organizations.find(item => item.name === renamed)!;
    await panel.getByLabel('组织名称', { exact: true }).fill(renamed);
    await panel.getByLabel('新增组织徽章图片', { exact: true }).setInputFiles({ name: 'duplicate.png', mimeType: 'image/png', buffer: first });
    await mutation('POST', () => panel.getByRole('button', { name: '添加组织徽章', exact: true }).click(), 409);
    await panel.getByRole('alert').waitFor(); assert.equal((await read()).organizations.find(item => item.name === renamed)?.logoId, existing.logoId);
    await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: '组织徽章设置已刷新' }).waitFor();
  });
  await check('Desktop and narrow layouts show circular badge backing without overflow', async () => {
    await panel.screenshot({ path: path.join(output, 'system-branding.png') });
    await page!.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'Branding panel must fit narrow viewport');
    const appearance = await panel.getByAltText(renamed + ' 徽章', { exact: true }).evaluate((image: HTMLImageElement) => ({ radius: getComputedStyle(image.parentElement!).borderRadius, loaded: image.complete && image.naturalWidth > 0 }));
    assert.equal(appearance.radius, '50%'); assert(appearance.loaded);
    await panel.screenshot({ path: path.join(output, 'system-branding-mobile.png') });
    return { narrowViewport: '390x844', backingBorderRadius: appearance.radius };
  });
  await check('Delete removes only the selected organization mapping', async () => {
    await panel.getByRole('button', { name: `删除 ${renamed} 徽章`, exact: true }).click();
    await mutation('DELETE', () => panel.getByRole('button', { name: `确认删除 ${renamed} 徽章`, exact: true }).click());
    await panel.getByAltText(renamed + ' 徽章', { exact: true }).waitFor({ state: 'detached' });
    assert(!(await read()).organizations.some(item => item.name.startsWith(prefix)));
  });
  await check('Global default remains unchanged and page has no runtime errors', async () => {
    assert.deepEqual((await read()).defaultBadge, originalDefault); assert.deepEqual(report.pageErrors, []);
  });
  report.passed = true;
} catch (error) {
  report.passed = false; process.exitCode = 1; console.error(error instanceof Error ? error.message : 'System branding UI test failed');
  if (page) await page.locator('#reaction-branding').screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close();
  if (cookie) {
    try {
      const current = await read();
      for (const item of current.organizations.filter(value => value.name.startsWith(prefix))) {
        const response = await fetch(endpoint, { method: 'DELETE', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ name: item.name }) });
        assert.equal(response.status, 200, 'Test-owned organization cleanup failed');
      }
      const remaining = await read();
      for (const id of logoIds) {
        if (remaining.defaultBadge.logoId === id || remaining.organizations.some(item => item.logoId === id)) { report.cleanupErrors.push('Test logo remains referenced: ' + id); continue; }
        const record = await prisma.reactionLogo.findUnique({ where: { id } });
        if (!record) continue;
        assert(record.createdById === adminId && record.createdAt >= startedAt && record.label.includes(prefix), 'Only exactly captured test-created logo IDs may be removed');
        await prisma.reactionLogo.delete({ where: { id } }); await deleteStoredObject(record.objectPath);
      }
    } catch (error) { report.cleanupErrors.push(error instanceof Error ? error.message : 'Cleanup failed'); process.exitCode = 1; }
  }
  if (report.cleanupErrors.length) report.passed = false;
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}
