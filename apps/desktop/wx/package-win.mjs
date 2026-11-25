import { spawnSync } from 'node:child_process';
import { closeSync, constants, cpSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWindowsVersion } from './windows-version.mjs';
import { windowsPackageInput } from './windows-package-input.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(desktop, 'package.json'));
const { Arch, Platform, WinPackager, build } = require('electron-builder');
const { version, build: { productName } } = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const defaultPayload = path.resolve(desktop, '../../tmp/proctor-wx-dist-109.0.1518.140');
const architectures = new Map([
  ['x64', { arch: Arch.x64, machine: 0x8664 }],
  ['x86', { arch: Arch.ia32, machine: 0x014c }],
  ['arm64', { arch: Arch.arm64, machine: 0xaa64 }],
]);
const args = process.argv.slice(2);
const { names, directories, target } = windowsPackageInput(args, defaultPayload, path.join(desktop, 'release/wx-webview2-109'));
const payloads = names.map((name, index) => ({
  ...architectures.get(name), name, directory: directories[index] ? path.resolve(directories[index]) : path.join(defaultPayload, name),
}));
const channels = payloads.map(({directory}) => /window\.PROCTOR_RELEASE_CHANNEL\s*=\s*['"](unified|public|intranet)['"]/.exec(readFileSync(path.join(directory, 'resources/renderer/config.js'), 'utf8'))?.[1]);
if (!channels[0] || channels.some(channel => channel !== channels[0])) throw new Error('安装包资源的后台类型不一致');
const installChannel = channels[0];
const fixedRuntime = 'webview2/109.0.1518.140';
const binaries = [
  'proctor-desktop.exe',
  'WebView2Loader.dll',
  'resources/ffmpeg/ffmpeg.exe',
  'resources/security/elevate-client.exe',
  'resources/security/inventory-probe.exe',
  'resources/security/screen-control-guard.exe',
  'resources/security/token-probe.exe',
  path.join(fixedRuntime, 'msedgewebview2.exe'),
  path.join(fixedRuntime, 'msedge.dll'),
];

function machine(filename) {
  const file = openSync(filename, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (readSync(file, dos, 0, dos.length, 0) !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`无效的 Windows 二进制文件：${filename}`);
    }
    const pe = Buffer.alloc(6);
    if (readSync(file, pe, 0, pe.length, dos.readUInt32LE(60)) !== pe.length || pe.readUInt32LE(0) !== 0x4550) {
      throw new Error(`无效的 Windows PE 标头：${filename}`);
    }
    return pe.readUInt16LE(4);
  } finally {
    closeSync(file);
  }
}

for (const { name, machine: expected, directory } of payloads) {
  if (!statSync(path.join(directory, 'proctor-desktop.exe'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`缺少 ${name} 客户端构建目录：${directory}。请先按 apps/desktop/wx/README.md 运行 CMake 构建和安装。`);
  }
  const relative = path.relative(directory, target);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
    throw new Error('安装包输出目录须位于待打包客户端目录以外');
  }
  for (const binary of binaries) {
    const filename = path.join(directory, binary);
    if (machine(filename) !== expected) throw new Error(`Windows 二进制架构不匹配：${filename}`);
  }
  checkWindowsVersion(path.join(directory, 'proctor-desktop.exe'), version + '.0');
  checkWindowsVersion(path.join(directory, fixedRuntime, 'msedgewebview2.exe'), '109.0.1518.140');
  const localeDirectory = ['Locales', 'locales'].some(name =>
    statSync(path.join(directory, fixedRuntime, name), { throwIfNoEntry: false })?.isDirectory());
  if (!statSync(path.join(directory, 'resources/renderer/index.html')).isFile() || !localeDirectory) {
    throw new Error(`客户端资源目录不完整：${directory}`);
  }
}

if (names.some(name => name !== 'arm64')) {
  const prepare = spawnSync(process.execPath, ['scripts/prepare-windows-prerequisites.mjs', '--with-ucrt'], {
    cwd: desktop,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (prepare.error) throw prepare.error;
  if (prepare.status !== 0) process.exit(prepare.status || 1);
}

// Electron's NSIS update preserves existing .lnk targets and uses the program
// name to detect a running copy. Stage the native executable at the same name.
// Isolate the CMake install directories from the packager's generated files.
const stageRoot = mkdtempSync(path.join(tmpdir(), 'proctor-wx-nsis-'));
const staged = new Map();
class NativeWinPackager extends WinPackager {
  computeAppOutDir(_outDir, arch) {
    const directory = staged.get(arch);
    if (!directory) throw new Error(`未准备 Windows 架构 ${Arch[arch]} 的客户端`);
    return directory;
  }
}

try {
  for (const { arch, name, directory } of payloads) {
    const stage = path.join(stageRoot, name);
    cpSync(directory, stage, { recursive: true, mode: constants.COPYFILE_FICLONE });
    // Old CMake install directories can retain the removed LAN bootstrap.
    // No Windows installer provisions DNS/hosts or system certificate trust.
    rmSync(path.join(stage, 'resources/intranet'), { recursive: true, force: true });
    renameSync(path.join(stage, 'proctor-desktop.exe'), path.join(stage, productName + '.exe'));
    staged.set(arch, stage);
  }
  await build({
    projectDir: desktop,
    targets: Platform.WINDOWS.createTarget('nsis', ...staged.keys()),
    prepackaged: staged.values().next().value,
    platformPackagerFactory: info => new NativeWinPackager(info),
    publish: 'never',
    config: {
      afterPack: null,
      directories: { output: target },
      win: { artifactName: 'proctor-${version}-' + installChannel + '-wx-webview2-109-setup.${ext}' },
      nsis: { include: 'wx/windows-prerequisites.nsh', buildUniversalInstaller: true, differentialPackage: false },
      publish: null,
    },
  });
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
