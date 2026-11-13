param(
  [string]$OutputDir = ""
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$androidProject = Join-Path $repoRoot 'android\CodexMax'
$signingDir = Join-Path $androidProject 'signing'
  $keystorePath = Join-Path $signingDir 'codex-remote-bridge-release.p12'
$propertiesPath = Join-Path $androidProject 'release-signing.properties'

function Get-KeytoolPath {
  $command = Get-Command keytool.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $java = Get-Command java.exe -ErrorAction SilentlyContinue
  if ($java) {
    $candidate = Join-Path (Split-Path -Parent $java.Source) 'keytool.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  $temurinRoot = Join-Path $env:LOCALAPPDATA 'Programs\Temurin-*\jdk-*\bin\keytool.exe'
  $candidate = Get-ChildItem -Path $temurinRoot -File -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($candidate) { return $candidate.FullName }
  throw 'JDK keytool.exe was not found. Install JDK 17 or newer before building the Android release.'
}

if (-not $OutputDir) {
  $OutputDir = Join-Path $repoRoot 'dist\android'
}

if (-not (Test-Path -LiteralPath $propertiesPath)) {
  New-Item -ItemType Directory -Force -Path $signingDir | Out-Null
  $keytool = Get-KeytoolPath
  $passwordBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
  $password = [Convert]::ToBase64String($passwordBytes).TrimEnd('=').Replace('+', 'A').Replace('/', 'B')
  & $keytool -genkeypair -v -keystore $keystorePath -storetype PKCS12 -alias codex-remote-bridge-release -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=Codex Remote Bridge, OU=Local Release, O=Codex Remote Bridge, L=Local, S=Local, C=CN' -storepass $password -keypass $password
  if ($LASTEXITCODE -ne 0) { throw "keytool failed with exit code $LASTEXITCODE" }
  @(
    'storeFile=signing/codex-remote-bridge-release.p12'
    "storePassword=$password"
    'keyAlias=codex-remote-bridge-release'
    "keyPassword=$password"
  ) | Set-Content -LiteralPath $propertiesPath -Encoding ASCII
}

$outputRoot = if ($env:CODEX_MAX_ANDROID_BUILD_DIR) { $env:CODEX_MAX_ANDROID_BUILD_DIR } else { Join-Path $repoRoot 'output\android-release' }
$previousOutputRoot = $env:CODEX_MAX_ANDROID_BUILD_DIR
$env:CODEX_MAX_ANDROID_BUILD_DIR = $outputRoot
try {
  Push-Location $androidProject
  & .\gradlew.bat clean assembleRelease lintRelease
  if ($LASTEXITCODE -ne 0) { throw "Android release build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
  $env:CODEX_MAX_ANDROID_BUILD_DIR = $previousOutputRoot
}

$apkPath = Join-Path $outputRoot 'outputs\apk\release\app-release.apk'
if (-not (Test-Path -LiteralPath $apkPath)) { throw "Android release APK was not produced: $apkPath" }

$sdkDirLine = Get-Content (Join-Path $androidProject 'local.properties') | Where-Object { $_ -match '^sdk\.dir=' } | Select-Object -First 1
if (-not $sdkDirLine) { throw 'Android SDK path was not found in android/CodexMax/local.properties.' }
$sdkDir = ($sdkDirLine -replace '^sdk\.dir=', '').Replace('\:', ':').Replace('\\', '\')
$buildTools = Get-ChildItem (Join-Path $sdkDir 'build-tools') -Directory | Sort-Object { [Version]$_.Name } -Descending | Select-Object -First 1
if (-not $buildTools) { throw 'Android SDK build-tools were not found.' }
& (Join-Path $buildTools.FullName 'apksigner.bat') verify --verbose $apkPath
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
& (Join-Path $buildTools.FullName 'zipalign.exe') -c -p -v 4 $apkPath
if ($LASTEXITCODE -ne 0) { throw 'APK alignment verification failed.' }

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$versionLine = Select-String -LiteralPath (Join-Path $androidProject 'app\build.gradle.kts') -Pattern '^\s*versionName\s*=\s*"([^"]+)"' | Select-Object -First 1
if (-not $versionLine -or -not $versionLine.Matches[0].Groups[1].Value) { throw 'Android versionName was not found.' }
$versionName = $versionLine.Matches[0].Groups[1].Value
$releaseApk = Join-Path $OutputDir "ChatGPT-AZ-Android-v$versionName.apk"
$checksumFile = "$releaseApk.sha256"
$releaseZip = Join-Path $OutputDir "ChatGPT-AZ-Android-v$versionName.zip"
Copy-Item -LiteralPath $apkPath -Destination $releaseApk -Force
$hash = (Get-FileHash -LiteralPath $releaseApk -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  ChatGPT-AZ-Android-v$versionName.apk" | Set-Content -LiteralPath $checksumFile -Encoding ASCII
Compress-Archive -LiteralPath $releaseApk, $checksumFile -DestinationPath $releaseZip -Force
Write-Host "Android release APK: $releaseApk"
Write-Host "Android release ZIP: $releaseZip"
Write-Host "SHA-256: $hash"
