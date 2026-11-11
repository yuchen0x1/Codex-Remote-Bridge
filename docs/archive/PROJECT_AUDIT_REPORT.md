# 项目审计与本地升级报告

审计日期：2026-11-09  
项目目录：`C:\Users\lenmo\Desktop\Codex-Remote-Bridge`  
基线：分支 `main`，HEAD `6571451`（标签 `v4.1.0`），审计开始时与 `origin/main` 同步。未提交前置内容：未跟踪的 `Microsoft/Windows/PowerShell/ModuleAnalysisCache`，本次保留。

## 1. 项目现状

Codex Remote Bridge 是连接手机与本机 Codex Desktop 的局域网桥接应用。当前服务默认 HTTPS，提供会话与一次性配对、线程和历史浏览、消息发送、审批、附件、提示词、定时任务、搜索、下载、截图、系统状态与 Git 操作等能力。它不是通用远程桌面或云端聊天服务。

| 层 | 技术与入口 |
|---|---|
| 服务端 | Node.js 20+，原生 HTTP/HTTPS，入口 `server.js`，不声明 npm 运行时依赖 |
| Web/PWA | `public/index.html` 单页内联应用、`public/sw.js`、manifest 与静态图标 |
| 模块 | `src/security`、`src/store`、`src/routes`、`src/scheduler`、`src/cdp`、`src/codex`、`src/services`、`src/platform` |
| Windows | WPF/.NET 8 项目 `windows/CodexMini`，负责服务管理与打包入口 |
| Android | Kotlin/Java、Jetpack Compose、WebView、Gradle；min SDK 23、compile/target SDK 35 |
| macOS | SwiftUI/Xcode 项目 `macos/CodexMini` |
| 持久化 | `~/.codex-max/state.json` 等本地状态；SQLite 可选队列实现，不属于 npm 声明依赖 |
| 构建/测试 | npm scripts、Gradle wrapper、Windows PowerShell 与 macOS shell 构建脚本；GitHub Actions CI |

目录覆盖服务端、网页、三种桌面/移动壳、脚本、文档、测试和截图。模块已经拆出，但 `server.js` 仍约 5,800 行并负责装配大量服务逻辑；应优先把仍留在入口的业务逐步迁移到现有 service/context 架构，避免一次性重写。

当前运行进程很多，机器上同时有多个 Node、Java、nginx 及其他服务。本次没有关闭任何既有进程；启动冒烟使用 `127.0.0.1:55029`，该端口启动前确认可用，随后已停止经命令行确认属于本次任务的 PID 51188。状态数据写入项目内隔离目录；HTTPS 使用了 `C:\Users\lenmo\.codex-max\certs` 中已有的证书与密钥（其时间戳为 2026-11-08，本次未写入或轮换）。

## 2. 清理记录

| 指标 | 审计前 | 审计后 | 说明 |
|---|---:|---:|---|
| 项目文件数（排除 `.git`、依赖、构建产物和未跟踪 `Microsoft/`） | 未复算 | 未复算 | 原统计口径无法复核；本轮未删除项目文件 |
| 根 `package.json` dependencies | 0 | 0 | 未发现可安全删除的 npm 依赖 |
| 根 `package.json` devDependencies | 0 | 0 | 未发现可安全删除的 npm 开发依赖 |
| 移除文件/依赖 | 0 | 0 | 无有证据确认的清理目标 |

保留了截图、图标、安装与构建脚本、Android wrapper、历史审计资料和所有配置。工作区中的 `Microsoft/Windows/PowerShell/ModuleAnalysisCache` 属用户已有未跟踪文件，未读取其业务内容、移动或删除。项目没有 `node_modules` 锁文件；不应为了形式而生成或移除锁文件。清理构建结果：未删除项目文件或依赖，因此没有清理后重建这一项。测试临时日志目录见第 7 节，并在交付前复核是否清理。

## 3. GitHub 竞品研究

研究按项目定位拆为“直接控制 Codex”与“相邻能力参考”。没有复制第三方代码或新增其依赖。GitHub API 查询受未认证请求限额限制；下表仅记录可核验的公开页面快照，随时间变化的 Stars 不作为质量结论。

| 仓库 | 可核实规模与活跃信息 | 许可证/范围 | 借鉴点与差距 |
|---|---|---|---|
| [openai/codex](https://github.com/openai/codex) | 官方本地编码 Agent；2026-11-09 检查仓库、目录、许可证及 Releases；最新可见 Release 为 0.167.0（11 月 6 日） | Apache-2.0；本项目只调用本机 Codex，不整合其代码 | 继续以官方 App Server/协议适配为主，保持适配层与 GUI/CDP fallback 的边界；Codex Agent/终端不是本项目需要重复实现的功能。 |
| [rustdesk/rustdesk](https://github.com/rustdesk/rustdesk) | 2026-11-09 检查仓库首页、目录与 license 标记；项目定位为自托管远程桌面 | AGPL-3.0；完整远程桌面产品，与本项目范围不同 | 可观察跨平台交付、连接状态与自托管文档。其屏幕/输入控制、发现和中继不宜直接并入“Codex 对话遥控器”；若未来借用代码需先做 AGPL 义务评估。 |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | 2026-11-09 检查仓库首页、目录、许可证说明与 Releases | Open WebUI License，包含品牌保留条款；历史版本另见 LICENSE_HISTORY | 借鉴文档、测试与模块目录的可发现性；其模型接入、知识库、多用户平台能力会扩大本项目的数据面与运行依赖，不建议整合。 |
| [LobeChat / LobeHub](https://github.com/lobehub/lobe-chat) | 本轮检索出现迁移/派生仓库和不同归属，未确认 canonical 仓库当前状态 | 许可随仓库与版本变化；未把派生仓库的许可当作上游证据 | 可参考语音交互与插件体验，但本项目已有浏览器语音、提示词与 Codex 原生工具流程；引入完整聊天框架会重复实现且偏离定位。 |
| [CoimgRain/Codex-Mini](https://github.com/CoimgRain/Codex-Mini) | README 与发布页可见，是本项目 README 致谢的上游参考 | 复用或派生代码时逐项遵守上游 LICENSE/版权声明 | 保留来源致谢；本项目已有自己的 Windows 自动化与 Android 客户端，不作整仓复制。 |

竞品研究是 GitHub 仓库首页、目录、license 标记与 Release 页面的抽样核验，不是对源码、Issues/PR、性能和实际部署的穷尽评测。未认证 API 限流，因此不报告无法稳定核实的 Stars 数量。2026-11-09 可见信息显示 Codex 仓库为 Apache-2.0，RustDesk 标注 AGPL-3.0，Open WebUI 当前许可含品牌保留条款；复用代码前仍须按目标版本许可逐项复核。竞品主要结论：本项目强项是直接操作本机 Codex、局域网优先、Windows 管理面板与手机端组合；弱项是入口体量、多端版本治理、前端单文件体量，以及当前工作站无法完整构建 Windows/macOS 目标。最有价值的借鉴是继续明确协议适配边界、为每个服务模块建立行为测试、保持运行状态和错误提示可见。暂不引入通用模型聚合、远程桌面中继或插件市场。

## 4. 问题与功能差距

### 已修复

1. **API 路径前缀边界错误（高）**：路由之前用裸 `startsWith` 匹配，故 `/codex/healthfoo` 会命中 `/codex/health`，可能误入健康检查豁免等特殊逻辑。现在只匹配精确路径或后续为 `/` 的路径段，并添加回归测试。
2. **多端版本信息落后（一般）**：服务 `package.json` 为 4.1.0，但 Windows 项目、Android `versionName` 和 macOS Release/Debug marketing version 分别仍有 4.0.0/2.1.0。已统一到 4.1.0，并同步 Android 输出说明与变更记录。

### 保留/后续处理

| 优先级 | 发现 | 建议与验收 |
|---|---|---|
| 高 | `server.js` 内仍有状态读写逻辑，与 `src/store/index.js` 的 Store 并存；服务目录存在以 `context` 延迟绑定的实现，需逐项核实实际调用与重复实现 | 规划渐进迁移；先定义单一状态接口和集成测试，旧 state.json 往返兼容后再移除重复路径 |
| 高 | 下载、附件与 Webhook 的 SSRF/路径边界需持续从解析、DNS 解析、重定向与文件符号链接角度复核；本轮只审查静态实现，没有对任意外部主机作网络探测 | 增补 DNS 重绑定/私网解析和重定向策略测试；远程目标默认阻断私网 |
| 中 | 浏览器 UI 集中在大型 `public/index.html` 内联脚本；原 viewport 禁止浏览器缩放，影响低视力用户文本放大 | 本轮移除缩放限制并允许根页面 pinch zoom；后续拆分需符合现有静态部署策略，并增加浏览器端端到端覆盖 |
| 中 | `.github/workflows/ci.yml` 包含 Android 单测、lint、构建；本机不能替代 macOS/Xcode 与 Windows/.NET SDK 构建 | 保持 CI 矩阵为跨平台验收依据，并确保版本号/打包路径受自动检查 |
| 中 | macOS 项目 Debug/Release 的产品标识与版本历史不完全同源；本次统一 marketing version，未构建 Xcode 产物 | 在 macOS Runner 上构建并核对生成的 bundle metadata |
| 低 | 多处空 catch 用于可选探测、平台兼容或清理失败，部分错误诊断可能不足 | 按用户可感知性分批补结构化日志，避免对预期缺失文件刷屏 |

功能盘点（按代码和现有测试）：Web/PWA 配对与会话、只读 scope、消息和附件、线程/历史、审批、提示词、语音、导出、搜索、下载、截图降级、定时任务、统计、Webhook、Git/系统状态、CDP WebSocket，以及原生壳均已有实现入口。服务端核心安全与行为测试覆盖良好；仅代码存在不等于本轮逐个端到端验证。此次未增加新产品能力，也未删除冗余功能。

## 5. 功能与架构升级

- `src/routes/index.js` 将 prefix dispatch 限定到 URL 路径段边界。
- `test/behavior.test.js` 新增一个相邻名称路径不命中回归用例。
- Windows、Android、macOS 壳的版本 metadata 统一为 4.1.0。
- `public/index.html` 移除了禁止浏览器缩放的 viewport 参数，并允许根页面 `pinch-zoom`；`test/server.test.js` 增加回归检查，`docs/MOBILE_QA.md` 增加缩放验收项。该改动改善移动端文本放大可访问性，但本轮未在真实设备完成手势和布局验收。
- `README.md` 修正 Android APK 示例名；`CHANGELOG.md` 增加 4.1.0 说明。
- 未变更架构层次、依赖、数据格式、UI、API schema 或用户设置；未从竞品复制源码。

## 6. 测试与运行验证

| 检查 | 结果 |
|---|---|
| `npm run check` | 通过；修改后复跑通过 |
| `npm test` | 当前源码 95/95 通过（含路由相邻路径与 viewport 缩放回归）；93/93、94/94 为中间阶段历史结果 |
| `node --check` 全部 `src/**/*.js` | 通过 |
| `git diff --check` | 通过（报告写入后再次核对） |
| Android `assembleDebug` | 通过；Gradle 报一处现有 `Icons.Filled.Send` deprecated 警告 |
| Android `testDebugUnitTest` | 8 个测试，0 failures，0 errors |
| HTTPS 服务启动冒烟 | 通过，`127.0.0.1:55029`；首页 200 且含 CSP，健康检查 200 / version=4.1.0，未认证 stats 401；结束后停止本次 PID |
| Windows WPF `dotnet build` | 未运行成功：当前环境没有安装 .NET SDK（不是源码构建错误结论） |
| macOS/Xcode 构建 | 未执行：当前环境没有 `xcodebuild`/`swiftc` |
| 真机/多浏览器交互 | 未完成；Playwright Chromium 报 `spawn UNKNOWN`，应用内 Edge 拒绝自签名 HTTPS 证书，切换 HTTP 后 Agent Window 网络沙箱拦截；未取得真实页面截图或视口/手势验收 |

首次 Android `testDebugUnitTest` 与 `assembleDebug` 同时运行，因 Gradle 共享 `build/intermediates` 产物竞争失败；串行重跑后 APK 构建成功，单测报告为 8/8。测试使用的服务端临时端口只绑定 loopback，没有探测或关闭其他项目端口。

## 7. 清理、文件与依赖修改清单

- 删除文件：无。
- 删除依赖：无；npm 依赖基数为 0，Android 依赖未变更。
- 新增文件：`PROJECT_AUDIT_REPORT.md`。
- 修改文件：`CHANGELOG.md`、`README.md`、`android/CodexMax/app/build.gradle.kts`、`docs/MOBILE_QA.md`、`macos/CodexMini/CodexMini.xcodeproj/project.pbxproj`、`public/index.html`、`src/routes/index.js`、`test/behavior.test.js`、`test/server.test.js`、`windows/CodexMini/CodexMiniWin.csproj`。
- 移动文件：无。
- 工作区开始时用户未跟踪文件 `Microsoft/Windows/PowerShell/ModuleAnalysisCache` 保留原样。
- 检查时发现两个被 `.gitignore` 忽略的临时日志目录：`tmp-audit-smoke-fb7e1b7dd31641a9831bf9b688e574f1/`（`stdout.log`、`stderr.log`）及 `tmp-ui-audit-wa9o144a/`（`server.log`）。日志由本轮测试生成，服务进程已退出；交付前已尝试清理并再次核实状态。

## 8. 最终质量评价与验收重点

本轮将已确认的路由误匹配修复并用回归测试锁定，补齐壳层与服务版本不一致，并修复移动页面禁用缩放的问题。Node 行为测试、语法检查、Android 构建/单测和 HTTPS 服务冒烟均通过。没有证据支持删除项目文件或依赖，因此没有为追求文件数量而删除内容。

请重点验收：

1. Android 与 Windows/macOS 属性中的 4.1.0 版本显示符合本次期望，尤其 Android 安装包版本名。
2. API 路由边界变化符合预期：`/codex/health/` 仍按前缀路由处理，`/codex/healthfoo` 不再误命中。
3. `Microsoft/Windows/PowerShell/ModuleAnalysisCache` 等本地未跟踪内容仍保留。

未完成的验收是 Windows/macOS 本机构建、浏览器可视视口与 pinch zoom 交互、跨平台真实 UI 和 Android 真机流程；应在对应 Runner/设备完成后再称多端交付完全验证。所有修改仅在本地，未提交、未打 tag、未推送或发布。
