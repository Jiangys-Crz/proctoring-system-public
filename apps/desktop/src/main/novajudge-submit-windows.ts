import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function windowsPowerShell() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Only static PowerShell source enters argv; paths are passed as environment
// values, and device tokens are never passed to a subprocess.
function run(source: string, environment: Record<string, string>) {
  execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';\n" + source, 'utf16le').toString('base64')], {
    env: { ...process.env, ...environment }, windowsHide: true, timeout: 10_000, stdio: 'pipe',
  });
}

export function protectWindowsSubmitConfig(filename: string) {
  run(`
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$Acl = New-Object Security.AccessControl.FileSecurity
$Acl.SetOwner($Identity)
$Acl.SetAccessRuleProtection($true, $false)
$Acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($Identity, 'FullControl', 'Allow')))
[IO.File]::SetAccessControl($env:NOVAJUDGE_CONFIG_FILE, $Acl)
`, { NOVAJUDGE_CONFIG_FILE: filename });
}

/** An over-the-shoulder UAC login must not install into another user's home. */
export function assertWindowsSubmitUser(home: string) {
  try {
    run(`
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$SessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
$Shells = @(Get-WmiObject Win32_Process -Filter "Name='explorer.exe' AND SessionId=$SessionId")
if (!$Shells.Count) { throw 'Cannot identify the interactive desktop user.' }
foreach ($Shell in $Shells) {
  if ($Shell.GetOwnerSid().Sid -ne $Identity) { throw 'The interactive user differs from the monitoring process.' }
}
if ([IO.Path]::GetFullPath($env:NOVAJUDGE_USER_HOME).TrimEnd('\\') -ine [Environment]::GetFolderPath('UserProfile').TrimEnd('\\')) {
  throw 'The requested home differs from the monitoring user.'
}
`, { NOVAJUDGE_USER_HOME: home });
  } catch {
    throw Object.assign(new Error('Windows submit user mismatch'), { code: 'WINDOWS_USER_MISMATCH' });
  }
}
