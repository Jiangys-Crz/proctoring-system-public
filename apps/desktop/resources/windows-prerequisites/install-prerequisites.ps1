#Requires -Version 2.0
# This bootstrap must run on Windows 7's original PowerShell and .NET 3.5.
param(
  [string]$PackageDirectory,
  [string]$LogPath,
  [switch]$CheckOnly,
  [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'
$script:PrerequisiteLogPath = $LogPath

function Write-PrerequisiteMessage([string]$Message) {
  $Line = '[Win7 prerequisites] ' + $Message
  Write-Host $Line
  if ($script:PrerequisiteLogPath) {
    try {
      if ([IO.File]::Exists($script:PrerequisiteLogPath) -and
          (([IO.File]::GetAttributes($script:PrerequisiteLogPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'Refusing a linked log file.'
      }
      [IO.File]::AppendAllText($script:PrerequisiteLogPath, ([DateTime]::Now.ToString('s') + ' ' + $Line + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    } catch { [Console]::Error.WriteLine('Cannot write prerequisite log: ' + $_.Exception.Message) }
  }
}

function Read-PrerequisiteRegistryValue([string]$KeyPath, [string]$Name) {
  $Key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($KeyPath)
  if ($null -eq $Key) { return $null }
  try { return $Key.GetValue($Name, $null) }
  finally { $Key.Close() }
}

function Test-PrerequisiteRegistryKey([string]$KeyPath) {
  $Key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($KeyPath)
  if ($null -eq $Key) { return $false }
  $Key.Close()
  return $true
}

function Get-WindowsPrerequisiteState {
  $Os = Get-WmiObject -Class Win32_OperatingSystem
  $Version = New-Object Version([string]$Os.Version)
  $IsWindows7 = $Version.Major -eq 6 -and $Version.Minor -eq 1
  if (!$IsWindows7) { return @{ IsWindows7 = $false } }
  $PowerShellVersion = $PSVersionTable.PSVersion
  foreach ($Key in @('SOFTWARE\Microsoft\PowerShell\3\PowerShellEngine', 'SOFTWARE\Microsoft\PowerShell\1\PowerShellEngine')) {
    $Installed = Read-PrerequisiteRegistryValue $Key 'PowerShellVersion'
    if ($Installed) {
      $Candidate = New-Object Version([string]$Installed)
      if ($Candidate -gt $PowerShellVersion) { $PowerShellVersion = $Candidate }
    }
  }
  $NetRelease = Read-PrerequisiteRegistryValue 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' 'Release'
  if ((Read-PrerequisiteRegistryValue 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' 'Install') -ne 1) { $NetRelease = 0 }
  $Wmf3 = @(Get-WmiObject -Query "select * from Win32_QuickFixEngineering where HotFixID = 'KB2506143'")
  $Pending = (Test-PrerequisiteRegistryKey 'SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
    (Test-PrerequisiteRegistryKey 'SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
  $Renames = Read-PrerequisiteRegistryValue 'SYSTEM\CurrentControlSet\Control\Session Manager' 'PendingFileRenameOperations'
  if ($Renames -and @($Renames | Where-Object { $_ }).Count -gt 0) { $Pending = $true }
  return @{
    IsWindows7 = $true
    ServicePack = [int]$Os.ServicePackMajorVersion
    PowerShellVersion = $PowerShellVersion
    NetRelease = [int]$NetRelease
    Wmf3Installed = ($PowerShellVersion.Major -eq 3 -or $Wmf3.Count -gt 0)
    PendingReboot = [bool]$Pending
    Is64BitOS = ([IntPtr]::Size -eq 8 -or [bool]$env:PROCESSOR_ARCHITEW6432)
    Is64BitProcess = ([IntPtr]::Size -eq 8)
  }
}

function Read-PrerequisiteManifest([string]$Directory) {
  $ManifestPath = Join-Path $Directory 'manifest.ini'
  $Hashes = @{}
  foreach ($Line in [IO.File]::ReadAllLines($ManifestPath)) {
    if (!$Line.Trim()) { continue }
    if ($Line -notmatch '^(dotnet452\.exe|wmf51-x86\.msu|wmf51-x64\.msu)=([a-fA-F0-9]{64})$') {
      throw 'The offline prerequisite manifest is invalid. Obtain a complete official client installer.'
    }
    $Name = $Matches[1]
    if ($Hashes.ContainsKey($Name)) { throw 'Duplicate prerequisite manifest entry.' }
    $Hashes[$Name] = $Matches[2].ToLowerInvariant()
  }
  if ($Hashes.Count -ne 3) { throw 'The offline prerequisite manifest is incomplete.' }
  return $Hashes
}

function Get-PrerequisiteSha256([string]$Filename) {
  $Stream = [IO.File]::OpenRead($Filename)
  $Algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($Algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
  finally { $Algorithm.Clear(); $Stream.Close() }
}

function Assert-TrustedPrerequisitePackage([string]$Filename, [string]$ExpectedHash) {
  if (![IO.File]::Exists($Filename) -or (([IO.File]::GetAttributes($Filename) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw ('Missing or linked offline prerequisite package: ' + [IO.Path]::GetFileName($Filename))
  }
  if ((Get-PrerequisiteSha256 $Filename) -cne $ExpectedHash) {
    throw ('Offline prerequisite checksum mismatch: ' + [IO.Path]::GetFileName($Filename) + '. Obtain a fresh installer.')
  }
  $Signature = Get-AuthenticodeSignature -FilePath ([WildcardPattern]::Escape($Filename))
  if ([string]$Signature.Status -ne 'Valid' -or !$Signature.SignerCertificate -or
      $Signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
    throw ('Cannot verify the Microsoft signature of ' + [IO.Path]::GetFileName($Filename) + '. Ask the administrator to update Windows certificate trust or prepare the prerequisites manually; verification cannot be bypassed.')
  }
  Write-PrerequisiteMessage ('Verified Microsoft package: ' + [IO.Path]::GetFileName($Filename))
}

function Get-PrerequisiteWusa([bool]$Is64BitOS, [bool]$Is64BitProcess) {
  if (!$env:SystemRoot -or ![IO.Path]::IsPathRooted($env:SystemRoot)) { throw 'Windows system directory is unavailable.' }
  $SystemDirectory = 'System32'
  if ($Is64BitOS -and !$Is64BitProcess) { $SystemDirectory = 'Sysnative' }
  return Join-Path (Join-Path $env:SystemRoot $SystemDirectory) 'wusa.exe'
}

function Invoke-PrerequisiteInstaller([string]$Filename, [string]$Arguments) {
  $Start = New-Object Diagnostics.ProcessStartInfo
  $Start.FileName = $Filename
  $Start.Arguments = $Arguments
  $Start.UseShellExecute = $false
  $Start.CreateNoWindow = $true
  $Process = New-Object Diagnostics.Process
  $Process.StartInfo = $Start
  try {
    if (!$Process.Start()) { throw 'Could not start the prerequisite installer.' }
    $Process.WaitForExit()
    return $Process.ExitCode
  } finally { $Process.Dispose() }
}

function Test-PrerequisiteAdministrator {
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } finally { $Identity.Dispose() }
}

function Invoke-WindowsPrerequisites([string]$Directory, [bool]$InspectOnly) {
  try {
    $State = Get-WindowsPrerequisiteState
    if (!$State.IsWindows7) {
      Write-PrerequisiteMessage 'This operating system does not need the Windows 7 prerequisite bundle.'
      return 0
    }
    if ($State.ServicePack -lt 1) {
      Write-PrerequisiteMessage 'Windows 7 SP1 is required. Ask the administrator to install SP1 before running this installer again.'
      return 3
    }
    $MinimumPowerShell = New-Object Version('5.1')
    if ($State.PowerShellVersion -ge $MinimumPowerShell -and $State.NetRelease -ge 379893 -and !$State.PendingReboot) {
      Write-PrerequisiteMessage 'Windows PowerShell 5.1 and .NET prerequisites are ready. Nothing needs installing.'
      return 0
    }
    if ($State.Wmf3Installed) {
      Write-PrerequisiteMessage 'WMF 3.0 (KB2506143) is installed. Ask the administrator to uninstall that update and restart Windows before installing WMF 5.1. This installer will not uninstall it automatically.'
      return 3
    }
    if ($State.PendingReboot) {
      Write-PrerequisiteMessage 'Windows has a pending restart. Restart the computer, then run this client installer again before the exam.'
      return 3010
    }
    if ($InspectOnly) {
      Write-PrerequisiteMessage 'Windows 7 prerequisites are missing. The installer can install the bundled Microsoft packages with administrator privileges. A restart may be required.'
      return 2
    }
    if (!(Test-PrerequisiteAdministrator)) { throw 'Run the client installation wizard as an administrator to install Windows prerequisites.' }
    $Hashes = Read-PrerequisiteManifest $Directory
    $WmfName = 'wmf51-x86.msu'
    if ($State.Is64BitOS) { $WmfName = 'wmf51-x64.msu' }
    $WmfFile = Join-Path $Directory $WmfName
    # Validate every package that may run before changing the system.
    if ($State.NetRelease -lt 379893) {
      Assert-TrustedPrerequisitePackage (Join-Path $Directory 'dotnet452.exe') $Hashes['dotnet452.exe']
    }
    if ($State.PowerShellVersion -lt $MinimumPowerShell) {
      Assert-TrustedPrerequisitePackage $WmfFile $Hashes[$WmfName]
    }
    if ($State.NetRelease -lt 379893) {
      Write-PrerequisiteMessage 'Installing Microsoft .NET Framework 4.5.2. Please wait; Windows will not be restarted automatically.'
      $NetCode = Invoke-PrerequisiteInstaller (Join-Path $Directory 'dotnet452.exe') '/q /norestart'
      Write-PrerequisiteMessage ('The .NET installer returned ' + $NetCode + '.')
      if ($NetCode -eq 3010 -or $NetCode -eq 1641) {
        Write-PrerequisiteMessage 'Restart Windows, then run this client installer again to finish preparing PowerShell.'
        return 3010
      }
      if ($NetCode -ne 0) { throw ('The .NET installer failed with exit code ' + $NetCode + '. Ask the administrator to inspect the .NET installation logs.') }
      $State = Get-WindowsPrerequisiteState
      if ($State.PendingReboot) { Write-PrerequisiteMessage 'Restart Windows before continuing with WMF 5.1.'; return 3010 }
      if ($State.NetRelease -lt 379893) { throw 'The .NET installer reported success, but .NET 4.5.2 or later was not detected.' }
    }
    if ($State.PowerShellVersion -lt $MinimumPowerShell) {
      Write-PrerequisiteMessage 'Installing Microsoft WMF 5.1. Please wait; Windows will not be restarted automatically.'
      $Wusa = Get-PrerequisiteWusa $State.Is64BitOS $State.Is64BitProcess
      $WmfCode = Invoke-PrerequisiteInstaller $Wusa ('"' + $WmfFile + '" /quiet /norestart')
      Write-PrerequisiteMessage ('The WMF installer returned ' + $WmfCode + '.')
      # WUA_S_REBOOT_REQUIRED=2359301, WUA_S_ALREADY_INSTALLED=2359302.
      if ($WmfCode -eq 0 -or $WmfCode -eq 3010 -or $WmfCode -eq 1641 -or $WmfCode -eq 2359301) {
        Write-PrerequisiteMessage 'WMF installation completed. Restart Windows, then run this client installer again to verify PowerShell before the exam.'
        return 3010
      }
      if ($WmfCode -ne 2359302) { throw ('The WMF installer failed with exit code ' + $WmfCode + '. Ask the administrator to inspect Windows Update logs.') }
      $State = Get-WindowsPrerequisiteState
      if ($State.PendingReboot -or $State.PowerShellVersion -lt $MinimumPowerShell) {
        Write-PrerequisiteMessage 'WMF is already installed but PowerShell is not ready. Restart Windows, then run this client installer again.'
        return 3010
      }
    }
    Write-PrerequisiteMessage 'Windows prerequisites are ready.'
    return 0
  } catch {
    Write-PrerequisiteMessage ('Preparation failed: ' + $_.Exception.Message)
    return 1
  }
}

if (!$LibraryOnly) {
  if (!$PackageDirectory) { $PackageDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path }
  $Result = Invoke-WindowsPrerequisites $PackageDirectory ([bool]$CheckOnly)
  exit $Result
}
