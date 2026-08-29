# Building from source

## Prerequisites

### Windows
- **Node.js** 20+ (`node --version`)
- **.NET 8 SDK** (`dotnet --list-sdks`) — only needed for Windows desktop app
- **Inno Setup 6** (`ISCC.exe`) — only needed for Windows installer
- **JDK 17+** — only needed for Android APK
- **Android SDK 35** — only needed for Android APK

### Android APK
The Android project is at `android/CodexMax/`.

```powershell
# Set these environment variables before building to avoid
# issues with non-ASCII paths (required if your Windows
# username contains Chinese characters):
$env:CODEX_MAX_ANDROID_BUILD_DIR = 'C:\android-build-out'
$env:GRADLE_USER_HOME = 'C:\gradle-cache'

# Build debug APK
cd android/CodexMax
.\gradlew.bat assembleDebug

# Build + run unit tests
.\gradlew.bat testDebugUnitTest

# Full check
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug
```

The output APK will be at:
`android/CodexMax/app/build/outputs/apk/debug/app-debug.apk`

### Windows desktop app
```powershell
# Single-file portable exe
.\scripts\build-codex-max-windows-single-exe.ps1
# Output: dist\windows\Codex Remote Bridge SingleExe\Codex Remote Bridge.exe

# Framework-dependent portable
.\scripts\build-codex-max-windows-portable.ps1
# Output: dist\windows\Codex Remote Bridge\Codex Remote Bridge.exe

# Full installer (requires Inno Setup 6)
.\scripts\build-codex-max-windows-installer.ps1
# Output: dist\windows\installer\Codex-Remote-Bridge-Windows-Setup.exe
```

### macOS (upstream)
The macOS Xcode project is at `macos/CodexMini/`.
It requires Xcode 15+ and shares the same Node.js service files.

> **Note**: `macos/CodexMini/CodexMini/Resources/CodexMiniProject/` is a build-time
> generated copy of the Node service, refreshed by `scripts/build-codex-mini-app.sh`
> via rsync before `xcodebuild` runs. It is **not** source and is git-ignored — do not
> edit or commit it manually; always build through the script.

## Running without building
```powershell
# Start the HTTP service directly
node server.js
# Open http://localhost:8787/?token=<TOKEN> in browser or mobile
```
