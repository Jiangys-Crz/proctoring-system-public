import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const { version, build: { productName } } = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const output = resolve(process.env.PROCTOR_DESKTOP_DIST || join(desktop, 'release', 'wx-wkwebview'));
const identity = process.env.PROCTOR_MAC_SIGN_IDENTITY || '-';
const run = (command, args) => execFileSync(command, args, { cwd: desktop, stdio: 'inherit' });
const entitlements = 'entitlements.mac.plist';

function signLegacyRuntime(runtime, sign) {
  const frameworks = join(runtime, 'Contents', 'Frameworks');
  const signFrameworks = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith('.app')) {
        signFrameworks(file);
        if (entry.name.endsWith('.framework')) run('codesign', [...sign, file]);
      } else if (entry.isFile() && (entry.name.endsWith('.dylib') || ['chrome_crashpad_handler', 'ShipIt'].includes(entry.name))) {
        run('codesign', [...sign, file]);
      }
    }
  };
  // The Electron release ZIP has no complete distribution signature. Seal its
  // Mach-O libraries and frameworks before signing the helper and host bundles.
  signFrameworks(frameworks);
  for (const subApp of readdirSync(frameworks).filter(name => name.endsWith('.app'))) {
    run('codesign', [...sign, '--entitlements', entitlements, join(frameworks, subApp)]);
  }
  run('codesign', [...sign, '--entitlements', entitlements, runtime]);
}

export function assembleMacDmg(build, arch) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('无效的 Mac 安装包架构');
  const stage = mkdtempSync(join(tmpdir(), 'proctor-wk-'));
  try {
    const appName = `${productName}.app`;
    const app = join(stage, appName);
    run('/usr/bin/ditto', [join(build, 'mac', appName), app]);
    const sign = ['--force', '--sign', identity];
    if (identity !== '-') sign.push('--options', 'runtime', '--timestamp');
    signLegacyRuntime(join(app, 'Contents', 'Helpers', 'Electron.app'), sign);
    run('codesign', [...sign, join(app, 'Contents/Resources/ffmpeg/ffmpeg')]);
    run('codesign', [...sign, '--entitlements', entitlements, app]);
    run('codesign', ['--verify', '--deep', '--strict', '--all-architectures', app]);
    symlinkSync('/Applications', join(stage, 'Applications'));
    mkdirSync(output, { recursive: true });
    const file = join(output, `proctor-${version}-mac-${arch}.dmg`);
    run('hdiutil', ['create', '-ov', '-fs', 'HFS+', '-format', 'UDZO', '-volname', productName, '-srcfolder', stage, file]);
    if (identity !== '-') run('codesign', ['--force', '--timestamp', '--sign', identity, file]);
    return file;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] || 'all';
  if (process.platform !== 'darwin' || !['all', 'arm64', 'x64'].includes(target)) {
    throw new Error('请在 macOS 上打包，架构参数为 all、arm64 或 x64');
  }
  const channel = process.env.PROCTOR_BUILD_CHANNEL || 'unified';
  if (!['unified', 'public', 'intranet'].includes(channel)) throw new Error('无效的客户端发布渠道');
  for (const arch of target === 'all' ? ['arm64', 'x64'] : [target]) {
    run(process.execPath, ['scripts/prepare-mac-ffmpeg.mjs', arch]);
    run(process.execPath, ['wx/mac/prepare-mac-legacy-runtime.mjs', arch]);
    const build = join(desktop, 'build', 'wx-mac', channel, arch);
    run('cmake', ['-S', 'wx', '-B', build, '-G', 'Unix Makefiles', '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : arch}`,
      `-DPROCTOR_BUILD_CHANNEL=${channel}`, '-DPROCTOR_PACKAGED=ON']);
    run('cmake', ['--build', build, '--config', 'Release', '--parallel']);
    assembleMacDmg(build, arch);
  }
}
