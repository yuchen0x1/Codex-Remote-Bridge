param(
  [string]$NodePath = "",
  [string]$InnoCompiler = "",
  [switch]$SelfContained,
  [switch]$FrameworkDependent
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$payloadDir = Join-Path $repoRoot 'dist\windows\Codex Remote Bridge InstallerPayload'
$installerDir = Join-Path $repoRoot 'dist\windows\installer'

$buildArgs = @{
  OutputDir = $payloadDir
  NodePath = $NodePath
}
if ($FrameworkDependent) {
  & (Join-Path $repoRoot 'scripts\build-codex-max-windows.ps1') @buildArgs
} else {
  # An installer must run on a clean Windows installation without requiring .NET.
  & (Join-Path $repoRoot 'scripts\build-codex-max-windows.ps1') @buildArgs -SelfContained
}

if (-not $InnoCompiler) {
  $cmd = Get-Command iscc.exe -ErrorAction SilentlyContinue
  if ($cmd) { $InnoCompiler = $cmd.Source }
}
if (-not $InnoCompiler) {
  foreach ($candidate in @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      $InnoCompiler = $candidate
      break
    }
  }
}

if (-not $InnoCompiler -or -not (Test-Path -LiteralPath $InnoCompiler)) {
  Write-Host "Windows payload output: $payloadDir"
  throw 'Inno Setup 6 compiler (ISCC.exe) was not found. Install Inno Setup 6, then rerun this script to produce the setup exe.'
}

New-Item -ItemType Directory -Force -Path $installerDir | Out-Null
$releaseVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
& $InnoCompiler "/DMyAppVersion=$releaseVersion" (Join-Path $repoRoot 'windows\installer\CodexMini.iss')
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup failed with exit code $LASTEXITCODE"
}

Write-Host "Windows installer output: $installerDir"
