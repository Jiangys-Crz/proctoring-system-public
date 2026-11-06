param(
  [Parameter(Mandatory=$true)] [string]$NovaJudgeRoot,
  [Parameter(Mandatory=$true)] [string]$RuntimeEnvFile
)
$ErrorActionPreference = 'Stop'
$NovaJudgeRoot = [IO.Path]::GetFullPath($NovaJudgeRoot)
$RuntimeEnvFile = [IO.Path]::GetFullPath($RuntimeEnvFile)
if (-not (Test-Path -LiteralPath (Join-Path $NovaJudgeRoot 'package.json')) -or -not (Test-Path -LiteralPath $RuntimeEnvFile)) {
  throw 'Pass an existing NovaJudge test checkout and an explicit private runtime env file.'
}
$fixtureRoot = Join-Path $NovaJudgeRoot '.local/reaction-e2e'
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
foreach ($entry in @(@('reaction-novajudge-helper.ts.template','helper.ts'), @('reaction-novajudge-start.mjs.template','start.mjs'), @('reaction-novajudge-setup.mjs.template','setup.mjs'), @('reaction-novajudge-run.mjs.template','run.mjs'))) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $entry[0]) -Destination (Join-Path $fixtureRoot $entry[1])
}
Push-Location $NovaJudgeRoot
try {
  if (-not (Test-Path -LiteralPath 'node_modules/tsx/dist/cli.mjs')) {
    throw 'Install NovaJudge dependencies with npm ci --ignore-scripts first; the default postinstall can modify its database.'
  }
  $configuration = & node .local/reaction-e2e/setup.mjs $RuntimeEnvFile
  if ($LASTEXITCODE -ne 0) { throw 'Isolated runtime configuration rejected.' }
  $runtime = ($configuration -join "`n") | ConvertFrom-Json
  $port = [int]$runtime.port
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  $webRunning = $false
  $webPidFile = Join-Path $fixtureRoot 'web.pid'
  if ($listeners.Count -and (Test-Path -LiteralPath $webPidFile)) {
    $webPid = [int](Get-Content -LiteralPath $webPidFile -Raw)
    $webProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$webPid" -ErrorAction SilentlyContinue
    $children = @(Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq $webPid)
    $webRunning = [bool]($webProcess -and $webProcess.CommandLine -match [regex]::Escape($NovaJudgeRoot) -and $webProcess.CommandLine -match 'next' -and
      @($listeners.OwningProcess | Where-Object { $_ -eq $webPid -or $_ -in $children.ProcessId }).Count)
  }
  if ($listeners.Count -and -not $webRunning) { throw "Port $port belongs to another service. Select a free test NOVAJUDGE_URL; no process was stopped." }
  # Provision services and the dedicated test database explicitly beforehand.
  # This script never selects an original container, database or .env.
  & node .local/reaction-e2e/run.mjs node_modules/prisma/build/index.js db push
  if ($LASTEXITCODE -ne 0) { throw 'Dedicated test schema setup failed. Existing databases were not selected.' }
  & node .local/reaction-e2e/run.mjs node_modules/prisma/build/index.js generate
  if ($LASTEXITCODE -ne 0) { throw 'Prisma generation failed.' }
  & node .local/reaction-e2e/run.mjs node_modules/tsx/dist/cli.mjs .local/reaction-e2e/helper.ts init
  if ($LASTEXITCODE -ne 0) { throw 'Isolated contest fixture setup failed.' }
  if (-not $webRunning) { & node .local/reaction-e2e/start.mjs web; if ($LASTEXITCODE -ne 0) { throw 'Cannot start isolated NovaJudge web.' } }
  $workerRunning = $false
  $workerPidFile = Join-Path $fixtureRoot 'worker.pid'
  if (Test-Path -LiteralPath $workerPidFile) {
    $workerPid = [int](Get-Content -LiteralPath $workerPidFile -Raw)
    $worker = Get-CimInstance Win32_Process -Filter "ProcessId=$workerPid" -ErrorAction SilentlyContinue
    $workerRunning = [bool]($worker -and $worker.CommandLine -match [regex]::Escape($NovaJudgeRoot) -and $worker.CommandLine -match 'worker.ts.*reaction-e2e')
  }
  if (-not $workerRunning) { & node .local/reaction-e2e/start.mjs worker; if ($LASTEXITCODE -ne 0) { throw 'Cannot start isolated NovaJudge worker.' } }
  $ready = $false
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try { $response = Invoke-WebRequest -Uri $runtime.base -TimeoutSec 3; if ($response.StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { throw 'Test NovaJudge HTTP unavailable; inspect its private .local/reaction-e2e logs.' }
  Write-Output "Isolated NovaJudge test service ready: $($runtime.base)"
} finally { Pop-Location }
