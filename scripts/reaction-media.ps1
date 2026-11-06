param(
  [Parameter(Mandatory=$true)] [string]$ExamId,
  [Parameter(Mandatory=$true)] [string]$ExamNumber,
  [ValidateSet('inspect','run','status','stop')] [string]$Mode = 'inspect',
  [string]$ProctoringUrl = 'http://localhost:4031',
  [ValidateRange(20,43200)] [int]$DurationSeconds = 3600
)
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $repositoryRoot 'apps\web'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $webRoot '.env'))) { throw 'The existing local proctoring .env is required.' }
$env:REACTION_MEDIA_EXAM_ID = $ExamId
$env:REACTION_MEDIA_EXAM_NUMBER = $ExamNumber
$env:REACTION_MEDIA_URL = $ProctoringUrl
$env:REACTION_MEDIA_DURATION_SECONDS = [string]$DurationSeconds
Push-Location $webRoot
try {
  & node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs tests/reaction-manual-media.ts $Mode
  if ($LASTEXITCODE -ne 0) { throw 'Manual media runner failed; inspect the credential-free status/error.' }
} finally { Pop-Location }
