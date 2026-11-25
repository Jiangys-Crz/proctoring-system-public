import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL('..', import.meta.url));
const [requested, requestedChannel = 'unified', arch] = process.argv.slice(2);
// Keep existing build commands usable; every new installer includes both backends.
const channel = 'unified';
const platform = requested === 'pack' ? ({ darwin: 'mac', win32: 'win' }[process.platform]) : requested;
const macArchitectures = ['x64', 'arm64'];
const acceptedArchitectures = platform === 'mac'
  ? (requested === 'pack' ? macArchitectures : [...macArchitectures, 'all'])
  : ['x64', 'ia32'];
if (!['mac', 'win'].includes(platform) || !['unified', 'public', 'intranet'].includes(requestedChannel)
    || (arch && !acceptedArchitectures.includes(arch))) {
  throw new Error('用法：package-release.mjs mac unified [x64|arm64|all] 或 win unified [x64|ia32]');
}
const architectures = platform === 'mac' ? (arch === 'all' ? macArchitectures : [arch || 'x64']) : [arch];
const run = args => {
  // Invoke JavaScript entry points directly: modern Node cannot spawn a .cmd
  // without a shell, and release arguments must not be interpreted by a shell.
  const result = spawnSync(process.execPath, args, { cwd: directory, stdio: 'inherit', windowsHide: true, env: { ...process.env, PROCTOR_BUILD_CHANNEL: channel } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
if (platform === 'win') {
  run(['scripts/prepare-windows-prerequisites.mjs']);
  run(['scripts/prepare-win-ffmpeg.mjs']);
} else {
  for (const architecture of architectures) run(['scripts/prepare-mac-ffmpeg.mjs', architecture]);
}
run(['scripts/build-desktop.mjs']);
const target = requested === 'pack' ? [platform === 'mac' ? '--mac' : '--win', '--dir'] : platform === 'mac' ? ['--mac', 'dmg'] : ['--win'];
const origin = 'https://proctoring.example.test';
const builder = require.resolve('electron-builder/cli.js');
const macSigning = [
  '--config.mac.identity=-',
  '--config.mac.entitlements=entitlements.mac.adhoc.plist',
  '--config.mac.entitlementsInherit=entitlements.mac.adhoc.plist',
];
for (const architecture of architectures) {
  const artifact = platform === 'mac'
    ? `proctor-\${version}-${channel}-mac-\${arch}.\${ext}`
    : `proctor-\${version}-${channel}-windows-setup.\${ext}`;
  const feedTarget = platform === 'mac' ? `mac-${architecture}` : 'windows';
  run([builder, ...target, ...(architecture ? [`--${architecture}`] : []), ...(platform === 'mac' ? macSigning : []),
    '--publish', 'never',
    `--config.publish.url=${origin}/api/desktop/updates/intranet/${feedTarget}/`,
    `--config.directories.output=release/${channel}`,
    `--config.${platform}.artifactName=${artifact}`]);
}
