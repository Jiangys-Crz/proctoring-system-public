import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve('electron-builder'));
const appBuilder = createRequire(builder.resolve('app-builder-lib'));
const { extractFile } = appBuilder('@electron/asar');

export function verifyPackagedVersion(context) {
  const expected = JSON.parse(readFileSync(path.join(context.packager.projectDir, 'package.json'), 'utf8')).version;
  const mac = context.electronPlatformName === 'darwin';
  const app = mac ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`) : context.appOutDir;
  const archive = path.join(app, mac ? 'Contents/Resources/app.asar' : 'resources/app.asar');
  const packaged = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (context.packager.appInfo.version !== expected || packaged.version !== expected) {
    throw new Error(`打包版本不一致：源码 ${expected}，安装包 ${packaged.version}`);
  }
  if (mac) for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) {
    const actual = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    if (actual !== expected) throw new Error(`Mac ${key} 版本 ${actual} 与源码 ${expected} 不一致`);
  }
  console.log(`Verified packaged ${context.electronPlatformName} version ${expected}`);
}
