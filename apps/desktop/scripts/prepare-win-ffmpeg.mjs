import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const binaries = {
  x64: {
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b4.4.1/win32-x64',
    sha256: '8436760af8f81c95eff92d854a7684e6d3cedb872888420359fc45c8eb2664ac',
  },
  ia32: {
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b4.4.1/win32-ia32',
    sha256: 'f8547659a857a58fc43fb06a5a315d85b609f3e9d900d2bf083edff2072c7fa2',
  },
};
const arm64 = {
  url: 'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-11-13-12-43/ffmpeg-n8.1.3-35-gf1acb0a266-winarm64-lgpl-8.1.zip',
  sha256: 'bfc1009792ef6903a70e65e9e2d5c26d346359d2389fa8adcd839393fb211681',
  member: 'ffmpeg-n8.1.3-35-gf1acb0a266-winarm64-lgpl-8.1/bin/ffmpeg.exe',
};

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function validBinary(path, expected) {
  try {
    return digest(await readFile(path)) === expected;
  } catch {
    return false;
  }
}

async function downloadWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

const args = process.argv.slice(2);
if (args.length > 2 || (args.length && args[0] !== '--arm64')) {
  throw new Error('用法：node prepare-win-ffmpeg.mjs [--arm64 [已下载的 FFmpeg ZIP]]');
}
if (args[0] === '--arm64') {
  const staging = await mkdtemp(join(tmpdir(), 'proctor-ffmpeg-arm64-'));
  try {
    const archive = args[1] ? resolve(args[1]) : join(staging, 'ffmpeg.zip');
    if (!args[1]) await writeFile(archive, await downloadWithRetry(arm64.url));
    if (!await validBinary(archive, arm64.sha256)) throw new Error('Windows ARM64 FFmpeg ZIP 校验失败');
    const extracted = spawnSync('tar', ['-xf', archive, '-C', staging, arm64.member], { stdio: 'inherit', windowsHide: true });
    if (extracted.error) throw extracted.error;
    if (extracted.status !== 0) throw new Error('Windows ARM64 FFmpeg 解包失败');
    const destination = join(desktopDir, 'build', 'ffmpeg', 'win32-arm64', 'ffmpeg.exe');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(staging, arm64.member)), { mode: 0o755 });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
} else {
  for (const [arch, source] of Object.entries(binaries)) {
    const destination = join(desktopDir, 'build', 'ffmpeg', `win32-${arch}`, 'ffmpeg.exe');
    await mkdir(dirname(destination), { recursive: true });
    if (!await validBinary(destination, source.sha256)) {
      const binary = await downloadWithRetry(source.url);
      const actual = digest(binary);
      if (actual !== source.sha256) throw new Error(`Windows ${arch} FFmpeg 校验失败：${actual}`);
      await writeFile(destination, binary);
    }
    await chmod(destination, 0o755);
  }
}
