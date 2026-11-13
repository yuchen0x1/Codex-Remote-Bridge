# Building from source

> v4.2.0 is the final release. This guide is retained for independent builds after permanent archival; no further maintenance is provided.

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

With `CODEX_MAX_ANDROID_BUILD_DIR` set as above, the debug APK is at
`C:\android-build-out\outputs\apk\debug\app-debug.apk`. Without that override, it is at
`android/CodexMax/app/build/outputs/apk/debug/app-debug.apk`.

For a signed release APK, run `scripts/build-codex-max-android.ps1` from the repository root.
Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` to your SDK (or use `local.properties`). The script
creates a local Release key on its first run, verifies the APK signature and alignment,
and writes `dist/android/ChatGPT-AZ-Android-v4.2.0.apk`. Back up the ignored
`android/CodexMax/signing/` directory and `release-signing.properties` together;
do not commit or upload either. Reuse the same key for compatible independent builds.

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

### macOS
The macOS Xcode project is at `macos/CodexMini/`.
It requires Xcode 15+ and shares the same Node.js service files.

```sh
bash scripts/build-codex-mini-installer.sh
# Output: dist/Codex Remote Bridge Installer.pkg
```

The final GitHub build uses the Apple Silicon `macos-15` runner and bundles its arm64 Node runtime.
The distributed macOS package targets Apple Silicon; Intel users need their own native build.

> **Note**: `macos/CodexMini/CodexMini/Resources/CodexMiniProject/` is a build-time
> generated copy of the Node service, refreshed by `scripts/build-codex-mini-app.sh`
> via rsync before `xcodebuild` runs. It is **not** source and is git-ignored — do not
> edit or commit it manually; always build through the script.

## Running without building
```powershell
# Start the HTTPS service directly (self-signed local certificate)
node server.js
# Open https://localhost:8787/?token=<TOKEN> on this computer; use its LAN IP on mobile.
# Explicit plaintext development mode: npm run start:http
```
