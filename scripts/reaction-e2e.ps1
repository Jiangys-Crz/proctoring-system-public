param(
  [ValidateSet('full','fixture','publish','edge')] [string]$Mode = 'full',
  [Parameter(Mandatory=$true)] [string]$NovaJudgeRoot,
  [Parameter(Mandatory=$true)] [string]$NovaJudgeRuntimeEnv,
  [string]$OutputDirectory = '',
  [string]$ProctoringUrl = 'http://localhost:4031'
)
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $repositoryRoot 'apps\web'
foreach ($toolName in @('node','ffmpeg','ffprobe')) {
  if (-not (Get-Command $toolName -ErrorAction SilentlyContinue)) { throw "Missing required tool: $toolName" }
}
$novaFixture = Join-Path $NovaJudgeRoot '.local\reaction-e2e\fixture.private.json'
& (Join-Path $PSScriptRoot 'reaction-novajudge-setup.ps1') -NovaJudgeRoot $NovaJudgeRoot -RuntimeEnvFile $NovaJudgeRuntimeEnv
if (-not (Test-Path -LiteralPath $novaFixture)) { throw 'Dedicated NovaJudge fixture initialization failed.' }
if (-not (Test-Path -LiteralPath (Join-Path $webRoot '.env'))) { throw 'Create the local proctoring .env before running this test.' }
$env:NOVAJUDGE_E2E_FIXTURE = $novaFixture
$env:REACTION_E2E_URL = $ProctoringUrl
if ($OutputDirectory) { $env:REACTION_E2E_OUTPUT = [System.IO.Path]::GetFullPath($OutputDirectory) }
Push-Location $webRoot
try {
  & node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs tests/reaction-e2e.ts $Mode
  if ($LASTEXITCODE -ne 0) { throw "Reaction E2E failed (exit $LASTEXITCODE); inspect the saved report.json." }
} finally { Pop-Location }
