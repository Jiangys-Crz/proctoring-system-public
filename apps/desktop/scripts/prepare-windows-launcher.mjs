import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = join(dirname(fileURLToPath(import.meta.url)), '../native/windows-launcher');
const digest = data => createHash('sha256').update(data).digest('hex');
const sourceHash = digest(await readFile(join(directory, 'launcher.c')));
const architectures = { x64: ['x86_64-w64-mingw32-gcc', 'launcher_entry'], ia32: ['i686-w64-mingw32-gcc', '_launcher_entry'] };
const manifestFile = join(directory, 'artifacts.json');
if (process.argv.includes('--rebuild')) {
  const binaries = {};
  for (const [arch, [compiler, entry]] of Object.entries(architectures)) {
    const file = join(directory, arch, 'elevate-client.exe');
    await mkdir(dirname(file), { recursive: true });
    const result = spawnSync(compiler, ['-D_WIN32_WINNT=0x0601', '-Os', '-Wall', '-Wextra', '-Werror', '-nostdlib',
      '-Wl,--no-insert-timestamp', '-Wl,--subsystem,console:6.1', `-Wl,--entry,${entry}`, '-s',
      join(directory, 'launcher.c'), '-o', file, '-lkernel32', '-lshell32', '-lole32'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Windows ${arch} 管理员授权组件构建失败`);
    binaries[arch] = digest(await readFile(file));
  }
  await writeFile(manifestFile, JSON.stringify({ sourceHash, binaries }, null, 2) + '\n');
}
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
if (manifest.sourceHash !== sourceHash) throw new Error('管理员授权源码已变化，请重新构建 Windows 授权组件');
for (const arch of Object.keys(architectures)) {
  if (digest(await readFile(join(directory, arch, 'elevate-client.exe'))) !== manifest.binaries[arch]) {
    throw new Error(`Windows ${arch} 管理员授权组件缺失或校验失败`);
  }
}
