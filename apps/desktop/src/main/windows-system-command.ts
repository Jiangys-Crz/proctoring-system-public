import { existsSync } from 'node:fs';
import path from 'node:path';

/** Avoid PATH replacements and the 32-bit PowerShell redirector. Sysnative is
 * available to a WOW64 client and selects the native system tool. */
export function windowsSystemCommand(relative: string, {
  env = process.env, arch = process.arch, exists = existsSync
}: { env?: NodeJS.ProcessEnv; arch?: string; exists?: (file: string) => boolean } = {}) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  if (arch === 'ia32') {
    const native = path.win32.join(root, 'Sysnative', relative);
    if (exists(native)) return native;
  }
  return path.win32.join(root, 'System32', relative);
}

export function windowsPowerShell() {
  return windowsSystemCommand('WindowsPowerShell\\v1.0\\powershell.exe');
}

export const windowsUtf8Output = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding';

export const windowsProcessInventoryScript = [
  windowsUtf8Output,
  "$ErrorActionPreference = 'Stop'",
  '$items = $null',
  'try {',
  '  $items = @(Get-WmiObject -Class Win32_Process -EnableAllPrivileges -ErrorAction Stop)',
  '} catch { $items = $null }',
  'if (!$items) {',
  '  try { if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { $items = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) } } catch { $items = $null }',
  '}',
  'if ($items) {',
  "  $items | Select-Object @{Name='Id';Expression={$_.ProcessId}},@{Name='ProcessName';Expression={$_.Name}},@{Name='Path';Expression={$_.ExecutablePath}} | ConvertTo-Csv -NoTypeInformation",
  '} else {',
  '  Get-Process -ErrorAction Stop | Select-Object Id,ProcessName,Path | ConvertTo-Csv -NoTypeInformation',
  '}'
].join('\n');
