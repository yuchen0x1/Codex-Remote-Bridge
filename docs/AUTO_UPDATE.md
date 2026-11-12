# 自动更新

Codex Remote Bridge 使用 GitHub Releases 作为公开更新源。发布工作流在 `vMAJOR.MINOR.PATCH` 标签上运行 Node 检查、测试和三端构建，然后生成两个元数据文件：

- `update-manifest.json`：版本、渠道、发布时间、更新说明链接，以及每个平台资产的文件名、大小、SHA-256 和 HTTPS 下载地址。
- `SHA256SUMS.txt`：所有发布资产的 SHA-256 清单。

## 客户端行为

- Windows WPF 启动后和“检查更新”按钮都会读取 manifest。只有 GitHub HTTPS 地址、更新版本、文件大小和 SHA-256 都通过检查后，才会启动安装程序。下载使用临时文件，失败时删除临时文件，旧版本不会先被删除。
- Android 在打开电脑端页面后先读取电脑服务的 `/codex/config`，再尝试读取 GitHub manifest。它只接受 GitHub HTTPS 资产，并保留现有的下载提示和外部安装流程。当前 Android 还没有把下载文件接管到应用临时目录做 SHA-256 校验，因此属于检查与跳转支持；安装仍由系统安装器完成。
- macOS 启动和手动检查时读取 GitHub manifest，显示可用版本并打开 PKG/DMG 下载地址。安装需要用户手动完成。
- 网络不可用、Release 不存在或清单不完整时，客户端继续使用当前版本。

## 签名状态

当前 manifest 会如实写入 `signatureStatus: "unsigned"`。仓库没有可验证的 Android keystore、Windows Authenticode 证书或 macOS Developer ID/notarization 凭据，因此不能声称数字签名已完成。

GitHub Actions 支持通过以下 Secrets 配置 Android Release 签名：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

缺少这些 Secrets 时，Android 构建仍会生成 APK，但发布必须视为未签名，不能用于覆盖已有签名的安装。

Windows 代码签名和 macOS Developer ID 签名/notarization 需要分别在 CI 中加入受保护的证书和公证凭据。私钥不能提交到仓库，也不能写入 manifest 或日志。

## 发布新版本

1. 在 `main` 上更新 `package.json`、Android `versionName`、Windows 和 macOS 的版本元数据。
2. 运行 `npm run check`、`npm test` 和 `git diff --check`。
3. 创建与 `package.json` 完全一致的标签，例如 `v4.2.0`，并推送到 GitHub：

   ```powershell
   git tag v4.2.0
   git push origin v4.2.0
   ```

4. Actions 会在创建 Release 前验证标签版本、运行测试，并要求 Android、Windows、macOS 三个平台都产出资产。已有同名 Release 不应被覆盖；需要修复后使用新的版本标签。

## 本地验证 manifest

```powershell
New-Item -ItemType Directory -Force .tmp-release-assets | Out-Null
Copy-Item dist\android\*.apk .tmp-release-assets\
Copy-Item dist\windows\installer\*.exe .tmp-release-assets\
node scripts/release-manifest.js --assets-dir .tmp-release-assets --version 4.2.0 --tag v4.2.0 --repository yuchen0x1/Codex-Remote-Bridge
Get-Content .tmp-release-assets\update-manifest.json
```

不要把 `.tmp-release-assets` 或任何签名私钥提交到 Git。

## 已知限制

- 当前项目没有真实签名凭据；清单的 SHA-256 能检测传输损坏，但不能替代代码签名。
- 本机没有 .NET 8、JDK 17、Android SDK、Xcode 和 macOS 构建环境，因此三端构建应以 GitHub Actions 结果为准。
- Windows 安装器由用户确认后启动；Android 和 macOS 不执行静默安装。
- GitHub Release、Secrets、签名证书和商店权限属于外部资源，未配置前不能标记为正式发布完成。
