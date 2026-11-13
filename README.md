# Codex Remote Bridge（Codex 远程控制桥接）

把手机变成 Windows 电脑上 Codex Desktop 的"遥控器"——局域网直连、全程本地运行，聊天数据不出你自己的网络。

[![Stars](https://img.shields.io/github/stars/yuchen0x1/Codex-Remote-Bridge?style=flat-square&color=8ef0b7)](https://github.com/yuchen0x1/Codex-Remote-Bridge/stargazers)
[![Forks](https://img.shields.io/github/forks/yuchen0x1/Codex-Remote-Bridge?style=flat-square)](https://github.com/yuchen0x1/Codex-Remote-Bridge/forks)
[![Last commit](https://img.shields.io/github/last-commit/yuchen0x1/Codex-Remote-Bridge?style=flat-square)](https://github.com/yuchen0x1/Codex-Remote-Bridge/commits/main)
[![License](https://img.shields.io/github/license/yuchen0x1/Codex-Remote-Bridge?style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Android-4a5568?style=flat-square)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-8ef0b7?style=flat-square)

- 仓库地址：[GitHub](https://github.com/yuchen0x1/Codex-Remote-Bridge) ｜ [Gitee 镜像](https://gitee.com/yuchen0x1/Codex-Remote-Bridge)
- 适用平台：Windows 电脑 + 手机（浏览器或 Android App）

<a href="https://github.com/yuchen0x1/Codex-Remote-Bridge/stargazers">
  <img src="docs/star-history.svg" alt="Star 增长图" width="860">
</a>

> 图表由 `.github/workflows/star-history.yml` 每天自动拉取 stargazers 生成，随仓库一起提交，不依赖第三方图床。
> 本地重绘：`npm run star-history`（无网络时用 `npm run star-history:offline`）。

## 一、它能帮你解决什么

Codex 正在电脑上跑任务，人却不得不守在工位前盯屏幕？Codex Remote Bridge 就是为这个场景准备的。

它是一个"手机 ↔ 电脑"远程控制桥接工具：手机通过网页或 Android App 连接同一局域网内的 Windows 电脑，把文字或图片发送到电脑上正在运行的 Codex 对话中，并实时同步查看回复过程、运行状态和工具调用结果。

需要特别说明的是：它不是云端聊天服务。Codex 的登录状态、线程切换、输入和回复读取，全部发生在你自己的电脑上。

## 二、能力清单

**手机上可以**

1. 扫描电脑端二维码，或手动粘贴带 token 的局域网地址，一键连接
2. 查看任务列表、聊天记录、模型和推理等级
3. 发送文字与图片附件，支持停止响应、新建线程、归档、重命名、压缩上下文
4. 任务完成或失败时收到系统通知

**电脑端（Windows）提供**

1. WPF 管理面板：服务状态、端口、线程数、二维码入口、日志与启停控制
2. 自动启动隐藏的 Node 本地服务，支持开机自启与健康检查
3. 优先通过 Chrome DevTools Protocol（CDP）无感控制 Codex；不可用时回退 GUI / 剪贴板自动化
4. 内置 token 鉴权、会话限流、访问令牌轮换和附件大小限制
5. Web「设置 → 配置 → 已连接设备」查看会话权限、最近访问和到期时间，撤销其他设备的会话

**安全与隐私底线**

- 远程控制默认用于手机与电脑局域网直连，桥接不提供云中继。更新检查会访问 GitHub；启用 Webhook 后会向指定接收地址发送事件。Codex 自身的模型请求遵循其配置
- 连接链接自带随机 token，支持一键轮换，旧 token 立即失效
- 桥接状态保存任务配置、提示词库和执行日志；图片附件会暂存在本机。会话凭据仅在服务内存保存，不向设备列表返回

## 最新更新

### v4.2.0 · 2026-11-13

新设备配对默认只读，可在「设置 → 配置」查看和撤销设备会话。令牌轮换会让旧连接失效；正常浏览器轮询、配对二维码与定时任务失败重试更加可靠。Windows 可检查并校验新安装包，Android/macOS 提供更新下载入口。

曾分享旧格式只读链接的用户应轮换主令牌并重新配对。Android 使用本地 Release 密钥签名，Windows/macOS 尚无平台发行签名；更新清单的 SHA-256 不替代签名。完整变化见 [发布说明](docs/releases/release-notes.md)，操作说明见 [设备与权限说明](docs/DEVICE_SECURITY.md)。

## 三、技术构成

- 电脑端：Node.js 本地服务 + WPF 管理面板
- 手机端：响应式 Web 页面 + Android 原生 App
- 控制层：Chrome DevTools Protocol（CDP）为主，GUI / 剪贴板自动化兜底

本项目基于 CoimgRain 的开源项目 Codex-Mini 的本地桥接思路，重写了 Windows 自动化控制层，并新增 Android 原生客户端，在此致谢。

## 四、快速上手

开始前请确认两件事：电脑上已安装并登录 Codex Desktop；手机与电脑处于同一 Wi-Fi / 局域网。

### 第 1 步：获取代码

```powershell
git clone https://gitee.com/yuchen0x1/Codex-Remote-Bridge.git
```

### 第 2 步：运行本地服务（推荐，最简单）

```powershell
node server.js
```

默认以 **HTTPS（自签名证书）** 启动，保护局域网内的访问令牌与聊天消息；手机首次访问需接受证书警告。终端会打印局域网入口，用手机浏览器打开即可。

如需自定义 token，先设置环境变量再启动：

```powershell
$env:MOBILE_TYPER_TOKEN = "your-token"
node server.js
```

如确需回退到明文 HTTP（仅限可信局域网），可显式关闭 HTTPS：

```powershell
$env:CODEX_MAX_HTTP_ONLY = "1"
node server.js
```

### 第 3 步：手机连接

电脑端 WPF 面板提供二维码入口，扫码即连；也可以在手机端手动粘贴带 token 的局域网地址直连。

Web 页面「配对二维码」默认授予新设备**只读权限**，需要遥控电脑时选择「读写」。配对码 90 秒有效且只能兑换一次。已连接设备可在「设置 → 配置」管理会话。升级前若曾分享过旧格式 `主令牌:ro`，请在电脑端轮换主令牌并重新配对，因为旧链接已经包含主令牌。

`npm run start:http` 可在 PowerShell、cmd 和 POSIX shell 使用；它显式启用明文 HTTP，仅用于可信测试环境。指定 `CODEX_MAX_STATE_DIR` 时，队列、执行日志和 TLS 证书也会存放到该目录；切换目录不会自动迁移旧数据。

在「电脑状态」面板里还可使用**剪贴板同步**：从手机读取电脑剪贴板文本，或把手机上的文字写入电脑剪贴板（便于复制粘贴）。

### Webhook 验签

在手机端「设置 → 配置」中配置 Webhook。首次保存地址或轮换密钥时，签名密钥只在当前页面显示一次，请立即保存。

每个 Webhook 请求都带有以下请求头：

- `X-Codex-Webhook-Timestamp`：Unix 秒级时间戳
- `X-Codex-Webhook-Event`：事件名，例如 `send.completed` 或 `send.failed`
- `X-Codex-Webhook-Signature`：`sha256=` 加十六进制 HMAC 值

签名原文为 `timestamp + "." + 原始请求体`，算法为 `HMAC-SHA256`。接收方应限制时间戳有效期并使用常量时间比较，防止重放和时序攻击。

### 进阶：打包构建

**构建 Windows 单文件 exe / 安装包**

```powershell
.\scripts\build-codex-max-windows-single-exe.ps1
```

构建产物：

- `dist\windows\Codex Remote Bridge SingleExe\Codex Remote Bridge.exe`
- `dist\windows\installer\Codex-Remote-Bridge-Windows-Setup.exe`

**构建 Android App**

Android 工程位于 `android/CodexMax`（最低支持 Android 6.0 / API 23），构建环境需要 JDK 17 与 Android SDK 35，构建后输出 `dist\android\ChatGPT-AZ-Android-v4.2.0.apk`。

## 五、常见疑问

**需要设置密码吗？**
不需要固定密码。连接使用随机 token 鉴权，支持一键轮换。

**流量会经过第三方服务器吗？**
手机与电脑的桥接控制流量不经过云中继。更新检查会访问 GitHub；Webhook 会联系你配置的接收服务，Codex 自身的模型请求也不属于桥接局域网流量。

**构建脚本有什么要注意的？**
首次运行会生成并保存 Release 签名私钥（不会提交到 Git）；后续升级必须使用同一工作目录。

## 六、反馈与交流

- QQ 交流群：`1016190748`
- Telegram：https://t.me/lenmoC

反馈问题时，请说明你使用的版本、运行平台和具体现象，并备注参考项目 Codex-Mini 及原作者 CoimgRain。

如果这个项目对你有帮助，欢迎在 Gitee 上点一个 Star。
