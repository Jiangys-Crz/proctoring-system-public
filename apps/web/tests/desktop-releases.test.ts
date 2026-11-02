import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dependency = createRequire(resolve(web, 'package.json'));
function loader(mocks: Record<string, unknown>) {
  const modules = new Map<string, any>();
  function load(file: string): any {
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} as any }; modules.set(file, module.exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', code)((name: string) => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('@/')) return load(resolve(web, 'src', `${name.slice(2)}.ts`));
      if (name.startsWith('.')) return load(resolve(dirname(file), `${name}.ts`));
      if (name === '@cwnupaa/proctor-shared') return load(resolve(web, '../../packages/shared/src/index.ts'));
      return dependency(name);
    }, module, module.exports);
    modules.set(file, module.exports); return module.exports;
  }
  return (file: string) => load(resolve(web, 'src', file));
}
async function fixture(t: any, admin = true) {
  const root = await mkdtemp(resolve(tmpdir(), 'desktop-release-test-'));
  const oldRoot = process.env.DESKTOP_RELEASE_DIR;
  process.env.DESKTOP_RELEASE_DIR = root;
  t.after(async () => { if (oldRoot) process.env.DESKTOP_RELEASE_DIR = oldRoot; else delete process.env.DESKTOP_RELEASE_DIR; await rm(root, { recursive: true, force: true }); });
  const rows = new Map<string, any>();
  let queue = Promise.resolve();
  const settings = {
    create: async ({ data }: any) => { assert(!rows.has(data.key)); rows.set(data.key, data); return data; },
    upsert: async ({ where, create }: any) => { if (!rows.has(where.key)) rows.set(where.key, create); return rows.get(where.key); },
    update: async ({ where, data }: any) => { const row = { ...rows.get(where.key), ...data }; rows.set(where.key, row); return row; },
    findUnique: async ({ where }: any) => rows.get(where.key) || null,
    findMany: async ({ where }: any) => [...rows.values()].filter(row => where.key.in ? where.key.in.includes(row.key) : row.key.startsWith(where.key.startsWith)),
  };
  const db: any = { systemSetting: settings, $queryRaw: async () => [], $transaction: (fn: any) => {
    const operation = queue.then(async () => { const snapshot = new Map(rows); try { return await fn(db); } catch (e) { rows.clear(); snapshot.forEach((value, key) => rows.set(key, value)); throw e; } });
    queue = operation.then(() => {}, () => {}); return operation;
  } };
  class AuthError extends Error { status = 403; }
  class UploadSecurityError extends Error { constructor(message: string, public status = 400) { super(message); } }
  const quotas: number[] = [];
  const load = loader({ './db': { prisma: db }, '@/lib/auth': { AuthError, requireSuperAdmin: async () => { if (!admin) throw new AuthError('denied'); return { id: 'admin' }; } },
    './upload-security': { UploadSecurityError, consumeRateLimit: async () => {}, reserveUploadBytes: async (_scope: string, bytes: number) => quotas.push(bytes) },
    '@/lib/upload-security': { UploadSecurityError },
  });
  return { load, lib: load('lib/desktop-releases.ts'), root, rows, quotas };
}
function executable() { const bytes = Buffer.alloc(2048, 7); bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128); return bytes; }
function uploadRequest(bytes: Buffer, target = 'windows', channel = 'public', version = '0.1.21', length = bytes.length) {
  return new Request(`http://localhost:4031/api/settings/desktop-releases/upload?channel=${channel}&target=${target}&kind=installer&version=${version}`, { method: 'POST', headers: { 'content-length': String(length) }, body: new Uint8Array(bytes).buffer });
}
const publish = (asset: any, overrides = {}) => ({ channel: asset.channel, target: asset.target, version: asset.version, installationMode: 'manual', notes: '更新说明', installerId: asset.id, updateId: asset.id, ...overrides });
const download = (f: any, filename: string, range?: string) => f.load('app/api/desktop/releases/files/[filename]/route.ts').GET(new Request('http://localhost:4031/file', { headers: range ? { range } : {} }), { params: Promise.resolve({ filename }) });

test('upload and publish reject unauthorized and foreign-origin requests before reading the body', async t => {
  const f = await fixture(t, false);
  for (const file of ['app/api/settings/desktop-releases/upload/route.ts', 'app/api/settings/desktop-releases/route.ts']) {
    const request = uploadRequest(executable()); request.json = async () => assert.fail('must authenticate before body parsing');
    assert.equal((await f.load(file).POST(request)).status, 403); assert.equal(request.bodyUsed, false);
  }
  const deleting = uploadRequest(executable()); deleting.json = async () => assert.fail('authenticate before parsing deletion');
  assert.equal((await f.load('app/api/settings/desktop-releases/route.ts').DELETE(deleting)).status, 403);
  assert.equal(f.rows.size, 0);
});
test('raw streaming checks format, declared size, quota and hash; failed uploads leave no files', async t => {
  const f = await fixture(t);
  for (const request of [uploadRequest(Buffer.alloc(2048)), uploadRequest(executable(), 'windows', 'public', '0.1.21', 1024), uploadRequest(executable(), 'windows', 'public', '0.1.21', 4096)]) {
    await assert.rejects(f.lib.uploadDesktopArtifact(request, 'admin')); assert.equal((await readdir(f.root)).length, 0);
  }
  const origin = uploadRequest(executable()); origin.headers.set('origin', 'https://evil.example');
  assert.equal((await f.load('app/api/settings/desktop-releases/upload/route.ts').POST(origin)).status, 403); assert.equal(origin.bodyUsed, false);
  const asset = await f.lib.uploadDesktopArtifact(uploadRequest(executable()), 'admin');
  assert.equal(asset.sha512, createHash('sha512').update(executable()).digest('base64'));
  assert.equal(f.quotas.at(-1), executable().length); assert.deepEqual(await readdir(f.root), [asset.id + '.exe']);
  assert.equal((await download(f, asset.id + '.exe')).status, 404); // Drafts remain private.
});
test('publication binds target and version in one stream, increments atomically and preserves historical downloads', async t => {
  const f = await fixture(t);
  const first = await f.lib.uploadDesktopArtifact(uploadRequest(executable(), 'windows', 'public', '0.1.9'), 'admin');
  for (const patch of [{ target: 'mac-arm64' }, { version: '0.1.10' }]) await assert.rejects(f.lib.publishDesktopRelease(publish(first, patch)));
  assert.equal((await f.lib.getDesktopReleases()).length, 0);
  await f.lib.publishDesktopRelease(publish(first));
  await assert.rejects(f.lib.publishDesktopRelease(publish(first)), /必须高于/);
  const newer = await f.lib.uploadDesktopArtifact(uploadRequest(executable(), 'windows', 'public', '0.1.10'), 'admin');
  const results = await Promise.allSettled([f.lib.publishDesktopRelease(publish(newer)), f.lib.publishDesktopRelease(publish(newer))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.lib.getDesktopReleases('public'))[0].version, '0.1.10');
  const intranet = (await f.lib.getDesktopReleases('intranet'))[0];
  assert.equal(intranet.version, '0.1.10');
  assert.equal(intranet.installer.id, (await f.lib.getDesktopReleases('public'))[0].installer.id);
  assert.equal(intranet.feedUrl, '/api/desktop/updates/intranet/windows/');
  const old = await download(f, first.id + '.exe'); assert.equal(old.status, 200); assert.deepEqual(Buffer.from(await old.arrayBuffer()), executable());
  assert(!JSON.stringify(await f.lib.getDesktopReleases()).includes(f.root));
});
test('Mac DMG publication and immutable file downloads handle exact, suffix and invalid ranges safely', async t => {
  const f = await fixture(t);
  const dmg = Buffer.alloc(2048); dmg.write('koly', dmg.length - 512);
  const asset = await f.lib.uploadDesktopArtifact(uploadRequest(dmg, 'mac-arm64', 'intranet'), 'admin'); await f.lib.publishDesktopRelease(publish(asset));
  const name = asset.id + '.dmg';
  for (const [range, expected] of [['bytes=0-9', dmg.subarray(0, 10)], ['bytes=-512', dmg.subarray(-512)]] as const) {
    const response = await download(f, name, range); assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  for (const range of ['bytes=-0', 'bytes=2048-', 'bytes=8-3', 'bytes=0-1,5-9']) assert.equal((await download(f, name, range)).status, 416);
  for (const filename of ['../.env', asset.id + '.exe', '00000000-0000-4000-8000-000000000000.dmg']) assert.equal((await download(f, filename)).status, 404);
  await truncate(f.lib.artifactPath(asset), 10); assert.equal((await download(f, name)).status, 503);
});
test('published versions reject outdated desktop logins on every network address', async t => {
  const f = await fixture(t);
  assert.equal(await f.lib.isPublishedDesktopVersion('localhost:4031', 'win32 10.0', '0.1.20'), true);
  const asset = await f.lib.uploadDesktopArtifact(uploadRequest(executable()), 'admin'); await f.lib.publishDesktopRelease(publish(asset));
  for (const [os, version] of [['win32 10.0', '0.1.20'], ['win32 10.0', undefined], ['darwin 25.0', '0.1.21'], [undefined, '0.1.21']]) {
    assert.equal(await f.lib.isPublishedDesktopVersion('localhost:4031', os, version), false);
  }
  assert.equal(await f.lib.isPublishedDesktopVersion('localhost:4031', 'win32 10.0', '0.1.21'), true);
  assert.equal(await f.lib.isPublishedDesktopVersion('legacy-proctor.example.test', 'win32 10.0', '0.1.20'), false);
});


test('legacy public and intranet releases resolve to the highest version and canonical publication prevents downgrades', async t => {
  const f = await fixture(t);
  const first = await f.lib.uploadDesktopArtifact(uploadRequest(executable(), 'windows', 'public', '0.1.9'), 'admin');
  await f.lib.publishDesktopRelease(publish(first));
  const value = f.rows.get('desktop.active.unified.windows').value;
  f.rows.delete('desktop.active.unified.windows');
  f.rows.set('desktop.active.public.windows', { key: 'desktop.active.public.windows', value });
  const newer = await f.lib.uploadDesktopArtifact(uploadRequest(executable(), 'windows', 'intranet', '0.1.10'), 'admin');
  const legacy = { ...newer, channel: 'intranet' };
  f.rows.set('desktop.asset.' + legacy.id, { key: 'desktop.asset.' + legacy.id, value: legacy });
  f.rows.set('desktop.published.' + legacy.id, { key: 'desktop.published.' + legacy.id, value: legacy });
  f.rows.set('desktop.active.intranet.windows', { key: 'desktop.active.intranet.windows', value: { ...value, channel: 'intranet', version: '0.1.10', installer: legacy, update: legacy } });
  for (const channel of ['public', 'intranet']) {
    const release = (await f.lib.getDesktopReleases(channel))[0];
    assert.equal(release.version, '0.1.10'); assert.equal(release.installer.id, legacy.id);
    const feed = f.load('app/api/desktop/updates/[channel]/[target]/[filename]/route.ts');
    const response = await feed.GET(new Request('http://localhost/feed'), { params: Promise.resolve({ channel, target: 'windows', filename: 'latest.yml' }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /0.1.10/);
  }
  assert.equal((await f.lib.getDesktopReleases()).length, 1);
  assert.equal((await f.lib.getDesktopArtifacts()).find((item: any) => item.id === legacy.id).channel, 'public');
  assert.equal((await download(f, legacy.id + '.exe')).status, 200);
  await assert.rejects(f.lib.publishDesktopRelease(publish(newer)), /必须高于/);
  const next = await f.lib.uploadDesktopArtifact(uploadRequest(executable(), 'windows', 'intranet', '0.1.11'), 'admin');
  assert.match(next.name, /unified/);
  await f.lib.publishDesktopRelease(publish(next, { channel: 'intranet' }));
  assert.equal(f.rows.get('desktop.active.unified.windows').value.channel, 'public');
  assert.equal((await f.lib.getDesktopReleases('intranet'))[0].version, '0.1.11');
  assert.equal(await f.lib.isPublishedDesktopVersion('legacy-proctor.example.test', 'win32 10.0', '0.1.10'), false);
  assert.equal(await f.lib.isPublishedDesktopVersion('proctoring.example.org', 'win32 10.0', '0.1.11'), true);
  assert.equal(f.lib.desktopReleaseChannel('legacy-proctor.example.test'), 'public');
  assert.equal((await download(f, first.id + '.exe')).status, 200, 'historical download IDs remain valid');
});
