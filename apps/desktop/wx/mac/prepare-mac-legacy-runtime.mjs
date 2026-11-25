import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const arch = process.argv[2];
const digests = {
  arm64: '2b87e9f766692caaa16d7750bfab2f609c0eab906f55996c7d438d8e18ac8867',
  x64: '01f053d08cb2855acb14f0465f4e36324a41bd13b3b2ead142970a56df3e9db1',
};
if (process.platform !== 'darwin' || !Object.hasOwn(digests, arch)) {
  throw new Error('旧版迁移组件只能在 macOS 上按 arm64 或 x64 准备');
}
const version = '22.3.27';
const archiveName = `electron-v${version}-darwin-${arch}.zip`;
const release = `https://github.com/electron/electron/releases/download/v${version}`;
const cacheKey = createHash('sha256').update(release).digest('hex');
const root = fileURLToPath(new URL('../../build/legacy-electron/', import.meta.url));
const destination = join(root, `darwin-${arch}`);
const binary = join('Electron.app', 'Contents', 'MacOS', 'Electron');

const isFile = async path => (await stat(path).catch(() => null))?.isFile();
async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function cachedArchive() {
  const cache = process.env.electron_config_cache || join(homedir(), 'Library', 'Caches', 'electron');
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => []);
  const locations = [join(cache, cacheKey, archiveName), ...entries
    .filter(entry => entry.isDirectory() && entry.name !== cacheKey && /^[a-f0-9]{64}$/.test(entry.name))
    .map(entry => join(cache, entry.name, archiveName))];
  for (const file of locations) {
    // Electron's downloader keys by mirror URL. Reuse any cached copy only
    // when its contents match the architecture-specific release digest.
    if (await isFile(file) && await sha256(file) === digests[arch]) return file;
  }
  return null;
}

await mkdir(root, { recursive: true });
if (!await isFile(join(destination, binary))) {
  const work = await mkdtemp(join(root, '.extract-'));
  try {
    let archive = await cachedArchive();
    if (!archive) {
      archive = join(work, archiveName);
      const response = await fetch(`${release}/${archiveName}`, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw new Error(`旧版迁移组件下载失败（HTTP ${response.status}）`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
      if (await sha256(archive) !== digests[arch]) throw new Error('旧版迁移组件摘要不匹配');
    }
    const extracted = join(work, 'runtime');
    await mkdir(extracted);
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, extracted], { stdio: 'inherit' });
    if (!await isFile(join(extracted, binary))) throw new Error('旧版迁移组件缺少 Electron.app');
    await rm(destination, { recursive: true, force: true });
    await rename(extracted, destination);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
