param(
    [switch]$FunctionsOnly,
    [string]$CertificatePath = (Join-Path $PSScriptRoot 'root.cer'),
    [string]$CertificateSha256,
    [string]$Address = '192.168.50.20',
    [string[]]$Names = @('proctoring.example.test', 'proctorstu.example.test', 'proctorstream.example.test', 'proctorrtc.example.test')
)
$ErrorActionPreference = 'Stop'

function Update-ProctorHostsText([string]$Text, [string]$Address, [string[]]$Names) {
    $lines = New-Object 'System.Collections.Generic.List[string]'
    foreach ($line in [regex]::Split($Text, "\r\n|\n|\r")) {
        if ($line.Trim() -eq '# BEGIN CWNUPAA PROCTOR INTRANET' -or $line.Trim() -eq '# END CWNUPAA PROCTOR INTRANET') { continue }
        $commentAt = $line.IndexOf('#')
        $body = $line; $comment = ''
        if ($commentAt -ge 0) { $body = $line.Substring(0, $commentAt); $comment = $line.Substring($commentAt) }
        $parts = @($body.Trim() -split '\s+' | Where-Object { $_ })
        if ($parts.Count -gt 1) {
            $aliases = @($parts[1..($parts.Count - 1)])
            $kept = @($aliases | Where-Object { $Names -notcontains $_ })
            if ($kept.Count -ne $aliases.Count) {
                if ($kept.Count) { $lines.Add($parts[0] + "`t" + ($kept -join ' ') + $(if ($comment) { ' ' + $comment } else { '' })) }
                elseif ($comment) { $lines.Add($comment) }
                continue
            }
        }
        $lines.Add($line)
    }
    $original = ($lines -join "`r`n").TrimEnd([char[]]"`r`n")
    return $original + "`r`n# BEGIN CWNUPAA PROCTOR INTRANET`r`n" + $Address + "`t" + ($Names -join ' ') + "`r`n# END CWNUPAA PROCTOR INTRANET`r`n"
}

if ($FunctionsOnly) { return }
try {
    $config = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\renderer\config.js'))
    if ($config -notmatch "PROCTOR_RELEASE_CHANNEL\s*=\s*['`"]intranet['`"]") { exit 0 }
    if ($CertificateSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Provide the SHA-256 checksum of your intranet root certificate' }
    $certBytes = [IO.File]::ReadAllBytes($CertificatePath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($certBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($hash -ne $CertificateSha256) { throw 'Intranet root certificate checksum mismatch' }
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$certBytes)
    $store = New-Object Security.Cryptography.X509Certificates.X509Store -ArgumentList 'Root', 'LocalMachine'
    try {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        if (@($store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }).Count -eq 0) { $store.Add($cert) }
    } finally { $store.Close() }
    $hostsPath = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'
    $bytes = [IO.File]::ReadAllBytes($hostsPath)
    $encoding = New-Object Text.UTF8Encoding -ArgumentList $false, $true
    try { $old = $encoding.GetString($bytes) } catch { $encoding = [Text.Encoding]::Default; $old = $encoding.GetString($bytes) }
    if ($old.Length -gt 0 -and [int]$old[0] -eq 0xFEFF) { $old = $old.Substring(1); $encoding = New-Object Text.UTF8Encoding -ArgumentList $true }
    $next = Update-ProctorHostsText $old $Address $Names
    if ($next -ne $old) {
        $backupDir = Join-Path $env:ProgramData 'CWNUPAAProctor\NetworkBackups'
        [IO.Directory]::CreateDirectory($backupDir) | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $backupDir ('hosts.' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff') + '.bak')), $bytes)
        $temporary = $hostsPath + '.cwnupaa-' + $PID + '.tmp'
        try { [IO.File]::WriteAllText($temporary, $next, $encoding); [IO.File]::Replace($temporary, $hostsPath, $null) }
        finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    }
    & (Join-Path $env:WINDIR 'System32\ipconfig.exe') /flushdns | Out-Null
    Write-Output 'Intranet address and trusted certificate configured.'
    exit 0
} catch { Write-Output ('Intranet setup failed: ' + $_.Exception.Message); exit 1 }
