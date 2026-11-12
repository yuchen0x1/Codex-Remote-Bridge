# Changelog

# Unreleased

- Feat: add GitHub Releases update manifest generation with SHA-256 asset checksums.
- Feat: Windows checks GitHub releases, downloads to a temporary file, verifies size and SHA-256, and starts the installer only after verification.
- Feat: Android and macOS clients can check the public GitHub update manifest and open platform assets.
- Docs: add `docs/AUTO_UPDATE.md` with release, signing, testing, and recovery procedures.
- Chore: rename the user-facing project and desktop/mobile application branding to Codex Remote Bridge
- Chore: update package metadata, documentation, PWA metadata, build outputs, and installer names
- Compatibility: preserve legacy ChatGPT Win/Codex Max configuration paths, installer lookup, and web route aliases

# 4.1.0 (2026-11-08)

- Security: HTTPS is now the default transport with automatically managed local certificates.
- Security: webhook notifications use HMAC-SHA256 signatures and reject private-network targets by default.
- Fix: route prefixes now respect path-segment boundaries and no longer misroute names such as `/codex/healthfoo`.
- Chore: synchronize Windows, macOS, Android, and service version metadata to 4.1.0.

# 4.0.0 (2026-08-02)

- Feat: 路由分发中枢 - server.js 的 if 链替换为 Router 模块（精确/前缀/静态/405 统一分发）
- Feat: CDP WebSocket 长连接 - 持久连接 + 心跳 + 断线重连 + 状态推送（ws-hub）
- Feat: SQLite 持久化操作队列 - 操作队列/执行日志持久化（better-sqlite3 可选，JSON 回退）
- Feat: SQLite 队列接入业务 - 发送/Git 操作/定时任务执行均写入执行日志
- Feat: Android Jetpack Compose UI 重写 - Material 3 + StateFlow + ViewModel
- Feat: cron 表达式定时任务 - 5 字段解析、L 修饰符、中文描述、重试策略
- Feat: 真实行为测试 - Router/Security/PersistentQueue/CronParser/Certificate 行为级测试
- Security: CORS 收紧 - Origin 回环/同源白名单校验，拒绝未知跨站来源
- Security: CSP 安全头 - script/style/img/connect 限制 + frame-ancestors + nosniff + referrer-policy
- Security: 限流双维度 - IP 与 token 独立令牌桶，任一维度超限即拒绝
- Security: 证书纯 Node 生成 - 手工 X.509 DER 构造 CA 根 + 服务器证书链，TLS 握手验证通过（OpenSSL 仅兜底）
- Perf: 静态资源 LRU 内存缓存 - 高频页面/图标免重复读盘（256KB/200 项自动淘汰）
- Perf: Android WorkManager - 周期 15 分钟后台健康检查，连接页展示在线/离线状态
- UI: Android 服务健康卡片 - 在线状态指示 + 版本号显示
- UI: PWA 离线支持 - service worker 网络优先缓存（manifest 已有）
- Feat: 执行统计 API - /codex/stats 聚合队列/成功率/操作分布/时间范围
- Feat: Webhook 通知 - 配置 URL，发送成功/失败时 POST 事件（可关闭）
- Chore: 四端统一版本号 v4.0.0（Windows/macOS/Android/服务端）
- Chore: 版本升级至 v4.0.0

# 3.2.0 (2026-08-02)

- Feat: 模块化架构拆分 - server.js 拆分为独立模块（store/security/logger/scheduler/codex-parser/routes）
- Feat: 结构化日志系统 - JSON 格式输出、日志级别、HTTP 请求日志
- Feat: HTTPS 支持 - 自签名证书自动生成（CODEX_MAX_HTTPS=1 启用）
- Feat: 增强健康检查 - 内存使用、运行时长、定时任务数、Node 版本、CDP 状态
- Feat: 安全模块集成 - Token 轮换、限流、鉴权统一管理
- Feat: 定时任务引擎模块化 - Scheduler 独立模块，支持 CRUD 和执行状态跟踪
- Feat: 前端监控面板 - 服务诊断页显示运行时长、内存占用、定时任务、CDP 状态
- Feat: GitHub Actions Release 工作流 - tag 推送自动构建 APK 并创建 Release
- Feat: npm run check 检查所有模块语法
- Chore: 版本升级至 v3.2.0

# 3.1.2 (2026-08-01)

- Feat: Android in-app update check (prompts when server has a newer APK)
- Feat: Windows launcher startup update check
- Feat: /codex/rotate-token endpoint with persisted token rotation
- Feat: /codex/download endpoint for authenticated APK/installer downloads
- Feat: /codex/config exposes update versions for all platforms
- Chore: bump Android to v1.2.7 and service to v3.1.1

# 3.1.1 (2026-08-01)

- Fix: mobile settings page cannot scroll vertically on Android WebView
- Chore: add Android client source code and ChatGPT Win branding
- Chore: update Windows installer branding to ChatGPT Win

# 3.1.0 (2026-07-31)

- Feat: Android native app (WebView + QR scan + background status polling + notifications)
- Feat: Windows single-file portable build mode
- Feat: Workspace settings page (mobile-accessible UI for project/environment/config)
- Feat: keep-awake API to prevent Windows sleep from mobile
- Feat: CDP-controlled Codex launcher (Chrome DevTools Protocol integration)
- Feat: mobile pull request list view
- Feat: plugin marketplace browsing from mobile
- Feat: scheduled tasks management UI
- Feat: context compression controls from mobile
- Feat: thread rename, archive, and compact actions from mobile
- Fix: cross-thread send now switches Codex thread before dispatching
- Fix: Windows service manager health check and auto-restart logic
- Fix: attachment paste settling timing on Windows (520ms)
- Fix: token validation via cookie, header, and query parameter
- Chore: rename project from "Codex Max" to "ChatGPT Win"
- Chore: migrate to Inno Setup 6 for Windows installer
- Chore: add mobile QA acceptance baseline doc
- Chore: update README with branded screenshots

# 3.0.6 (2026-06-06)

- Feat: CDP-controlled Codex launcher (initial implementation)
- Feat: cross-thread send support
- Feat: Windows MVP adaptation layer (src/platform/win32.js)
- Fix: highlight open-source vs packaged build distinction in README
- Chore: macOS support notice and community contribution guide

# 3.0.5 (2026-06-05)

- Feat: initial open-source local edition fork from Codex Mini
- Feat: core phone-to-Codex bridge (HTTP service + token auth)
- Feat: mobile thread list, send, status polling
- Feat: model switch and reasoning mode selection from mobile
- Feat: macOS wrapper app (upstream)
- Feat: QR code connection via Windows client
- Feat: session history view, file attachment support
- Chore: remove hosted access, payment, activation, and test-build distribution code
- Chore: keep core local bridge, thread list, send, status, model menu, and macOS wrapper
- Chore: initial open-source README and preview assets

## Android APK versions (dist/android/)

| Version | Notes |
|---------|-------|
| v1.0.0  | Debug build, Codex Max branding |
| v1.1.0  | ChatGPT Win branding, release build |
| v1.1.1  | Bug fixes |
| v1.2.0  | QR scan, manual connect, notification permission |
| v1.2.1  | Background polling improvements |
| v1.2.2  | Task notification channels |
| v1.2.3  | UI adjustments |
| v1.2.4  | Screen fit options |
| v1.2.5  | Monitor service refinements |
| v1.2.6  | Stable release |
| v1.2.7  | Latest - in-app update check, download endpoint |

## Windows installer versions

| Version   | Notes |
|-----------|-------|
| v3.0.5-win | Codex Max branding, .NET 6 runtime |
| v3.1.0-win | ChatGPT Win branding, .NET 8 self-contained |
| v3.1.1-win | Current - latest installer |

## Known issues

- Android unit tests fail on some machines due to Gradle worker classpath issue (workaround: assembleDebug succeeds independently)
- macOS resource bundle in this repo tracks Windows; build on macOS requires Xcode + .NET 8 SDK
- Automatic updates are now checked through the GitHub Release manifest; Windows verifies the downloaded installer before starting it, while Android and macOS expose allowlisted HTTPS release assets for user-driven installation
