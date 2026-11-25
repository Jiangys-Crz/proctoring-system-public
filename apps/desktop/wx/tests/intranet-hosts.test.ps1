$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\resources\intranet\setup.ps1') -FunctionsOnly
$names = @('proctoring.example.test', 'proctorstu.example.test', 'proctorstream.example.test', 'proctorrtc.example.test')
$source = "127.0.0.1 localhost`n192.168.1.159 Proctoring.CWNU PAA unrelated`n192.168.1.2 proctoring.example.test router # preserve`n43.136.170.90 proctoring.example.org`n# note`n"
$result = Update-ProctorHostsText $source '192.168.50.20' $names
if ($result -notmatch '127.0.0.1 localhost' -or $result -notmatch '192.168.50.2\s+router # preserve' -or $result -notmatch '203.0.113.20 proctoring.example.org') { throw 'Unrelated hosts were changed' }
if ($result -match '192.168.50.2 proctoring.example.test router') { throw 'Stale dedicated mapping retained' }
if ($result -ne (Update-ProctorHostsText $result '192.168.50.20' $names)) { throw 'Repeated installation is not idempotent' }
if ($result -notmatch '192.168.50.20\s+proctoring.example.test proctorstu.example.test') { throw 'Intranet mapping absent' }
Write-Output 'PASS dedicated mappings, unrelated aliases, public domains and idempotent upgrades'
