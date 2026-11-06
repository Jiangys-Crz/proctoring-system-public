param(
  [string]$Python = 'python',
  [string]$InstallDirectory = (Join-Path $PSScriptRoot '../tmp/reaction-generator-runtime')
)
$ErrorActionPreference = 'Stop'
$upstreamCommit = '59fd21d50e8bf4c69bd6e4b5c19a60726f30a20b'
$installRoot = [IO.Path]::GetFullPath($InstallDirectory)
$source = Join-Path $installRoot 'reactions-generator'
$environmentPath = Join-Path $installRoot 'venv'
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
foreach ($tool in @('git', 'ffmpeg', 'ffprobe', $Python)) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required executable unavailable: $tool" }
}
if (-not (Test-Path -LiteralPath $source)) {
  & git clone 'https://github.com/icpc/reactions-generator.git' $source
  if ($LASTEXITCODE -ne 0) { throw 'Unable to clone official generator' }
  & git -C $source checkout --detach $upstreamCommit
  if ($LASTEXITCODE -ne 0) { throw 'Unable to select tested generator version' }
} else {
  $revision = (& git -C $source rev-parse HEAD).Trim()
  if ($revision -ne $upstreamCommit) { throw 'Existing generator has a different revision; select a new InstallDirectory to preserve it.' }
  $changed = & git -C $source status --porcelain
  if ($changed) { throw 'Existing generator has local changes; select a new InstallDirectory to preserve them.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $environmentPath 'Scripts/python.exe'))) {
  & $Python -m venv $environmentPath
  if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 or newer is required' }
}
$runtimePython = Join-Path $environmentPath 'Scripts/python.exe'
& $runtimePython -m pip install $source 'typed-ffmpeg==3.11' 'typer==0.20.1'
if ($LASTEXITCODE -ne 0) { throw 'Generator dependency installation failed' }
Write-Output 'Add these non-secret paths to apps/web/.env, then restart the Reaction worker:'
Write-Output ('REACTION_GENERATOR_ROOT="' + $source.Replace('\', '/') + '"')
Write-Output ('REACTION_GENERATOR_PYTHON="' + $runtimePython.Replace('\', '/') + '"')
