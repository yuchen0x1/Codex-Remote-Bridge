# 自动更新

> **永久归档**：v4.2.0 为最终版本，更新检查只保留用于获取已发布版本。下文发布流程供分叉项目和历史复现参考，原仓库不再发布后续更新。

Codex Remote Bridge 使用 GitHub Releases 作为公开更新源。发布工作流在 `vMAJOR.MINOR.PATCH` 标签上运行 Node 检查、测试和三端构建，然后生成两个元数据文件：

- `update-manifest.json`：版本、渠道、发布时间、更新说明链接，以及每个平台资产的文件名、大小、SHA-256 和 HTTPS 下载地址。
- `SHA256SUMS.txt`：所有发布资产的 SHA-256 清单。

## 客户端行为

- Windows WPF 启动后和“检查更新”按钮都会读取 manifest。只有 GitHub HTTPS 地址、更新版本、文件大小和 SHA-256 都通过检查后，才会启动安装程序。下载使用临时文件，失败时删除临时文件，旧版本不会先被删除。
- Android 在打开电脑端页面后先读取电脑服务的 `/codex/config`，再尝试读取 GitHub manifest。它只接受 GitHub HTTPS 资产，并保留现有的下载提示和外部安装流程。当前 Android 还没有把下载文件接管到应用临时目录做 SHA-256 校验，因此属于检查与跳转支持；安装仍由系统安装器完成。
- macOS 启动和手动检查时读取 GitHub manifest，显示可用版本并打开 PKG/DMG 下载地址。安装需要用户手动完成。
- 网络不可用、Release 不存在或清单不完整时，客户端继续使用当前版本。

## 签名状态

当前 manifest 会如实写入 `signatureStatus: "unsigned"`，指清单本身未签名。v4.2.0 的 Android 包使用本地保管的 Release keystore 签名；Windows Authenticode 与 macOS Developer ID/notarization 尚未配置。APK 签名不等于清单签名，也不保证与历史 APK 的证书相同。

GitHub Actions 支持通过以下 Secrets 配置 Android Release 签名：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

缺少这些 Secrets 时，CI 只生成未签名 APK，并创建草稿 Release。发布者必须用受保护的本地 Release 密钥签名或替换为本地同源签名构建，验证 APK 签名后重新生成清单/校验和，再公开 Release。不能直接发布不可安装的未签名 APK。

Windows 代码签名和 macOS Developer ID 签名/notarization 需要分别在 CI 中加入受保护的证书和公证凭据。私钥不能提交到仓库，也不能写入 manifest 或日志。

## 发布新版本

1. 在 `main` 上更新 `package.json`、Android `versionName`、Windows 和 macOS 的版本元数据。
2. 运行 `npm run check`、`npm test` 和 `git diff --check`。
3. 创建与 `package.json` 完全一致的标签，例如 `v4.2.0`，并推送到 GitHub：

   ```powershell
   git tag v4.2.0
   git push origin v4.2.0
   ```

4. 为新版本添加 `docs/releases/vMAJOR.MINOR.PATCH.md`。Actions 验证四端版本、运行测试，并要求 Android、Windows、macOS 都产出资产后创建草稿 Release。
5. 下载草稿资产，核对版本、内容和签名；如 Android 在本地补签，更新 APK、`SHA256SUMS.txt` 和 `update-manifest.json`，全部校验后公开草稿。已公开的同名 Release 不覆盖；修复使用新的版本标签。

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
- 本地 Windows 可构建 Windows/Android；macOS 由 GitHub Actions 的 macOS runner 构建，真机安装仍需另行验收。
- Windows 安装器由用户确认后启动；Android 和 macOS 不执行静默安装。
- GitHub Release、Secrets、签名证书和商店权限属于外部资源，未配置前不能标记为正式发布完成。
