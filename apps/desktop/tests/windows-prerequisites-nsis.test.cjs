const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hook = path.resolve(__dirname, '../build/windows-prerequisites.nsh');
const repository = path.resolve(__dirname, '../../..');

function nsisCompiler() {
  if (process.env.NSIS_MAKENSIS) return process.env.NSIS_MAKENSIS;
  if (process.platform !== 'win32') return 'makensis';
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache/nsis');
  if (!fs.existsSync(cache)) return 'makensis.exe';
  return fs.readdirSync(cache).filter(entry => entry.startsWith('nsis-'))
    .map(entry => path.join(cache, entry, 'Bin/makensis.exe')).find(file => fs.existsSync(file)) || 'makensis.exe';
}

test('dependency hook is invoked after elevation and before removal of the old application', () => {
  const modules = path.join(repository, 'node_modules/.pnpm');
  const builder = fs.readdirSync(modules).find(entry => entry.startsWith('app-builder-lib@'));
  assert(builder, 'Install workspace dependencies before testing the NSIS integration.');
  const template = fs.readFileSync(path.join(modules, builder, 'node_modules/app-builder-lib/templates/nsis/installer.nsi'), 'utf8');
  const section = fs.readFileSync(path.join(modules, builder, 'node_modules/app-builder-lib/templates/nsis/installSection.nsh'), 'utf8');
  const customInit = template.indexOf('!insertmacro customInit');
  assert(customInit > template.indexOf('RequestExecutionLevel admin'));
  assert(customInit > template.indexOf('!insertmacro initMultiUser'));
  assert(customInit < template.indexOf('!include "installSection.nsh"'));
  assert(section.indexOf('!insertmacro uninstallOldVersion') < section.indexOf('!insertmacro customInstall'), 'customInstall is too late for prerequisites');
  const packageConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.equal(packageConfig.build.nsis.perMachine, true, 'The pre-install hook relies on elevated per-machine installation.');
});

test('NSIS compiles the real prerequisite hook with offline resources and excludes it from uninstallers', t => {
  const compiler = nsisCompiler();
  const option = value => `${process.platform === 'win32' ? '/' : '-'}${value}`;
  if (spawnSync(compiler, [option('VERSION')], { windowsHide: true }).error) {
    t.skip('NSIS compiler not installed; set NSIS_MAKENSIS to the makensis executable.'); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor nsis 中文 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'build/windows-prerequisites');
  const scripts = path.join(root, 'resources/windows-prerequisites');
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  // Compile-only fixtures: no generated EXE or system installer is ever run.
  for (const name of ['dotnet452.exe', 'wmf51-x86.msu', 'wmf51-x64.msu', 'manifest.ini']) {
    fs.writeFileSync(path.join(resources, name), `compile fixture: ${name}`);
  }
  fs.writeFileSync(path.join(scripts, 'install-prerequisites.ps1'), 'exit 0\r\n');
  function compile(uninstaller = false) {
    const script = path.join(root, uninstaller ? 'uninstaller.nsi' : 'installer.nsi');
    fs.writeFileSync(script, `Unicode true\nName "Compile-only fixture"\nOutFile "${path.join(root, uninstaller ? 'uninstall.exe' : 'setup.exe')}"\nRequestExecutionLevel user\n!define PROJECT_DIR "${root}"\n!define BUILD_RESOURCES_DIR "${path.join(root, 'build')}"\n${uninstaller ? '!define BUILD_UNINSTALLER\n' : ''}!include "${hook}"\nFunction .onInit\n${uninstaller ? '' : '!insertmacro customInit\n'}FunctionEnd\nSection\nSectionEnd\n`);
    return spawnSync(compiler, [option('INPUTCHARSET'), 'UTF8', option('V2'), script], { windowsHide: true, encoding: 'utf8' });
  }
  const result = compile();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert(fs.statSync(path.join(root, 'setup.exe')).size > 0);
  // Missing mandatory packages must stop packaging instead of shipping a broken update.
  fs.unlinkSync(path.join(resources, 'wmf51-x64.msu'));
  const missing = compile();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /wmf51-x64/);
  const uninstall = compile(true);
  assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr);
});
