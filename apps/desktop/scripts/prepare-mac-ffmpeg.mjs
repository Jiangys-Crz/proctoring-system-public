import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const arch = process.argv[2];
const hashes = {
  x64: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
  arm64: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
};
if (!(arch in hashes)) throw new Error('Mac FFmpeg 架构必须是 x64 或 arm64');
const filename = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'ffmpeg', `darwin-${arch}`, 'ffmpeg');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(dirname(filename), { recursive: true });
const existing = await readFile(filename).catch(() => null);
if (!existing || digest(existing) !== hashes[arch]) {
  // Only the packaging machine needs Internet access. The binary is included
  // in the installer, and intranet clients never download runtime dependencies.
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-${arch}.gz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`下载 Mac FFmpeg 失败：${response.status}`);
  const binary = gunzipSync(Buffer.from(await response.arrayBuffer()), { maxOutputLength: 160 * 1024 ** 2 });
  if (digest(binary) !== hashes[arch]) throw new Error('Mac FFmpeg 校验失败');
  await writeFile(filename, binary);
}
await chmod(filename, 0o755);
