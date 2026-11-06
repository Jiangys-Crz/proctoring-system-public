param(
  [Parameter(Mandatory=$true)] [string]$ExamId,
  [Parameter(Mandatory=$true)] [string]$NovaJudgeRoot,
  [Parameter(Mandatory=$true)] [string]$PrivateFixturePath,
  [string]$ExamNumber = '',
  [string]$OutputDirectory = '',
  [string]$ProctoringUrl = 'http://localhost:4031',
  [string]$AdminFixturePath = '',
  [ValidateSet('dev','production')] [string]$NovaRuntime = 'dev',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $repositoryRoot 'apps\web'
$submitScript = Join-Path $PSScriptRoot 'reaction-novajudge-manual-submit.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
if ($ExamId -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid existing exam ID.' }
$NovaJudgeRoot = [System.IO.Path]::GetFullPath($NovaJudgeRoot)
$PrivateFixturePath = [System.IO.Path]::GetFullPath($PrivateFixturePath)
if (-not (Test-Path -LiteralPath $PrivateFixturePath)) { throw 'Private NovaJudge fixture is missing.' }
$fixture = Get-Content -LiteralPath $PrivateFixturePath -Raw | ConvertFrom-Json
if (-not $ExamNumber) { $ExamNumber = [string]$fixture.teamUsername }
if (-not $ExamNumber -or $ExamNumber -cne [string]$fixture.teamUsername) { throw 'ExamNumber must exactly match the fixture teamUsername.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repositoryRoot ('.local\reaction-manual-e2e\' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not $AdminFixturePath) { $AdminFixturePath = Join-Path $webRoot '.local\reaction-e2e\fixture.private.json' }
$AdminFixturePath = [System.IO.Path]::GetFullPath($AdminFixturePath)
foreach ($requiredFile in @((Join-Path $NovaJudgeRoot '.env'), (Join-Path $webRoot '.env'), $AdminFixturePath, $submitScript)) {
  if (-not (Test-Path -LiteralPath $requiredFile)) { throw "Required existing configuration/script is missing: $requiredFile" }
}
$adminFixture = Get-Content -LiteralPath $AdminFixturePath -Raw | ConvertFrom-Json
if (-not $adminFixture.adminUsername -or -not $adminFixture.adminPassword) { throw 'Administrator fixture needs adminUsername and adminPassword.' }
$adminFixture = $null
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Invoke-NodeJson {
  param([string]$WorkingDirectory, [string[]]$Arguments)
  Push-Location $WorkingDirectory
  try {
    $lines = @(& node @Arguments)
    if ($LASTEXITCODE -ne 0) { throw 'Node check failed; inspect its credential-free error above. No retry was attempted.' }
    try { return ($lines -join "`n") | ConvertFrom-Json }
    catch { throw 'Node check did not return the expected JSON report. No retry was attempted.' }
  } finally { Pop-Location }
}

function Get-LocalOrigin {
  param([string]$Address)
  $uri = [Uri]$Address
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http','https') -or $uri.Host -notin @('localhost','127.0.0.1','[::1]','::1') -or $uri.UserInfo) {
    throw 'The manual acceptance workflow only supports local HTTP services.'
  }
  return "$($uri.Scheme)://loopback:$($uri.Port)"
}
$novaOrigin = Get-LocalOrigin ([string]$fixture.novaBase)
$proctorOrigin = Get-LocalOrigin $ProctoringUrl
$mediaStatusPath = Join-Path $webRoot ".local\reaction-media\$ExamId\status.json"
$startMediaCommand = ".\scripts\reaction-media.ps1 -ExamId '$($ExamId.Replace("'","''"))' -ExamNumber '$($ExamNumber.Replace("'","''"))' -Mode run -ProctoringUrl '$($ProctoringUrl.Replace("'","''"))'"
$readOnlyCode = @'
const imported = await import('./src/lib/db.ts');
const prisma = imported.prisma || imported.default?.prisma;
try {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: process.argv[1] }, select: {
    id: true, examCode: true, platform: true, platformContestId: true, platformBaseUrl: true,
    published: true, reactionEnabled: true, startAt: true, endAt: true,
    reactionConfig: { select: { bufferSeconds: true, beforeSeconds: true, afterSeconds: true, feedStatus: true, leaseUntil: true } },
    candidates: { where: { examNumber: process.argv[2] }, select: { id: true, examNumber: true } }
  } });
  console.log(JSON.stringify(exam));
} finally { await prisma.$disconnect(); }
'@

function Assert-MediaReady {
  if (-not (Test-Path -LiteralPath $mediaStatusPath)) {
    throw "Media status is missing. In another terminal at the repository root run: $startMediaCommand . Wait for READY and rolling cache cleanup; keep that terminal running."
  }
  $media = Get-Content -LiteralPath $mediaStatusPath -Raw | ConvertFrom-Json
  if ($media.status -ne 'READY') {
    throw "Media status is $($media.status). If the media terminal is already running, wait for READY; do not start another publisher. Otherwise run: $startMediaCommand"
  }
  if ($media.examId -cne $ExamId -or $media.examNumber -cne $ExamNumber -or [string]$media.contestId -cne [string]$fixture.contestId) {
    throw 'Media exam/team/contest does not match the requested existing fixture.'
  }
  if ((Get-LocalOrigin ([string]$media.base)) -ne $proctorOrigin) { throw 'Media uses a different proctoring service.' }
  $now = [DateTimeOffset]::UtcNow
  if (($now - [DateTimeOffset]::Parse($media.updatedAt)).TotalSeconds -gt 30 -or -not (Get-Process -Id ([int]$media.pid) -ErrorAction SilentlyContinue)) {
    throw "Media status is stale or its process ended. Check the other terminal; when no publisher remains, run: $startMediaCommand"
  }
  $exam = Invoke-NodeJson -WorkingDirectory $webRoot -Arguments @('--env-file=.env','--import','tsx','--input-type=module','--eval',$readOnlyCode,$ExamId,$ExamNumber)
  if ($exam.platform -ne 'NOVAJUDGE' -or -not $exam.published -or -not $exam.reactionEnabled -or [string]$exam.platformContestId -cne [string]$fixture.contestId) {
    throw 'The existing exam must be published, Reaction-enabled, and linked to the fixture contest. This script does not change it.'
  }
  if ((Get-LocalOrigin ([string]$exam.platformBaseUrl)) -ne $novaOrigin) { throw 'The existing exam points at a different NovaJudge service.' }
  if (@($exam.candidates).Count -ne 1 -or $exam.candidates[0].id -cne $media.candidateId) { throw 'Exact candidate-to-media mapping failed.' }
  if ($now -lt [DateTimeOffset]::Parse($exam.startAt) -or $now -ge [DateTimeOffset]::Parse($exam.endAt)) { throw 'The existing exam is outside its configured time window.' }
  $config = $exam.reactionConfig
  if (-not $config -or $config.feedStatus -ne 'CONNECTED' -or -not $config.leaseUntil -or [DateTimeOffset]::Parse($config.leaseUntil) -le $now) {
    throw 'Reaction Recorder / CCS Event Feed is not currently connected with an active lease. Start or inspect the existing recorder separately.'
  }
  if ([int]$media.cache.deletedSegments -lt 1) {
    throw "Rolling cache has not yet deleted expired segments. Keep the existing media terminal running for at least $([int]$config.bufferSeconds + 20) seconds; do not start a second publisher."
  }
  $requiredSpan = [Math]::Max([int]$config.beforeSeconds + 10, [int]$config.bufferSeconds - 15)
  foreach ($channel in @('DESKTOP_SCREEN','DESKTOP_CAMERA')) {
    $cache = @($media.cache.channels | Where-Object { $_.channel -eq $channel })
    $reader = @($media.readers | Where-Object { $_.channel -eq $channel })
    $publisher = @($media.media.channels | Where-Object { $_.channel -eq $channel })
    if ($cache.Count -ne 1 -or $reader.Count -ne 1 -or $publisher.Count -ne 1 -or $cache[0].count -lt 2 -or $reader[0].framesDecoded -le 5 -or $reader[0].width -le 16 -or $publisher[0].connectionState -ne 'connected') {
      throw "Both WHEP decoding and uploaded cache are required; $channel is not ready. Keep the existing media terminal running."
    }
    $first = [DateTimeOffset]::Parse($cache[0].oldestStartedAt)
    $last = [DateTimeOffset]::Parse($cache[0].newestEndedAt)
    if (($now - $last).TotalSeconds -gt 25 -or ($last - $first).TotalSeconds -lt $requiredSpan -or $first -gt $now.AddSeconds(-[int]$config.beforeSeconds)) {
      throw "The current $channel cache is stale or too short for the configured capture window. Wait for fresh uploads before submitting."
    }
  }
  if (@($media.media.errors).Count -gt 0) { throw 'The media publisher reports errors; fix them before submitting.' }
  return [ordered]@{ checkedAt=$now.ToString('o'); exam=$exam; status=$media }
}

$savedE2eUrl = $env:REACTION_E2E_URL
$savedAdminFixture = $env:REACTION_ADMIN_FIXTURE
$report = [ordered]@{ startedAt=[DateTimeOffset]::UtcNow.ToString('o'); examId=$ExamId; contestId=$fixture.contestId; team=$ExamNumber; checkOnly=[bool]$CheckOnly; mediaKind='SIMULATED_CANVAS_VIA_AUTHENTICATED_MEDIAMTX'; physicalClient='NOT_TESTED_BY_THIS_SCRIPT'; submissions=@(); passed=$false }
try {
  $mediaCheck = Assert-MediaReady
  $mediaCheck | ConvertTo-Json -Depth 16 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'media-preflight.json')
  $arguments = @($submitScript,'--nova-root',$NovaJudgeRoot,'--fixture',$PrivateFixturePath,'--runtime',$NovaRuntime,'--report-dir',$OutputDirectory)
  $preflight = Invoke-NodeJson -WorkingDirectory $repositoryRoot -Arguments ($arguments + @('--mode','check'))
  if ($preflight.submitted -or $preflight.proctoringBound -or $preflight.contestId -ne $fixture.contestId -or $preflight.team -cne $ExamNumber) { throw 'NovaJudge safe preflight failed.' }
  if ($CheckOnly) {
    $report.passed = $true
    Write-Host 'PASS: existing exam, live media, rolling cache, CCS Recorder, and ordinary team login. No submission or generation was requested.'
  } else {
    foreach ($verdict in @('AC','WA')) {
      $null = Assert-MediaReady
      $submitted = Invoke-NodeJson -WorkingDirectory $repositoryRoot -Arguments ($arguments + @('--mode',$verdict))
      if ($submitted.result -ne 'PASS' -or -not $submitted.submissionId -or $submitted.contestId -ne $fixture.contestId -or $submitted.team -cne $ExamNumber) {
        throw "$verdict submission verification failed. No automatic retry was attempted."
      }
      $report.submissions += $submitted
      Write-Host "PASS: real $verdict submission $($submitted.submissionId)."
    }
    $ids = ($report.submissions | ForEach-Object { $_.submissionId }) -join ','
    $env:REACTION_E2E_URL = $ProctoringUrl
    $env:REACTION_ADMIN_FIXTURE = $AdminFixturePath
    Push-Location $webRoot
    try {
      & node --env-file=.env --import tsx tests/reaction-existing-verify.ts $ExamId $ids $OutputDirectory
      if ($LASTEXITCODE -ne 0) { throw 'Reaction video verification failed. Inspect verification.json; existing services and media remain running.' }
    } finally { Pop-Location }
    $verification = Get-Content -LiteralPath (Join-Path $OutputDirectory 'verification.json') -Raw | ConvertFrom-Json
    if (-not $verification.passed) { throw 'Video verification did not report PASS.' }
    $report.passed = $true
    Write-Host "PASS: real AC/WA, raw clips, official vertical videos, FFprobe/full decode, and admin playback. Results: $OutputDirectory"
  }
} catch {
  $report.error = $_.Exception.Message
  throw
} finally {
  $env:REACTION_E2E_URL = $savedE2eUrl
  $env:REACTION_ADMIN_FIXTURE = $savedAdminFixture
  $report.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  $report | ConvertTo-Json -Depth 16 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $OutputDirectory 'manual-e2e.json')
}
