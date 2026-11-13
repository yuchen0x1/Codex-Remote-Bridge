# Codex Remote Bridge

手机与电脑上的 Codex Desktop 之间的本地桥接。通过浏览器或 Android App，查看任务、发送消息和管理设备连接。

> **永久停止维护 · v4.2.0 为最终版本**
> 发布收尾版本后，本仓库转为只读归档。不再提供功能更新、兼容性适配、安全修复或问题处理。源码、历史文档及已发布安装包保留供查阅和自行维护。详见 [归档说明](docs/ARCHIVE.md)。

[下载最终版本](https://github.com/yuchen0x1/Codex-Remote-Bridge/releases/tag/v4.2.0) · [更新日志](docs/releases/release-notes.md) · [使用与构建文档](docs/README.md) · [MIT 许可证](LICENSE)

## 最新更新

### v4.2.0 · 2026-11-13 · 最终版本

新设备配对默认只读，可在「设置 → 配置」查看和撤销设备会话。令牌轮换会让旧连接失效；修复浏览器轮询误限流、配对二维码及定时任务重试问题。设置页改善栏宽、文字对比度、说明换行和手机触控间距，并加入版本与归档入口。

曾分享旧格式只读链接的用户应轮换主令牌并重新配对。Android 使用本地 Release 密钥签名；Windows/macOS 没有平台发行签名。完整变化和升级限制见 [最终发布说明](docs/releases/v4.2.0.md)。

## 界面预览

![电脑端设备与会话设置](docs/screenshots/devices-desktop.png)

<p>
  <img src="docs/screenshots/devices-mobile.png" width="270" alt="手机端设备会话管理">
  <img src="docs/screenshots/pairing-mobile.png" width="270" alt="手机端配对与权限选择">
</p>

## 可以做什么

| 场景 | 功能 |
| --- | --- |
| 手机查看 | 任务列表、聊天记录、回复进度、模型与推理等级 |
| 手机控制 | 发送文字和图片、停止响应、新建、归档、重命名任务 |
| 设备连接 | 配对二维码、只读或读写权限、会话撤销、令牌轮换 |
| 本地管理 | Windows WPF / macOS 启动器、Node 服务、定时任务与执行记录 |
| 版本下载 | Windows 校验安装包大小与 SHA-256；Android/macOS 提供下载入口 |

桥接控制流量在手机与电脑之间直连，不提供云中继。更新检查访问 GitHub；启用 Webhook 后会联系指定接收服务。Codex 自身的模型请求遵循其配置。任务配置、提示词库和执行日志保存在本机，图片附件会暂存到本机。

## 快速开始

电脑需要已安装并登录 Codex Desktop；手机与电脑处于同一局域网。可以从 [最终 Release](https://github.com/yuchen0x1/Codex-Remote-Bridge/releases/tag/v4.2.0) 获取安装包，也可以直接运行源码（Node.js 20 或以上，无运行时 npm 依赖）：

```powershell
git clone https://github.com/yuchen0x1/Codex-Remote-Bridge.git
cd Codex-Remote-Bridge
node server.js
```

默认使用 HTTPS 和本机生成的自签名证书。根据终端打印的局域网地址访问，首次连接需核对并接受证书。电脑端提供二维码入口，Web 配对码 90 秒有效且仅可兑换一次。

新设备默认只读，需要遥控电脑时选择「读写」。在「设置 → 配置 → 已连接设备」管理会话。若以前分享过 `主令牌:ro` 链接，请轮换主令牌并重新配对。

可通过 `MOBILE_TYPER_TOKEN` 设置访问令牌，通过 `CODEX_MAX_STATE_DIR` 指定数据目录。切换目录不会自动迁移旧数据。`npm run start:http` 显式启用明文 HTTP，仅适合可信测试环境。

## 文档与源码

| 文档 | 内容 |
| --- | --- |
| [设备与权限](docs/DEVICE_SECURITY.md) | 配对、会话撤销、令牌轮换与数据目录 |
| [构建说明](docs/BUILDING.md) | Windows、Android、macOS 源码构建 |
| [更新机制](docs/AUTO_UPDATE.md) | Release 清单、哈希校验、签名限制与恢复 |
| [移动端验收](docs/MOBILE_QA.md) | 真机检查范围与操作步骤 |
| [历史更新](CHANGELOG.md) | 完整版本变更记录 |
| [历史资料](docs/archive/README.md) | 旧方案、阶段审计与演进记录 |

代码入口：`server.js` 和 `src/` 为本地服务，`public/` 为网页，`windows/`、`android/`、`macos/` 为原生客户端。编译缓存、运行状态和签名私钥不属于源码发布内容。

## 致谢与许可

本项目基于 CoimgRain 的开源项目 Codex-Mini 的本地桥接思路，重写 Windows 自动化控制层并增加 Android 客户端。感谢原作者与所有使用者。源码遵循 [MIT](LICENSE)，可在保留许可声明的前提下自行分叉维护。
