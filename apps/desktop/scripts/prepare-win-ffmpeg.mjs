import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
