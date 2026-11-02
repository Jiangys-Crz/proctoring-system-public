import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL('..', import.meta.url));
for (const script of [
  'scripts/prepare-windows-token.mjs',
  'scripts/prepare-windows-launcher.mjs',
  'scripts/prepare-windows-screen-control.mjs',
  'scripts/prepare-windows-inventory.mjs',
  require.resolve('typescript/bin/tsc'),
  'scripts/copy-assets.mjs',
]) {
  const result = spawnSync(process.execPath, [script, ...(script.endsWith('/tsc') || script.endsWith('\\tsc') ? ['-p', 'tsconfig.json'] : [])], {
    cwd: directory, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
