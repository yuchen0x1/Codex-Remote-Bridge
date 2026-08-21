<div align="center">

# Codex Remote Bridge

> 在手机上远程操控 Windows 上的 Codex Desktop，全程局域网直连、本地运行

</div>

## 📖 项目简介

Codex Remote Bridge 是一个开源的「手机 ↔ 电脑」远程控制桥接工具：手机通过网页或 Android App 连接同一局域网内的 Windows 电脑，把文字或图片发送到电脑上正在运行的 Codex 对话中，并实时同步查看回复过程、运行状态和工具调用结果。

它不是云端聊天服务：Codex 的登录状态、线程切换、输入和回复读取全部发生在你自己的电脑上。

## 🔗 参考项目

本项目基于 [CoimgRain/Codex-Mini](https://github.com/CoimgRain/Codex-Mini) 的本地桥接思路，重写了 Windows 自动化控制层，并新增 Android 原生客户端。

## 🎯 功能特性

**手机端**

- 扫描电脑端二维码或手动粘贴带 token 的局域网地址，一键连接
- 查看任务列表、聊天记录、模型和推理等级
- 发送文字、图片附件，支持停止响应、新建线程、归档、重命名、压缩上下文
- 任务完成或失败时发送系统通知

**电脑端（Windows）**

- WPF 管理面板：服务状态、端口、线程数、二维码入口、日志与启停控制
- 自动启动隐藏的 Node 本地服务，支持开机自启与健康检查
- 优先通过 Chrome DevTools Protocol（CDP）无感控制 Codex；不可用时回退 GUI / 剪贴板自动化
- 内置 token 鉴权、API 限流、访问令牌轮换和附件大小限制

**安全与隐私**

- 所有请求只在手机与电脑的局域网内传输，不经过任何第三方服务器
- 连接链接自带随机 token，支持一键轮换，旧 token 立即失效
- 不保存聊天正文或图片内容

## 🧱 技术栈

| 模块 | 技术 |
| --- | --- |
| 电脑端 | Node.js 本地服务 + WPF 管理面板 |
| 手机端 | Web（响应式）+ Android 原生 App |
| 控制层 | Chrome DevTools Protocol（CDP）+ GUI/剪贴板回退 |

## 🚀 快速开始

### 方式一：直接运行源码服务（最简单）

电脑上需要已安装并登录 Codex Desktop，手机与电脑在同一 Wi-Fi / 局域网。

```powershell
node server.js
```

终端会打印局域网入口，用手机浏览器打开即可。也可以先设置自定义 token：

```powershell
$env:MOBILE_TYPER_TOKEN = "your-token"
node server.js
```

### 方式二：构建 Windows 单文件 exe / 安装包

```powershell
.\scripts\build-codex-max-windows-single-exe.ps1
```

构建产物：`dist\windows\Codex Remote Bridge SingleExe\Codex Remote Bridge.exe`、`dist\windows\installer\Codex-Remote-Bridge-Windows-Setup.exe`。

### 方式三：构建 Android App

Android 工程位于 `android/CodexMax`（最低 Android 6.0 / API 23），构建环境需要 JDK 17 和 Android SDK 35。构建后输出 `dist\android\ChatGPT-AZ-Android-v1.2.7.apk`。

## ⚙️ 默认配置与注意事项

| 项目 | 说明 |
| --- | --- |
| 后台/密码 | 无固定密码。连接使用随机 token 鉴权，支持一键轮换 |
| 网络 | 仅在手机与电脑的局域网内通信 |
| 构建脚本 | 首次运行会生成并保存 Release 签名私钥（不会提交到 Git），后续升级必须使用同一工作目录 |

## 📬 联系方式

- QQ 交流群：`1016190748`
- Telegram：[https://t.me/lenmoC](https://t.me/lenmoC)

联系或反馈时，请备注参考项目地址 `https://github.com/CoimgRain/Codex-Mini`、原创作者 `CoimgRain`，并说明你使用的版本、运行平台和具体问题。