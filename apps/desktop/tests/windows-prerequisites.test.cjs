const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const bootstrap = path.resolve(__dirname, '../resources/windows-prerequisites/install-prerequisites.ps1');
const windows = { skip: process.platform !== 'win32', timeout: 30000 };
function powershell(source, environment = {}) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(executable, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    env: { ...process.env, PREREQUISITE_SCRIPT: bootstrap, ...environment }, encoding: 'utf8', windowsHide: true, timeout: 25000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const value = result.stdout.match(/__RESULT__(.+)/);
  assert(value, result.stdout);
  return JSON.parse(value[1]);
}
const win7 = (patch = '') => `@{ IsWindows7=$true; ServicePack=1; PowerShellVersion=(New-Object Version('2.0')); NetRelease=0; Wmf3Installed=$false; PendingReboot=$false; Is64BitOS=$true; Is64BitProcess=$true; ${patch} }`;
const state = patch => {
  const values = { IsWindows7: '$true', ServicePack: '1', PowerShellVersion: "(New-Object Version('2.0'))", NetRelease: '0', Wmf3Installed: '$false', PendingReboot: '$false', Is64BitOS: '$true', Is64BitProcess: '$true', ...patch };
  return '@{ ' + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('; ') + ' }';
};
function simulate({ states = [win7()], codes = [], checkOnly = false, admin = true, verificationFailure = false } = {}) {
  return powershell(`
    . $env:PREREQUISITE_SCRIPT -LibraryOnly
    $script:States=@(${states.join(',')}); $script:StateReads=0
    $script:Codes=@(${codes.join(',')}); $script:CodeIndex=0; $script:Calls=@(); $script:Verified=@()
    function Get-WindowsPrerequisiteState {
      $index=[Math]::Min($script:StateReads, $script:States.Count-1); $script:StateReads++
      return $script:States[$index]
    }
    function Test-PrerequisiteAdministrator { return $${admin} }
    function Read-PrerequisiteManifest { return @{ 'dotnet452.exe'='hash'; 'wmf51-x86.msu'='hash'; 'wmf51-x64.msu'='hash' } }
    function Assert-TrustedPrerequisitePackage($Filename, $ExpectedHash) {
      $script:Verified+=([IO.Path]::GetFileName($Filename))
      ${verificationFailure ? "throw 'Signature verification rejected the package.'" : ''}
    }
    function Invoke-PrerequisiteInstaller($Filename, $Arguments) {
      $script:Calls+=@{ file=$Filename; arguments=$Arguments }
      if ($script:CodeIndex -ge $script:Codes.Count) { throw 'Unexpected installer invocation.' }
      $code=$script:Codes[$script:CodeIndex]; $script:CodeIndex++; return $code
    }
    $code=Invoke-WindowsPrerequisites 'C:\\offline bundle' $${checkOnly}
    [Console]::WriteLine('__RESULT__'+(@{code=$code; calls=@($script:Calls); verified=@($script:Verified); reads=$script:StateReads} | ConvertTo-Json -Compress -Depth 10))
  `);
}

test('bootstrap keeps the dependency-checking path compatible with stock PowerShell 2 and CLR 2', () => {
  const source = fs.readFileSync(bootstrap, 'utf8');
  assert.match(source, /#Requires -Version 2\.0/);
  assert.doesNotMatch(source, /\$PSScriptRoot|ConvertFrom-Json|ConvertTo-Json|Get-FileHash|\[pscustomobject\]|\[ordered\]|::new\(|OpenBaseKey|RegistryView|Is64BitOperatingSystem|(?<!\w)-notin\b|(?<!\w)-in\b/);
  assert.doesNotMatch(source, /Restart-Computer|shutdown\.exe|\/forcerestart|Invoke-Expression|DownloadFile|Invoke-WebRequest/);
});

test('CheckOnly never installs, validates packages, or requires the offline resources', windows, () => {
  for (const [machine, expected] of [
    ['@{IsWindows7=$false}', 0],
    [state({ PowerShellVersion: "(New-Object Version('5.1'))", NetRelease: '379893' }), 0],
    [win7(), 2],
    [state({ ServicePack: '0' }), 3],
    [state({ Wmf3Installed: '$true' }), 3],
    [state({ PendingReboot: '$true' }), 3010],
  ]) {
    const result = simulate({ states: [machine], checkOnly: true });
    assert.equal(result.code, expected);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.verified, []);
  }
});

test('a current Win7 environment skips packages while unprepared, WMF3 and pending restart states remain blocked', windows, () => {
  for (const [machine, code] of [
    [state({ PowerShellVersion: "(New-Object Version('5.1'))", NetRelease: '528049' }), 0],
    [state({ ServicePack: '0' }), 3],
    [state({ Wmf3Installed: '$true' }), 3],
    [state({ PendingReboot: '$true' }), 3010],
    [state({ PowerShellVersion: "(New-Object Version('5.1'))", NetRelease: '528049', PendingReboot: '$true' }), 3010],
  ]) {
    const result = simulate({ states: [machine] });
    assert.equal(result.code, code);
    assert.deepEqual(result.calls, []);
  }
});

test('bootstrap requires administrator rights and verifies packages before starting system changes', windows, () => {
  for (const patch of [{ admin: false }, { verificationFailure: true }]) {
    const result = simulate(patch);
    assert.equal(result.code, 1);
    assert.deepEqual(result.calls, []);
  }
});

test('.NET installs before WMF, both are verified first, and completed WMF installation returns restart-required', windows, () => {
  const result = simulate({ states: [win7(), state({ NetRelease: '379893' })], codes: [0, 0] });
  assert.equal(result.code, 3010);
  assert.deepEqual(result.verified, ['dotnet452.exe', 'wmf51-x64.msu']);
  assert.equal(result.calls.length, 2);
  assert.match(result.calls[0].file, /dotnet452\.exe$/);
  assert.equal(result.calls[0].arguments, '/q /norestart');
  assert.match(result.calls[1].file, /System32\\wusa\.exe$/);
  assert.equal(result.calls[1].arguments, '"C:\\offline bundle\\wmf51-x64.msu" /quiet /norestart');
});

test('.NET failure or reboot never proceeds to WMF, and a false success is detected', windows, () => {
  for (const code of [3010, 1641, 1603]) {
    const result = simulate({ codes: [code] });
    assert.equal(result.code, code === 1603 ? 1 : 3010);
    assert.equal(result.calls.length, 1);
  }
  const falseSuccess = simulate({ codes: [0] });
  assert.equal(falseSuccess.code, 1);
  assert.equal(falseSuccess.calls.length, 1);
  const restartFlag = simulate({ states: [win7(), state({ NetRelease: '379893', PendingReboot: '$true' })], codes: [0] });
  assert.equal(restartFlag.code, 3010);
  assert.equal(restartFlag.calls.length, 1);
});

test('WUSA exit codes preserve restart and failure semantics instead of claiming readiness', windows, () => {
  for (const code of [0, 3010, 1641, 2359301, 2359302, -2145124329]) {
    const result = simulate({ states: [state({ NetRelease: '379893' })], codes: [code] });
    assert.equal(result.code, code === -2145124329 ? 1 : 3010);
    assert.equal(result.calls.length, 1);
  }
  const confirmed = simulate({ states: [state({ NetRelease: '379893' }), state({ PowerShellVersion: "(New-Object Version('5.1'))", NetRelease: '379893' })], codes: [2359302] });
  assert.equal(confirmed.code, 0);
});

test('architecture selection follows the OS and avoids WOW64 system command redirection', windows, () => {
  const wow64 = simulate({ states: [state({ NetRelease: '379893', Is64BitProcess: '$false' })], codes: [3010] });
  assert.deepEqual(wow64.verified, ['wmf51-x64.msu']);
  assert.match(wow64.calls[0].file, /Sysnative\\wusa\.exe$/);
  const x86 = simulate({ states: [state({ NetRelease: '379893', Is64BitOS: '$false', Is64BitProcess: '$false' })], codes: [3010] });
  assert.deepEqual(x86.verified, ['wmf51-x86.msu']);
  assert.match(x86.calls[0].file, /System32\\wusa\.exe$/);
});

test('manifest accepts only the three fixed filenames and valid hashes, never executable input', windows, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prerequisite manifest '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const valid = ['dotnet452.exe', 'wmf51-x86.msu', 'wmf51-x64.msu'].map(name => `${name}=${'a'.repeat(64)}`).join('\n');
  for (const [contents, expected] of [[valid, true], [valid + '\nInvoke-Expression bad', false], [valid + '\n' + valid, false], [valid.replace('dotnet452.exe', '../dotnet452.exe'), false], [valid.split('\n').slice(1).join('\n'), false]]) {
    fs.writeFileSync(path.join(directory, 'manifest.ini'), contents);
    const accepted = powershell(`. $env:PREREQUISITE_SCRIPT -LibraryOnly
      try { $hashes=Read-PrerequisiteManifest $env:PREREQUISITE_DIRECTORY; $accepted=$hashes.Count -eq 3 } catch { $accepted=$false }
      [Console]::WriteLine('__RESULT__'+($accepted | ConvertTo-Json -Compress))`, { PREREQUISITE_DIRECTORY: directory });
    assert.equal(accepted, expected);
  }
});

test('machine detection checks installed WMF3 KB and active .NET Full installation, not just version remnants', windows, () => {
  for (const [installed, kbPresent] of [[true, true], [false, false]]) {
    const result = powershell(`. $env:PREREQUISITE_SCRIPT -LibraryOnly
      $PSVersionTable.PSVersion=New-Object Version('2.0')
      $script:Queries=@()
      function Get-WmiObject($Class, $Query) {
        if ($Class -eq 'Win32_OperatingSystem') { return @{Version='6.1.7601';ServicePackMajorVersion=1} }
        $script:Queries+=$Query
        ${kbPresent ? "return @{HotFixID='KB2506143'}" : ''}
      }
      function Read-PrerequisiteRegistryValue($KeyPath, $Name) {
        if ($Name -eq 'PowerShellVersion') { return '2.0' }
        if ($Name -eq 'Release') { return 379893 }
        if ($Name -eq 'Install') { return ${installed ? '1' : '0'} }
      }
      function Test-PrerequisiteRegistryKey { return $false }
      $state=Get-WindowsPrerequisiteState
      [Console]::WriteLine('__RESULT__'+(@{ state=$state; queries=$script:Queries } | ConvertTo-Json -Compress -Depth 10))`);
    assert.equal(result.state.NetRelease, installed ? 379893 : 0);
    assert.equal(result.state.Wmf3Installed, kbPresent);
    assert.deepEqual(result.queries, ["select * from Win32_QuickFixEngineering where HotFixID = 'KB2506143'"]);
  }
});

test('check-only diagnostics append to the installer supplied log without needing offline packages', windows, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prerequisite log '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'install.log');
  fs.writeFileSync(filename, 'installer start\n');
  const result = powershell(`. $env:PREREQUISITE_SCRIPT -LibraryOnly -LogPath $env:PREREQUISITE_LOG
    function Get-WindowsPrerequisiteState { return ${win7()} }
    $code=Invoke-WindowsPrerequisites 'C:\\missing-offline-packages' $true
    [Console]::WriteLine('__RESULT__'+($code | ConvertTo-Json -Compress))`, { PREREQUISITE_LOG: filename });
  assert.equal(result, 2);
  assert.match(fs.readFileSync(filename, 'utf8'), /^installer start\n[\s\S]*Windows 7 prerequisites are missing/);
});

test('package verification checks content hashes and valid Microsoft signatures, escaping wildcard paths', windows, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prerequisite [test] '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'dotnet452.exe');
  fs.writeFileSync(filename, 'fake executable that must never run');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  for (const [checksum, status, signer, accepted] of [
    [hash, 'Valid', 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US', true],
    ['0'.repeat(64), 'Valid', 'O=Microsoft Corporation', false],
    [hash, 'NotSigned', 'O=Microsoft Corporation', false],
    [hash, 'Valid', 'O=Another Company', false],
  ]) {
    const result = powershell(`. $env:PREREQUISITE_SCRIPT -LibraryOnly
      $script:SignaturePath=''
      function Get-AuthenticodeSignature($FilePath) { $script:SignaturePath=$FilePath; return @{Status=$env:FAKE_SIGNATURE_STATUS; SignerCertificate=@{Subject=$env:FAKE_SIGNATURE_SUBJECT}} }
      try { Assert-TrustedPrerequisitePackage $env:PREREQUISITE_PACKAGE $env:PREREQUISITE_HASH; $accepted=$true } catch { $accepted=$false }
      [Console]::WriteLine('__RESULT__'+(@{accepted=$accepted; path=$script:SignaturePath} | ConvertTo-Json -Compress))`, {
      PREREQUISITE_PACKAGE: filename, PREREQUISITE_HASH: checksum, FAKE_SIGNATURE_STATUS: status, FAKE_SIGNATURE_SUBJECT: signer,
    });
    assert.equal(result.accepted, accepted);
    if (checksum === hash) assert.match(result.path, /`\[test`\]/);
  }
});

test('real CheckOnly can inspect this development machine without running installation', windows, () => {
  const result = powershell(`. $env:PREREQUISITE_SCRIPT -LibraryOnly
    function Invoke-PrerequisiteInstaller { throw 'Test attempted a real installation.' }
    $code=Invoke-WindowsPrerequisites 'C:\\missing-test-only-packages' $true
    [Console]::WriteLine('__RESULT__'+($code | ConvertTo-Json -Compress))`);
  assert([0, 2, 3, 3010].includes(result));
});
