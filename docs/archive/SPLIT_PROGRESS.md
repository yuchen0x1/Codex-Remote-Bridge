# server.js 拆分进度

## 分支
`main`

## 状态：正常更新

server.js 的服务能力已完成模块化拆分，并在主线持续维护。当前拆分结果已经成为项目的正式实现，后续功能直接在现有模块上持续迭代。

## 当前结构

- `src/services/`：配置、会话、历史、状态、发送、Git、计划任务、下载、截图、统计等业务服务。
- `src/routes/`：HTTP 路由注册与请求分发。
- `src/store/`：状态、队列与增量读取缓存。
- `src/codex/`：Codex 会话解析。
- `src/cdp/`：CDP 连接与状态推送。
- `src/platform/`：Windows、macOS 平台适配。
- `src/security/`：令牌、会话、证书与访问控制。

## 维护约定

- 新功能直接进入 `main` 的现有模块，保持服务入口稳定。
- 每次改动运行 `npm run check` 和 `npm test`。
- 跨平台行为继续通过 Windows、macOS、Android 对应工程与脚本维护。

## 当前结论

项目处于正常更新状态，模块拆分已纳入主线；后续功能按实际需求持续迭代。
