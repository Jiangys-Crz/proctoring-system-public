import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { chromium } from 'playwright-core';
import { PrismaClient } from '@prisma/client';
import { digestPasswordForStorage } from '../src/lib/password-crypto';

// Run against the isolated Reaction database only. Never use production records.
const database = new URL(process.env.DATABASE_URL || 'mysql://invalid/invalid');
assert.match(database.pathname, /reaction/i, 'This test requires an isolated Reaction database');
const fixture: { examId?: string; adminUsername?: string; adminPassword?: string } = process.env.REACTION_TEST_FIXTURE
  ? JSON.parse(await readFile(process.env.REACTION_TEST_FIXTURE, 'utf8')) : {};
const base = process.env.REACTION_TEST_BASE || process.env.APP_BASE_URL || 'http://localhost:4031';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Local test server required');
const examId = process.env.REACTION_TEST_EXAM_ID || fixture.examId;
assert.ok(examId, 'Set REACTION_TEST_EXAM_ID to the isolated test exam');
const password = process.env.REACTION_TEST_ADMIN_PASSWORD || fixture.adminPassword || process.env.BOOTSTRAP_ADMIN_PASSWORD;
assert.ok(password, 'Set a local test administrator password in the environment');
const prisma = new PrismaClient();
const directory = path.resolve(process.env.REACTION_ADMIN_TEST_OUTPUT || '../../.local/reaction-admin-test');
const report: { test: string; result: 'PASS' | 'FAIL' | 'BLOCKED'; evidence: string }[] = [];
const endpoint = `${base}/api/exams/${encodeURIComponent(examId)}/reactions`;
let adminCookie = '';

async function check(test: string, run: () => Promise<string>) {
  try { report.push({ test, result: 'PASS', evidence: await run() }); }
  catch (error) { report.push({ test, result: 'FAIL', evidence: error instanceof assert.AssertionError ? error.message : 'Test operation failed; no credentials logged' }); }
}

async function login(account: string, credential: string) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ account, password: credential }) });
  assert.equal(response.status, 200, 'Local administrator login must succeed');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'A server-issued login cookie is required');
  return cookie;
}

async function main() {
  await mkdir(directory, { recursive: true });
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
  assert.equal(exam.platform, 'NOVAJUDGE');
  adminCookie = await login(process.env.REACTION_TEST_ADMIN_ACCOUNT || fixture.adminUsername || 'admin', password!);
  await check('Anonymous listing denied', async () => {
    const response = await fetch(endpoint); assert.equal(response.status, 401); return 'GET reactions: 401';
  });
  let view: { config: Record<string, unknown>; items: { id: string; cameraPath: string | null; desktopPath: string | null; reactionPath: string | null; metadataPath: string | null }[] } | undefined;
  await check('Exam administrator listing', async () => {
    const response = await fetch(endpoint, { headers: { cookie: adminCookie } }); assert.equal(response.status, 200);
    const text = await response.text();
    for (const secret of [password, process.env.REACTION_CCS_PASSWORD, process.env.REACTION_CCS_USERNAME].filter((value): value is string => Boolean(value && value.length > 4))) assert.ok(!text.includes(secret), 'API must not disclose service credentials');
    view = JSON.parse(text).data; assert.ok(view?.config); return 'GET reactions: 200; service credentials absent';
  });
  assert.ok(view, 'Listing is required for the remaining tests');
  const { credentialsConfigured: _configured, ...config } = view.config;
  await check('Configuration save through authorized API', async () => {
    const response = await fetch(endpoint, { method: 'PATCH', headers: { cookie: adminCookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(config) });
    assert.equal(response.status, 200); return 'Saved unchanged isolated exam configuration';
  });
  await check('Cross-origin mutation denied', async () => {
    const response = await fetch(endpoint, { method: 'PATCH', headers: { cookie: adminCookie, origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: JSON.stringify(config) });
    assert.equal(response.status, 403); return 'PATCH with untrusted Origin: 403';
  });

  const suffix = crypto.randomUUID().slice(0, 8);
  const outsiderPassword = crypto.randomBytes(24).toString('base64url');
  const outsider = await prisma.user.create({ data: { username: `reaction-access-${suffix}`, role: 'ADMIN', passwordHash: await bcrypt.hash(digestPasswordForStorage(outsiderPassword), 10) } });
  const outsiderCookie = await login(outsider.username!, outsiderPassword);
  await check('Non-manager listing denied', async () => {
    const response = await fetch(endpoint, { headers: { cookie: outsiderCookie } }); assert.equal(response.status, 403); return 'Unassigned administrator GET reactions: 403';
  });
  await check('Non-manager generation denied', async () => {
    const response = await fetch(`${endpoint}/generate`, { method: 'POST', headers: { cookie: outsiderCookie, origin: base, 'content-type': 'application/json' }, body: '{}' }); assert.equal(response.status, 403); return 'Unassigned administrator POST generate: 403';
  });

  const item = view.items.find(value => value.cameraPath && value.desktopPath && value.reactionPath && value.metadataPath);
  if (!item) {
    report.push({ test: 'Video downloads and browser preview', result: 'BLOCKED', evidence: 'No completed generated Reaction is available in the isolated exam' });
    return;
  }
  const otherExam = await prisma.exam.create({ data: {
    examCode: String(crypto.randomInt(1_000_000_000, 9_999_999_999)), name: `Reaction access isolation ${suffix}`,
    startAt: new Date(), latestStartAt: new Date(Date.now() + 60_000), endAt: new Date(Date.now() + 60_000), durationMinutes: 1,
    platform: 'NOVAJUDGE', platformBaseUrl: exam.platformBaseUrl, platformContestId: `access-isolation-${suffix}`,
    contestType: 'TEAM', rules: 'Isolated permission test only', createdById: outsider.id,
  } });
  for (const kind of ['camera', 'desktop', 'reaction', 'metadata']) {
    const url = `${endpoint}/${item.id}/files/${kind}`;
    await check(`${kind} file anonymous access denied`, async () => {
      const response = await fetch(url); assert.equal(response.status, 401); return 'No login cookie: 401';
    });
    await check(`${kind} file non-manager access denied`, async () => {
      const response = await fetch(url, { headers: { cookie: outsiderCookie } }); assert.equal(response.status, 403); return 'Unassigned administrator: 403';
    });
    await check(`${kind} file cross-exam access denied`, async () => {
      const response = await fetch(`${base}/api/exams/${otherExam.id}/reactions/${item.id}/files/${kind}`, { headers: { cookie: adminCookie } }); assert.equal(response.status, 404); return 'Reaction ID under another existing exam: 404';
    });
    await check(`${kind} file private download`, async () => {
      const response = await fetch(`${url}?download=1`, { headers: { cookie: adminCookie, ...(kind === 'metadata' ? {} : { range: 'bytes=0-2047' }) } });
      assert.equal(response.status, kind === 'metadata' ? 200 : 206);
      assert.match(response.headers.get('content-disposition') || '', /attachment/);
      assert.match(response.headers.get('cache-control') || '', /private, no-store/);
      const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length > 32);
      if (kind !== 'metadata') assert.ok(bytes.includes(Buffer.from('ftyp')), 'MP4 header must be valid');
      else assert.ok(JSON.parse(bytes.toString('utf8')));
      return `${response.status}; ${bytes.length} bytes; private/no-store; correct attachment filename`;
    });
  }

  const executablePath = process.env.REACTION_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  if (!executablePath) { report.push({ test: 'Browser preview', result: 'BLOCKED', evidence: 'Chrome/Edge not found; set REACTION_TEST_BROWSER' }); return; }
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const equal = adminCookie.indexOf('=');
    await context.addCookies([{ name: adminCookie.slice(0, equal), value: adminCookie.slice(equal + 1), url: base }]);
    const page = await context.newPage();
    await check('Reaction management page renders', async () => {
      const response = await page.goto(`${base}/dashboard/exams/${examId}/reactions`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      assert.equal(response?.status(), 200);
      await page.getByRole('heading', { name: 'Reaction 录像', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Camera 预览', exact: true }).first().waitFor({ timeout: 60_000 });
      return 'Real management page rendered with Camera/Desktop/Reaction preview actions';
    });
    for (const kind of ['Camera', 'Desktop', 'Reaction']) await check(`${kind} browser playback`, async () => {
      await page.getByRole('button', { name: `${kind} 预览`, exact: true }).first().click();
      const video = page.locator('video');
      await video.evaluate(async element => { const media = element as HTMLVideoElement; media.muted = true; await media.play(); });
      await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.currentTime > 0.5 && video.videoWidth > 0 && !video.error; }, undefined, { timeout: 60_000 });
      const dimensions = await video.evaluate(element => ({ width: (element as HTMLVideoElement).videoWidth, height: (element as HTMLVideoElement).videoHeight, duration: (element as HTMLVideoElement).duration }));
      if (kind === 'Reaction') { assert.equal(dimensions.width, 1080); assert.equal(dimensions.height, 1920); }
      await page.screenshot({ path: path.join(directory, `${kind.toLowerCase()}-preview.png`), fullPage: true });
      return `Browser decoded and played ${dimensions.width}×${dimensions.height}, ${dimensions.duration.toFixed(2)} seconds`;
    });
  } finally { await browser.close(); }
}

try { await main(); }
catch { report.push({ test: 'Test setup', result: 'FAIL', evidence: 'Isolated test setup failed; verify local environment and test exam ID' }); }
finally {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), examId, base, results: report }, null, 2));
  for (const row of report) console.log(`${row.result}: ${row.test} — ${row.evidence}`);
  console.log(`Report: ${path.join(directory, 'report.json')}`);
  await prisma.$disconnect();
  if (report.some(row => row.result === 'FAIL')) process.exitCode = 1;
  else if (report.some(row => row.result === 'BLOCKED')) process.exitCode = 2;
}
