# server.js Split Progress Report

## Branch
`feat/codex-remote-bridge-split`

## Status: Partially Complete (Honest Assessment)

## What Was Done

### 1. Function Extraction to `src/services/`
~200 functions extracted from `server.js` (5358 lines) into 21 module files + 1 context module (22 total).

All 22 modules load successfully via `require()` with no syntax errors.

**Pure utility modules (fully self-contained, no stubs):**
- `core.js` (243 lines) - isCodexThreadId, truncateText, normalizeHistoryText, classifyThreadProject, formatBytes, etc.
- `session.js` (380+ lines) - listCodexSessionFiles, readSessionMeta, findFirstCodexUserMessage, readThreadIndex
- `model.js` (278 lines) - readModelCatalogOptions, findModelOption, DESKTOP_MODEL_OPTIONS, handlePlugins
- `tool-utils.js` (165 lines) - formatToolCall, patchStats, extractCommandFiles, cleanVisibleProgress
- `status.js` (393 lines) - parseCodexStatus, handleCodexStatus, contextUsageFromItems

**Handler modules (need context wiring to work):**
- `history.js` (431 lines) - parseCodexThreadHistory, historyFromAppServerThread, handleThreadHistory
- `search.js` (116 lines) - searchCodexSessions, handleSearch
- `export.js` (69 lines) - buildMarkdownExport, handleExport
- `prompts.js` (100 lines) - normalizePromptLibrary, handlePromptLibrary
- `config.js` (182 lines) - handleClientConfig, handleHealth, getLanUrls
- `download.js` (97 lines) - handleDownload, handleFileDownload
- `screenshot.js` (104 lines) - handleScreenshot
- `git.js` (460+ lines) - handleGitAction, handlePullRequests, fetchGitHubJson
- `send.js` (1000+ lines) - handleSend, handleThreadAction, handleModelSwitch, handleReasoningMode
- `schedules.js` (78 lines) - handleSchedules, startScheduledTaskRunner
- `webhook.js` (49 lines) - handleWebhook, fireWebhook
- `stats.js` (67 lines) - handleStats, handleRotateToken
- `approvals.js` (55 lines) - handleCodexApprovals, handleCodexApproval
- `attachment.js` (27 lines) - handleHistoryAttachment
- `cdp.js` (39 lines) - handleCdpLaunch
- `keep-awake.js` (35 lines) - handleKeepAwake

### 2. Context Module
`context.js` (45 lines) - shared dependency injection container (configure/get pattern).

### 3. Baseline Tests
83/83 tests pass with original `server.js`.

## What Remains (NOT Done)

### Module Wiring (High Risk)
Each handler module has stub references to server.js closure variables that don't work at runtime:

```js
// Stubs in modules (return wrong values):
function isAuthorized(req) { return false; }  // always denies
const codexAppServer = { readThread: async () => null };  // returns null
```

**Modules already wired with context.get() (11 of 16):**
approvals, attachment, cdp, export, history, keep-awake, prompts, schedules, search, stats, webhook

**Modules still needing wiring (5 high-risk):**
- `config.js` - references PORT, TOKEN, APP_NAME, SERVICE_VERSION, DIST_DIR constants
- `download.js` - references listWorkspaceThreads, existingProjectCwds, DIST_ANDROID_DIR
- `git.js` - references persistentQueue, pullRequestCache, listWorkspaceThreads
- `screenshot.js` - references screenshotCache, screenshotCacheBusy, platform
- `send.js` - references ~30+ server.js variables (largest module, 44KB)

### server.js Rewrite (Blocked by Wiring)
Once all modules are wired, server.js can be rewritten from 5358 lines to ~500 lines of pure wiring code.

### Test Assertion Updates
`test/server.test.js` reads `./server.js` as text and asserts specific strings exist. After rewrite, assertions need to be updated to read from new module locations.

## Risk Assessment
Wiring the remaining 5 modules requires ~100+ individual edits. The `send.js` module alone references 30+ server.js variables. One missed reference causes a ReferenceError that crashes the server, failing the 2 behavioral tests that spawn `server.js` as a child process.
