#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const { CodexAppServer } = require('./src/codex-app-server');
const { TailReader } = require('./src/store/tail-reader');

// ===== 模块化组件 =====
const { Store } = require('./src/store');
const { PersistentQueue } = require('./src/store/queue');
const { Security } = require('./src/security');
const { SessionManager } = require('./src/security/sessions');
const { PairingManager } = require('./src/security/pairing');
const { CertificateManager } = require('./src/security/certs');
const { Logger, defaultLogger } = require('./src/logger');
const { Scheduler, normalizeScheduledTask, normalizeScheduledTasks, createScheduledTaskRecord, nextScheduledRunAt, SCHEDULED_TASK_LIMIT, RETRY_STRATEGIES } = require('./src/scheduler');
const { CronParser } = require('./src/scheduler/cron');
const { CodexSessionParser } = require('./src/codex/session-parser');
const { CdpWebSocketHub } = require('./src/cdp/ws-hub');
const { Router, getClientIp, corsHeaders } = require('./src/routes');
const { MdnsBroadcaster } = require('./src/services/mdns');
// json 和 readBody 使用 server.js 本地定义（包含 CORS 头和超时处理）

const APP_NAME = process.env.CODEX_MAX_APP_NAME || process.env.CODEX_MINI_APP_NAME || 'Codex Remote Bridge';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const FORCE_HTTPS = process.env.CODEX_MAX_HTTPS === '1' || process.env.CODEX_MINI_HTTPS === '1';
const FORCE_HTTP = process.env.CODEX_MAX_HTTP_ONLY === '1' || process.env.CODEX_MINI_HTTP_ONLY === '1';
// HTTPS 默认开启（自签名证书）以保护局域网 token 与消息；仅当显式 CODEX_MAX_HTTP_ONLY=1 时才回退明文 HTTP
const USE_HTTPS = FORCE_HTTPS || !FORCE_HTTP;
let LAN_PROTOCOL = 'http';

function loadPersistedToken() {
  try {
    const stored = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return /^[A-Za-z0-9_-]{16,64}$/.test(stored) ? stored : '';
  } catch {
    return '';
  }
}

function persistToken(token) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tempFile = `${TOKEN_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, token, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tempFile, TOKEN_FILE);
    } catch {
      fs.writeFileSync(TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
      try { fs.unlinkSync(tempFile); } catch {}
    }
  } catch (error) {
    console.warn('[token] 保存访问令牌失败:', error.message || error);
  }
}

function syncLauncherToken(token) {
  if (process.platform !== 'win32') return;
  try {
    const launcherPaths = [
      path.join(os.homedir(), 'AppData', 'Roaming', 'Codex Remote Bridge', 'launcher.json'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'ChatGPT Win', 'launcher.json'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'Codex Max', 'launcher.json'),
    ];
    for (const launcherPath of launcherPaths) {
      if (!fs.existsSync(launcherPath)) continue;
      const config = JSON.parse(fs.readFileSync(launcherPath, 'utf8'));
      if (config && typeof config === 'object' && config.token !== token) {
        config.token = token;
        fs.writeFileSync(launcherPath, JSON.stringify(config, null, 2), 'utf8');
      }
    }
  } catch {}
}

function rotateAccessToken() {
  TOKEN = security.rotateToken();
  pairingManager.revokeAll();
  cdpWsHub.disconnectUnauthorized();
  return TOKEN;
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_TEXT_LENGTH = 8000;
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = Number(process.env.CODEX_MAX_MAX_ATTACHMENT_BYTES || process.env.CODEX_MINI_MAX_ATTACHMENT_BYTES || 8 * 1024 * 1024);
// 请求体上限需能容纳 6 张 base64 图片（base64 约放大 4/3），避免单图合法但组合被 413
const DEFAULT_MAX_BODY_BYTES = Math.max(28 * 1024 * 1024, Math.ceil(MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES * 4 / 3) + 1024 * 1024);
const MAX_BODY_BYTES = Number(process.env.CODEX_MAX_MAX_BODY_BYTES || process.env.CODEX_MINI_MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
const MAX_DOWNLOAD_BYTES = Number(process.env.CODEX_MAX_MAX_DOWNLOAD_BYTES || process.env.CODEX_MINI_MAX_DOWNLOAD_BYTES || 20 * 1024 * 1024);
const MAX_SCREENSHOT_BYTES = Number(process.env.CODEX_MAX_MAX_SCREENSHOT_BYTES || process.env.CODEX_MINI_MAX_SCREENSHOT_BYTES || 8 * 1024 * 1024);
const SCREENSHOT_CACHE_TTL_MS = Math.max(500, Number(process.env.CODEX_MAX_SCREENSHOT_CACHE_MS || 5000));
const UPLOAD_DIR = path.join(os.tmpdir(), 'codex-max-uploads');
const HISTORY_ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const HISTORY_ATTACHMENT_LIMIT = 600;
const STATE_DIR = process.env.CODEX_MAX_STATE_DIR || process.env.CODEX_MINI_STATE_DIR || path.join(os.homedir(), '.codex-max');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const TOKEN_FILE = path.join(STATE_DIR, 'token');
const DIST_DIR = path.join(__dirname, 'dist');
const DIST_ANDROID_DIR = path.join(DIST_DIR, 'android');
const DIST_WINDOWS_INSTALLER_DIR = path.join(DIST_DIR, 'windows', 'installer');
const SERVICE_VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();
const UPDATE_REPOSITORY = String(
  process.env.CODEX_MAX_UPDATE_REPOSITORY ||
  process.env.CODEX_MINI_UPDATE_REPOSITORY ||
  'yuchen0x1/Codex-Remote-Bridge',
).trim();
const UPDATE_CHANNEL = String(
  process.env.CODEX_MAX_UPDATE_CHANNEL ||
  process.env.CODEX_MINI_UPDATE_CHANNEL ||
  'stable',
).trim() || 'stable';
const UPDATE_MANIFEST_URL = String(
  process.env.CODEX_MAX_UPDATE_MANIFEST_URL ||
  process.env.CODEX_MINI_UPDATE_MANIFEST_URL ||
  `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/update-manifest.json`,
).trim();
const UPDATE_RELEASE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/latest`;
let TOKEN = loadPersistedToken() || process.env.MOBILE_TYPER_TOKEN || crypto.randomBytes(12).toString('base64url');
const codexAppServer = new CodexAppServer({ cwd: __dirname });

// ===== 模块化初始化 =====
const store = new Store({ stateDir: STATE_DIR, stateFile: STATE_FILE, tokenFile: TOKEN_FILE });
const logger = defaultLogger;
const sessionManager = new SessionManager({ logger, cookieSecure: USE_HTTPS });
const pairingManager = new PairingManager({ logger });
const security = new Security({ initialToken: TOKEN, appName: APP_NAME, store, sessionManager });
const parser = new CodexSessionParser({ store });
const persistentQueue = new PersistentQueue({ logger, dbDir: path.join(STATE_DIR, 'db') });
const scheduler = new Scheduler({
  store,
  codexAppServer,
  logger,
  logExecution: (threadId, action, status, durationMs, error, detail) => persistentQueue.logExecution(threadId, action, status, durationMs, error, detail),
});
const certManager = new CertificateManager({ certDir: path.join(STATE_DIR, 'certs') });
const cdpWsHub = new CdpWebSocketHub({ security, logger });

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const CODEX_DESKTOP_LOGS_DIR = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Logs', 'com.openai.codex')
  : process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming', 'com.openai.codex', 'logs')
    : path.join(os.homedir(), '.codex', 'logs');
const CODEX_SESSION_TAIL_BYTES = 5 * 1024 * 1024;
const CODEX_ACTIVITY_TAIL_BYTES = 512 * 1024;
const CODEX_ACTIVITY_LOOKBACK_BYTES = CODEX_SESSION_TAIL_BYTES;
const CODEX_RUNTIME_STALE_MS = 2 * 60 * 60 * 1000;
const CODEX_HISTORY_TAIL_BYTES = 128 * 1024 * 1024;
const CODEX_TITLE_SCAN_BYTES = 12 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 120;
const CODEX_SEARCH_TAIL_BYTES = 2 * 1024 * 1024;
const CODEX_SEARCH_MAX_FILES = 200;
const CODEX_SEARCH_MAX_RESULTS = 100;
const CODEX_SEARCH_MIN_QUERY_LENGTH = 2;
const GUI_FAILURE_REPORT_LIMIT = 80;
// SCHEDULED_TASK 常量已迁移到 src/scheduler 模块
const GITHUB_REQUEST_TIMEOUT_MS = 10000;
const GITHUB_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const ENVIRONMENT_MAX_FILES = 80;
const ENVIRONMENT_MAX_BRANCHES = 80;
const ENVIRONMENT_MAX_UNTRACKED_TEXT_BYTES = 1024 * 1024;
const GUI_FAILURE_LOG_SCAN_BYTES = 2 * 1024 * 1024;
const GUI_FAILURE_LOG_RECENT_MS = 15 * 60 * 1000;
const RECENT_SEND_TTL_MS = 5 * 60 * 1000;
const CODEX_THREAD_SYNC_FRESH_MS = process.platform === 'win32' ? 10 * 60 * 1000 : 5000;
const CODEX_DEEPLINK_SETTLE_MS = process.platform === 'win32' ? 1400 : 560;
const CODEX_APP_FOCUS_SETTLE_MS = 100;
const CODEX_CLICK_SETTLE_MS = 60;
const TEXT_PASTE_SETTLE_MS = process.platform === 'win32' ? 180 : 140;
const ATTACHMENT_PASTE_SETTLE_MS = process.platform === 'win32' ? 520 : 220;
const CODEX_COMMAND_SETTLE_MS = process.platform === 'win32' ? 220 : 180;
const CODEX_MODEL_COMMAND_SETTLE_MS = process.platform === 'win32' ? 520 : 450;
const CODEX_REASONING_COMMAND_SETTLE_MS = process.platform === 'win32' ? 520 : 450;
const CODEX_SEND_CONFIRM_TIMEOUT_MS = process.platform === 'win32' ? 1800 : 0;
const CODEX_SESSION_FILE_CACHE_MS = 3000; // Phase 3.3: 线程列表 TTL 1.2s→3s（配合前端轮询）
const CODEX_THREAD_LIST_CACHE_MS = 1200;
const CODEX_HISTORY_INITIAL_TAIL_BYTES = 8 * 1024 * 1024;
const REASONING_MODE_TARGETS = {
  low: { key: 'low', value: 'low', label: '低', displayName: '低' },
  medium: { key: 'medium', value: 'medium', label: '中', displayName: '中' },
  high: { key: 'high', value: 'high', label: '高', displayName: '高' },
  xhigh: { key: 'xhigh', value: 'xhigh', label: '超高', displayName: '超高' },
  max: { key: 'max', value: 'max', label: '最高', displayName: '最高' },
  ultra: { key: 'ultra', value: 'ultra', label: '极致', displayName: '极致' },
};
const DESKTOP_MODEL_OPTIONS = [
  { key: 'gpt-5.6-sol', id: 'gpt-5.6-sol', label: '5.6 Sol', displayName: '5.6 Sol', source: 'desktop' },
  { key: 'gpt-5.6-terra', id: 'gpt-5.6-terra', label: '5.6 Terra', displayName: '5.6 Terra', source: 'desktop' },
  { key: 'gpt-5.6-luna', id: 'gpt-5.6-luna', label: '5.6 Luna', displayName: '5.6 Luna', source: 'desktop' },
  { key: 'gpt-5.5', id: 'gpt-5.5', label: '5.5', displayName: '5.5', source: 'desktop' },
  { key: 'gpt-5.4', id: 'gpt-5.4', label: '5.4', displayName: '5.4', source: 'desktop' },
  { key: 'gpt-5.4-mini', id: 'gpt-5.4-mini', label: '5.4 Mini', displayName: '5.4 Mini', source: 'desktop' },
  { key: 'gpt-5.2', id: 'gpt-5.2', label: '5.2', displayName: '5.2', source: 'desktop' },
];
const recentSendRequests = new Map();
let lastCodexThreadActivation = { threadId: '', at: 0 };
// 注：限流（token bucket）已由 Security 模块（src/security/index.js）统一管理
// -----------------------------------------------------
let codexSessionFilesCache = { at: 0, files: [] };
// Phase 3.1: /codex/status 增量解析缓存（尾部只读、追加增量、截断重读）
const statusTailReader = new TailReader({ tailBytes: CODEX_SESSION_TAIL_BYTES });
// Phase 3.4: 请求级延迟观测（P50/P95，环形窗口）
const LATENCY_SAMPLE_LIMIT = 512;
const latencySamples = [];
function recordLatency(pathname, ms) {
  latencySamples.push({ path: pathname, ms });
  if (latencySamples.length > LATENCY_SAMPLE_LIMIT) {
    latencySamples.splice(0, latencySamples.length - LATENCY_SAMPLE_LIMIT);
  }
}
function percentileOfSorted(sorted, q) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return Math.round(sorted[index] * 10) / 10;
}
function latencySummary() {
  if (!latencySamples.length) return { samples: 0 };
  const all = latencySamples.map(sample => sample.ms).sort((a, b) => a - b);
  const byPathMap = new Map();
  for (const sample of latencySamples) {
    if (!byPathMap.has(sample.path)) byPathMap.set(sample.path, []);
    byPathMap.get(sample.path).push(sample.ms);
  }
  const byPath = [];
  for (const [path, values] of byPathMap) {
    values.sort((a, b) => a - b);
    byPath.push({ path, count: values.length, p50Ms: percentileOfSorted(values, 0.5), p95Ms: percentileOfSorted(values, 0.95) });
  }
  byPath.sort((a, b) => b.count - a.count);
  return {
    samples: all.length,
    p50Ms: percentileOfSorted(all, 0.5),
    p95Ms: percentileOfSorted(all, 0.95),
    maxMs: Math.round(all[all.length - 1] * 10) / 10,
    byPath: byPath.slice(0, 10),
  };
}
let threadIndexCache = { mtimeMs: 0, size: 0, byId: null };
const sessionMetaCache = new Map();
const firstUserMessageCache = new Map();
const runtimeSummaryCache = new Map();
const codexThreadListCache = new Map();
let modelCatalogCache = { mtimeMs: -1, path: '', models: null };
let keepAwakeProcess = null;
let keepAwakeStartedAt = '';
let scheduledTaskTimer = null;
const scheduledTaskRuns = new Set();
const pullRequestCache = new Map();
const historyAttachmentCache = new Map();
const historyAttachmentIdByPath = new Map(); // filePath -> id 反向索引（O(1) 查找，替代每次 O(n) 全表扫描）

const screenshotCache = new Map(); // `${port}:${targetUrl}` -> { data, width, height, capturedAt }
const screenshotCacheBusy = new Map(); // 并发去重：同一 target 同时只有一个真实截图在途
function fileCacheSignature(stat) {
  return stat ? `${stat.size}:${stat.mtimeMs}` : '';
}

function boundedSet(map, key, value, limit = 300) {
  if (map.size >= limit && !map.has(key)) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
  return value;
}

function invalidateCodexThreadListCache() {
  codexThreadListCache.clear();
}

function isKeepAwakeActive() {
  return Boolean(platform.keepAwakeStatus().enabled);
}

function keepAwakeStatus() {
  return platform.keepAwakeStatus();
}

function startKeepAwake() {
  return platform.startKeepAwake();
}

function stopKeepAwake() {
  return platform.stopKeepAwake();
}

function cleanupKeepAwake() {
  platform.cleanup();
}

function readCodexConfigText() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

function tomlStringValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match ? match[1] : '';
}

function labelFromModelName(name = '') {
  const text = String(name || '').trim();
  if (!text) return '';
  return text
    .replace(/[（(].*?[）)]/g, '')
    .replace(/^GPT-/i, '')
    .replace(/^gpt-/i, '')
    .replace(/^codex-/i, '')
    .trim() || text;
}

function normalizeSupportedReasoningEfforts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'string' ? item : String(item?.reasoningEffort || item?.id || item?.value || ''))
    .filter(Boolean);
}

function normalizeModelOption(row = {}) {
  const id = String(row.slug || row.id || row.model || '').trim();
  if (!id) return null;
  const displayName = String(row.display_name || row.name || row.label || id).trim();
  return {
    key: id,
    id,
    label: labelFromModelName(displayName || id),
    displayName: displayName || id,
    source: 'local',
  };
}

function mergeModelOptions(...lists) {
  const rows = [];
  const indexes = new Map();
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const id = String(item?.id || item?.key || '').trim();
      if (!id) continue;
      const option = { ...item, key: String(item.key || id), id };
      if (indexes.has(id)) rows[indexes.get(id)] = { ...rows[indexes.get(id)], ...option };
      else {
        indexes.set(id, rows.length);
        rows.push(option);
      }
    }
  }
  return rows;
}

function readModelCatalogOptions() {
  const configText = readCodexConfigText();
  const catalogPath = tomlStringValue(configText, 'model_catalog_json');
  const resolvedPath = catalogPath.startsWith('~') ? path.join(os.homedir(), catalogPath.slice(1)) : catalogPath;
  const fallback = () => {
    const current = tomlStringValue(configText, 'model');
    const currentOption = current ? [{ key: current, id: current, label: labelFromModelName(current), displayName: current, source: 'local' }] : [];
    return mergeModelOptions(DESKTOP_MODEL_OPTIONS, currentOption);
  };
  if (!resolvedPath) return fallback();
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return fallback();
  }
  if (modelCatalogCache.models && modelCatalogCache.path === resolvedPath && modelCatalogCache.mtimeMs === stat.mtimeMs) {
    return modelCatalogCache.models;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    const models = (Array.isArray(parsed.models) ? parsed.models : [])
      .filter(row => row && row.visibility !== 'hide')
      .map(normalizeModelOption)
      .filter(Boolean);
    modelCatalogCache = { path: resolvedPath, mtimeMs: stat.mtimeMs, models };
    return models.length ? mergeModelOptions(DESKTOP_MODEL_OPTIONS, models) : fallback();
  } catch {
    return fallback();
  }
}

function findModelOption(id = '') {
  const targetId = String(id || '').trim();
  if (!targetId) return null;
  return readModelCatalogOptions().find(item => item.id === targetId || item.key === targetId) || null;
}

// 状态读写统一委托 Store：单写入者、字段集恒定、写入原子化。
// 迁移说明：旧实现直接读写 state.json，且字段集不含 webhook/webhookSecret，
// 与 Store 互相覆盖曾导致提示词库或 Webhook 密钥静默丢失。
function emptyCodexMiniState() {
  return store.readState();
}

function readCodexMiniState() {
  return store.readState();
}

function writeCodexMiniState(state) {
  const saved = store.writeState(state);
  invalidateCodexThreadListCache();
  return saved;
}

const MAX_PROMPT_LIBRARY_ITEMS = 200;
// normalizePromptLibrary 已迁移到 src/store（状态规范化必须与写入者同源）
function normalizeGuiFailureReports(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [threadId, rows] of Object.entries(value)) {
    if (!isCodexThreadId(threadId) || !Array.isArray(rows)) continue;
    const normalizedRows = rows
      .map(row => ({
        turnId: typeof row.turnId === 'string' ? row.turnId : '',
        text: truncateText(normalizeHistoryText(row.text || ''), 2000),
        capturedAt: typeof row.capturedAt === 'string' ? row.capturedAt : '',
        completedAt: typeof row.completedAt === 'string' ? row.completedAt : '',
        source: typeof row.source === 'string' ? row.source : 'unknown',
      }))
      .filter(row => row.text)
      .slice(-GUI_FAILURE_REPORT_LIMIT);
    if (normalizedRows.length) out[threadId] = normalizedRows;
  }
  return out;
}

function normalizeIsoTimestamp(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

// normalizeScheduledTask, normalizeScheduledTasks, nextScheduledRunAt 已迁移到 src/scheduler 模块

function setThreadSetMembership(list, threadId, enabled) {
  const set = new Set((Array.isArray(list) ? list : []).filter(isCodexThreadId));
  if (enabled) set.add(threadId);
  else set.delete(threadId);
  return [...set];
}

function truncateText(value, max = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => item && (item.text || item.message || '')).filter(Boolean).join('\n');
}

function normalizeHistoryText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function extractPlainTextDeep(value, seen = new Set()) {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const out = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...extractPlainTextDeep(item, seen));
    return out;
  }

  for (const key of ['message', 'detail', 'details', 'error', 'reason', 'description', 'status', 'code', 'title', 'text']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out.push(...extractPlainTextDeep(value[key], seen));
  }
  return out;
}

function isFailureLikePayload(payload = {}) {
  const type = String(payload.type || '').toLowerCase();
  const status = String(payload.status || '').toLowerCase();
  const code = String(payload.code || '').toLowerCase();
  return (
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(type) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(status) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(code) ||
    payload.error != null ||
    payload.detail != null ||
    payload.details != null ||
    payload.reason != null
  );
}

function isTerminalFailurePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const type = String(payload.type || '').toLowerCase();
  return (
    type === 'turn_aborted' ||
    /(?:^|_)(?:failed|failure|error|timeout|cancelled|canceled|aborted|interrupted)$/.test(type) ||
    (
      isFailureLikePayload(payload) &&
      /(?:abort|cancel|interrupt|fail|error|timeout|unavailable|overload)/.test(type)
    )
  );
}

function extractFailureTextFromPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !isFailureLikePayload(payload)) return '';
  const text = extractPlainTextDeep(payload)
    .map(value => normalizeHistoryText(value))
    .filter(Boolean)
    .filter(value => !/^(true|false|null|undefined)$/i.test(value))
    .join('\n');
  return truncateText(text, 1600);
}

function emptyCodexFailureText() {
  return 'Codex GUI 这次没有返回可显示回复。会话日志也没有写入可读取的失败提示原文；请在电脑 Codex GUI 查看原始失败提示。';
}

function decodeLogQuotedValue(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
  } catch {
    return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function safeParseJsonText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonAssignment(line, key) {
  const marker = `${key}=`;
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const open = line.indexOf('{', start + marker.length);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return line.slice(open, i + 1);
    }
  }
  return null;
}

function extractDesktopLogFailureText(line) {
  const raw = String(line || '');
  if (!/(?:\berror\b|failed|failure|Forbidden|unexpected status|channel affinity|AiMaMi|revoked|Unauthorized)/i.test(raw)) return '';
  if (/(?:git\.command\.complete|worker_rpc_response_error|Conversation state not found|Received turn\/(?:started|completed) for unknown conversation|Item not found in turn state)/i.test(raw)) return '';
  const candidates = [];
  for (const key of ['error', 'result']) {
    const jsonText = extractJsonAssignment(raw, key);
    const parsed = jsonText ? safeParseJsonText(jsonText) : null;
    const directText = parsed && typeof parsed === 'object'
      ? normalizeHistoryText(parsed.message || parsed.detail || parsed.error || parsed.reason || '')
      : '';
    const text = parsed ? (directText || extractFailureTextFromPayload(parsed) || truncateText(extractPlainTextDeep(parsed).map(value => normalizeHistoryText(value)).filter(Boolean).join('\n'), 2000)) : '';
    if (text) candidates.push(text);
  }
  for (const key of ['errorMessage', 'message', 'detail']) {
    const match = raw.match(new RegExp(`(?:^|\\s)${key}="((?:\\\\.|[^"])*)"`, 'i'));
    if (match) candidates.push(decodeLogQuotedValue(match[1]));
  }
  if (!candidates.length && /(?:unexpected status|Forbidden|channel affinity|AiMaMi)/i.test(raw)) {
    candidates.push(raw.replace(/^\S+\s+\w+\s+\[[^\]]+\]\s*/, '').trim());
  }
  const text = uniqueList(candidates
    .map(value => normalizeHistoryText(value))
    .filter(Boolean)
    .filter(value => !/^Request failed$/i.test(value)))
    .join('\n');
  return truncateText(text, 2000);
}

function scoreDesktopFailureLine(line, text, options = {}) {
  const raw = String(line || '');
  const failure = String(text || '');
  if (!failure) return 0;
  let score = 1;
  const threadId = isCodexThreadId(options.threadId) ? options.threadId : '';
  const turnId = typeof options.turnId === 'string' ? options.turnId : '';
  if (threadId && raw.includes(threadId)) score += 80;
  if (turnId && raw.includes(turnId)) score += 80;
  if (/Structured turn failed/i.test(failure)) score += 55;
  if (/unexpected status|Forbidden|channel affinity|AiMaMi/i.test(failure)) score += 45;
  if (/refresh token was revoked|log out and sign in again|access token could not be refreshed/i.test(failure)) score += 45;
  if (/Failed to generate thread title/i.test(raw) && /Structured turn failed/i.test(failure)) score += 25;
  if (/Conversation state not found|unknown conversation|Failed to write temporary index tree snapshot|remote\.upstream\.url/i.test(failure)) score -= 80;
  return score;
}

function recentCodexDesktopLogFiles(referenceMs = Date.now()) {
  return listCodexDesktopLogFiles()
    .map(file => {
      try {
        const stat = fs.statSync(file);
        return { file, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(item => item.mtimeMs >= referenceMs - GUI_FAILURE_LOG_RECENT_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 40)
    .map(item => item.file);
}

function findCodexDesktopFailureText(options = {}) {
  const threadId = isCodexThreadId(options.threadId) ? options.threadId : '';
  const turnId = typeof options.turnId === 'string' ? options.turnId : '';
  const startedMs = Date.parse(options.startedAt || '') || 0;
  const completedMs = Date.parse(options.completedAt || '') || Date.now();
  const minMs = startedMs ? startedMs - 60 * 1000 : completedMs - GUI_FAILURE_LOG_RECENT_MS;
  const maxMs = completedMs + 2 * 60 * 1000;
  const matches = [];
  for (const file of recentCodexDesktopLogFiles(completedMs)) {
    let lines;
    try {
      lines = readTailLinesWithLimit(file, GUI_FAILURE_LOG_SCAN_BYTES);
    } catch {
      continue;
    }
    for (const line of lines) {
      const lineMs = Date.parse(line.slice(0, 24));
      if (Number.isFinite(lineMs) && (lineMs < minMs || lineMs > maxMs)) continue;
      const text = extractDesktopLogFailureText(line);
      const score = scoreDesktopFailureLine(line, text, options);
      if (score >= 50) matches.push({ text, lineMs: Number.isFinite(lineMs) ? lineMs : 0, score });
    }
  }
  matches.sort((a, b) => b.score - a.score || b.lineMs - a.lineMs);
  return matches[0] ? matches[0].text : '';
}

function findStoredGuiFailureText(threadId, options = {}) {
  if (!isCodexThreadId(threadId)) return '';
  const rows = readCodexMiniState().guiFailureReports[threadId] || [];
  const turnId = typeof options.turnId === 'string' ? options.turnId : '';
  if (turnId) {
    const exact = [...rows].reverse().find(row => row.turnId === turnId && row.text);
    if (exact) return exact.text;
  }
  const completedMs = Date.parse(options.completedAt || '') || 0;
  if (completedMs) {
    const close = [...rows].reverse().find(row => {
      const rowMs = Date.parse(row.completedAt || row.capturedAt || '') || 0;
      return row.text && rowMs && Math.abs(rowMs - completedMs) <= GUI_FAILURE_LOG_RECENT_MS;
    });
    if (close) return close.text;
  }
  const latest = rows[rows.length - 1];
  return latest && latest.text ? latest.text : '';
}

function storeGuiFailureText(threadId, report = {}) {
  if (!isCodexThreadId(threadId)) return '';
  const text = truncateText(normalizeHistoryText(report.text || ''), 2000);
  if (!text || text === emptyCodexFailureText()) return '';
  const state = readCodexMiniState();
  const rows = state.guiFailureReports[threadId] || [];
  const turnId = typeof report.turnId === 'string' ? report.turnId : '';
  const completedAt = typeof report.completedAt === 'string' ? report.completedAt : '';
  const existingIndex = rows.findIndex(row => (turnId && row.turnId === turnId) || (completedAt && row.completedAt === completedAt && row.text === text));
  const row = {
    turnId,
    text,
    capturedAt: new Date().toISOString(),
    completedAt,
    source: typeof report.source === 'string' ? report.source : 'codex_desktop',
  };
  if (existingIndex >= 0) rows[existingIndex] = { ...rows[existingIndex], ...row };
  else rows.push(row);
  state.guiFailureReports[threadId] = rows.slice(-GUI_FAILURE_REPORT_LIMIT);
  writeCodexMiniState(state);
  return text;
}

function resolveFailureTextForTurn(threadId, options = {}) {
  const sessionText = normalizeHistoryText(options.failureText || '');
  if (sessionText) {
    storeGuiFailureText(threadId, { ...options, text: sessionText, source: 'codex_session' });
    return sessionText;
  }
  const storedText = findStoredGuiFailureText(threadId, options);
  if (storedText) return storedText;
  const desktopText = findCodexDesktopFailureText({ ...options, threadId });
  if (desktopText) return storeGuiFailureText(threadId, { ...options, text: desktopText, source: 'codex_desktop_log' }) || desktopText;
  return '';
}

function cleanUserHistoryText(value) {
  const text = normalizeHistoryText(value);
  const marker = '## My request for Codex:';
  const index = text.indexOf(marker);
  if (index >= 0) return normalizeHistoryText(text.slice(index + marker.length));
  return text;
}

function isPlaceholderThreadName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  return [
    '未命名线程',
    '未命名任务',
    '未命名',
    'untitled',
    'untitled thread',
    'new thread',
  ].includes(text);
}

function summarizeThreadTitle(value, maxLength = 34) {
  let text = cleanUserHistoryText(value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[key]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[token]')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/[#>*_[\]()~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}…`;
}

function listCodexDesktopLogFiles() {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(CODEX_DESKTOP_LOGS_DIR, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9._-]+\.log$/.test(entry.name)) continue;
    files.push(path.join(CODEX_DESKTOP_LOGS_DIR, entry.name));
    if (files.length >= 40) break;
  }
  return files;
}

function listCodexSessionDiskFiles() {
  const files = [];
  let years;
  try {
    years = fs.readdirSync(CODEX_SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const year of years) {
    if (!/^\d{4}$/.test(year.name) || !year.isDirectory() || year.isSymbolicLink()) continue;
    const yearDir = path.join(CODEX_SESSIONS_DIR, year.name);
    let months;
    try { months = fs.readdirSync(yearDir, { withFileTypes: true }); } catch { continue; }
    for (const month of months) {
      if (!/^\d{2}$/.test(month.name) || !month.isDirectory() || month.isSymbolicLink()) continue;
      const monthDir = path.join(yearDir, month.name);
      let sessions;
      try { sessions = fs.readdirSync(monthDir, { withFileTypes: true }); } catch { continue; }
      for (const session of sessions) {
        if (files.length >= CODEX_SEARCH_MAX_FILES) return files;
        if (!session.isFile() || session.isSymbolicLink() || !/^[A-Za-z0-9._-]+\.jsonl$/.test(session.name)) continue;
        files.push(path.join(monthDir, session.name));
      }
    }
  }
  for (const entry of years) {
    if (files.length >= CODEX_SEARCH_MAX_FILES) break;
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9._-]+\.jsonl$/.test(entry.name)) continue;
    files.push(path.join(CODEX_SESSIONS_DIR, entry.name));
  }
  return files;
}

function listCodexSessionFiles(options = {}) {
  const now = Date.now();
  if (!options.force && codexSessionFilesCache.files.length && now - codexSessionFilesCache.at <= CODEX_SESSION_FILE_CACHE_MS) {
    return codexSessionFilesCache.files;
  }
  const files = listCodexSessionDiskFiles();
  codexSessionFilesCache = { at: now, files };
  return files;
}

function threadIdFromSessionFile(file) {
  return (path.basename(file || '').match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i) || [])[1] || '';
}

function normalizeComparableMessage(value) {
  return cleanUserHistoryText(value).replace(/\s+/g, ' ').trim();
}

function findLatestCodexSessionFile(options = {}) {
  const excludeThreadId = isCodexThreadId(options.excludeThreadId) ? options.excludeThreadId : '';
  const afterMs = Number(options.afterMs) || 0;
  const expectedCwd = validLocalDirectory(options.cwd || '');
  const files = listCodexSessionFiles(afterMs ? { force: true } : {});
  let best = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const threadId = threadIdFromSessionFile(file);
      if (excludeThreadId && threadId === excludeThreadId) continue;
      if (afterMs && stat.mtimeMs < afterMs - 2500) continue;
      if (expectedCwd) {
        const metaCwd = validLocalDirectory(readSessionMeta(file).cwd || '');
        if (metaCwd !== expectedCwd) continue;
      }
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    } catch {
      // ignore disappearing files
    }
  }
  return best && best.file;
}

function findCodexSessionFileByName(name) {
  if (!name || name.includes('/') || name.includes('..')) return null;
  const files = listCodexSessionFiles();
  return files.find(file => path.basename(file) === name) || null;
}

function findCodexSessionFileByThreadId(threadId) {
  if (!isCodexThreadId(threadId)) return null;
  const files = listCodexSessionFiles();
  let best = null;
  for (const file of files) {
    if (!path.basename(file).includes(threadId)) continue;
    try {
      const stat = fs.statSync(file);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    } catch {}
  }
  return best && best.file;
}

function isCodexThreadId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value);
}

function codexThreadDeepLink(threadId) {
  if (!isCodexThreadId(threadId)) return null;
  // Codex desktop's own “Copy app link” action uses codex://threads/<id>.
  // The previous codex://local/<id> only brought the app forward on this build,
  // but did not navigate the visible UI, so paste could still hit the wrong thread.
  return `codex://threads/${threadId}`;
}

function codexNewThreadDeepLink(cwd = '') {
  const url = new URL('codex://threads/new');
  if (cwd) url.searchParams.set('path', cwd);
  return url.toString();
}

const platform = require('./src/platform')({
  rootDir: __dirname,
  delay,
  isCodexThreadId,
  codexThreadDeepLink,
  codexNewThreadDeepLink,
  CODEX_DEEPLINK_SETTLE_MS,
  CODEX_APP_FOCUS_SETTLE_MS,
  CODEX_CLICK_SETTLE_MS,
  CODEX_THREAD_SYNC_FRESH_MS,
});

function readThreadIndex() {
  let stat = null;
  try { stat = fs.statSync(CODEX_SESSION_INDEX); } catch {}
  if (
    stat &&
    threadIndexCache.byId &&
    threadIndexCache.mtimeMs === stat.mtimeMs &&
    threadIndexCache.size === stat.size
  ) {
    return new Map(threadIndexCache.byId);
  }
  const byId = new Map();
  try {
    const lines = fs.readFileSync(CODEX_SESSION_INDEX, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!item.id) continue;
        byId.set(item.id, {
          id: item.id,
          name: item.thread_name || '',
          updatedAt: item.updated_at || '',
        });
      } catch {}
    }
  } catch {}
  if (stat) threadIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, byId: new Map(byId) };
  return byId;
}

function findFirstCodexUserMessage(file, maxBytes = CODEX_TITLE_SCAN_BYTES) {
  let stat;
  try { stat = fs.statSync(file); } catch { return ''; }
  const cacheKey = `${file}:${fileCacheSignature(stat)}:${maxBytes}`;
  if (firstUserMessageCache.has(cacheKey)) return firstUserMessageCache.get(cacheKey);
  const limit = Math.min(stat.size, maxBytes);
  const chunkSize = 64 * 1024;
  const maxLineBytes = 2 * 1024 * 1024;
  let fd;
  let carry = '';
  let skippingLongLine = false;

  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(chunkSize);
    let offset = 0;
    while (offset < limit) {
      const bytes = fs.readSync(fd, buffer, 0, Math.min(chunkSize, limit - offset), offset);
      if (!bytes) break;
      offset += bytes;
      let text = buffer.toString('utf8', 0, bytes);

      if (skippingLongLine) {
        const newline = text.indexOf('\n');
        if (newline < 0) continue;
        text = text.slice(newline + 1);
        skippingLongLine = false;
      }

      carry += text;
      if (carry.length > maxLineBytes) {
        const newline = carry.indexOf('\n');
        if (newline < 0) {
          carry = '';
          skippingLongLine = true;
          continue;
        }
      }

      let newlineIndex;
      while ((newlineIndex = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newlineIndex);
        carry = carry.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const payload = item.payload || {};
        if (item.type === 'event_msg' && payload.type === 'user_message') {
          const title = summarizeThreadTitle(payload.message || '');
          if (title) return boundedSet(firstUserMessageCache, cacheKey, title);
        }
      }
    }

    if (carry.trim() && carry.length <= maxLineBytes) {
      try {
        const item = JSON.parse(carry);
        const payload = item.payload || {};
        if (item.type === 'event_msg' && payload.type === 'user_message') {
          return boundedSet(firstUserMessageCache, cacheKey, summarizeThreadTitle(payload.message || ''));
        }
      } catch {}
    }
  } catch {
    return '';
  } finally {
    if (typeof fd === 'number') {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return boundedSet(firstUserMessageCache, cacheKey, '');
}

function readSessionMeta(file) {
  let stat = null;
  try { stat = fs.statSync(file); } catch {}
  const cacheKey = stat ? `${file}:${fileCacheSignature(stat)}` : '';
  if (cacheKey && sessionMetaCache.has(cacheKey)) return sessionMetaCache.get(cacheKey);
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const lines = buffer.toString('utf8', 0, bytes).split('\n').filter(Boolean).slice(0, 80);
      for (const line of lines) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (item.type === 'session_meta' && item.payload) return cacheKey ? boundedSet(sessionMetaCache, cacheKey, item.payload) : item.payload;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return cacheKey ? boundedSet(sessionMetaCache, cacheKey, {}) : {};
}

function userMessageMatchScore(file, sinceMs = 0, text = '') {
  const expected = normalizeComparableMessage(text);
  const items = readJsonlTailObjects(file, CODEX_TITLE_SCAN_BYTES);
  let score = 0;
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type !== 'event_msg' || payload.type !== 'user_message') continue;
    const t = Date.parse(item.timestamp || '');
    if (sinceMs && Number.isFinite(t) && t < sinceMs - 2500) continue;
    const actual = normalizeComparableMessage(payload.message || '');
    if (!actual && expected) continue;
    score = Math.max(score, 10);
    if (Number.isFinite(t)) score += Math.max(0, Math.min(25, Math.round((t - sinceMs) / 1000) + 20));
    if (expected && actual) {
      if (actual === expected) score += 100;
      else if (actual.includes(expected) || expected.includes(actual)) score += 70;
    }
  }
  return score;
}

function findCodexSessionFileForNewSend(options = {}) {
  const sinceMs = Number(options.sinceMs) || 0;
  const text = typeof options.text === 'string' ? options.text : '';
  const expectedCwd = validLocalDirectory(options.cwd || '');
  const excludeThreadId = isCodexThreadId(options.excludeThreadId) ? options.excludeThreadId : '';
  const files = listCodexSessionFiles({ force: true });
  let best = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const threadId = threadIdFromSessionFile(file);
      if (excludeThreadId && threadId === excludeThreadId) continue;
      if (sinceMs && stat.mtimeMs < sinceMs - 2500) continue;
      let score = userMessageMatchScore(file, sinceMs, text);
      if (score <= 0 && text.trim()) continue;
      const metaCwd = validLocalDirectory(readSessionMeta(file).cwd || '');
      if (expectedCwd) {
        if (metaCwd !== expectedCwd) continue;
        score += 35;
      }
      score += Math.max(0, Math.min(20, Math.round((stat.mtimeMs - sinceMs) / 1000) + 10));
      if (!best || score > best.score || (score === best.score && stat.mtimeMs > best.mtimeMs)) {
        best = { file, score, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // ignore disappearing files
    }
  }
  return best && best.file;
}

async function waitForCodexSessionFileForNewSend(options = {}, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let file = null;
  while (Date.now() <= deadline) {
    file = findCodexSessionFileForNewSend(options);
    if (file) return file;
    await delay(220);
  }
  return findCodexSessionFileForNewSend(options);
}

function sessionHasUserMessage(file, text, sinceMs = 0) {
  if (!file || !fs.existsSync(file)) return false;
  const target = normalizeComparableMessage(text);
  if (!target) return false;
  const items = readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES);
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type !== 'event_msg' || payload.type !== 'user_message') continue;
    const itemTime = Date.parse(item.timestamp || '') || 0;
    if (sinceMs && itemTime && itemTime < sinceMs - 1200) continue;
    const message = normalizeComparableMessage(payload.message || '');
    if (!message) continue;
    if (message === target || message.includes(target) || target.includes(message)) return true;
  }
  return false;
}

async function waitForUserMessageInSession(file, text, sinceMs = 0, timeoutMs = CODEX_SEND_CONFIRM_TIMEOUT_MS) {
  if (!timeoutMs || !file || !String(text || '').trim()) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (sessionHasUserMessage(file, text, sinceMs)) return true;
    await delay(180);
  }
  return false;
}

function readJsonlTailObjects(file, maxBytes) {
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  const start = Math.max(0, stat.size - maxBytes);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (typeof fd === 'number') {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function summarizeCodexRuntimeItems(items, stat = null) {
  let status = 'idle';
  let active = false;
  let startedAt = '';
  let completedAt = '';
  let updatedAt = stat ? new Date(stat.mtimeMs).toISOString() : '';
  let turnId = '';
  let sawRuntimeActivity = false;
  let sawTaskMarker = false;

  for (const item of items) {
    const payload = item.payload || {};
    if (item.timestamp) updatedAt = item.timestamp;
    if (item.type === 'response_item' || (item.type === 'event_msg' && payload.type && !String(payload.type).startsWith('task_'))) {
      sawRuntimeActivity = true;
    }
    if (item.type === 'turn_context' && payload.turn_id) turnId = payload.turn_id;
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      sawTaskMarker = true;
      status = 'running';
      active = true;
      startedAt = item.timestamp || startedAt;
      completedAt = '';
      turnId = payload.turn_id || turnId;
      updatedAt = item.timestamp || updatedAt;
    }
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      sawTaskMarker = true;
      status = 'complete';
      active = false;
      completedAt = item.timestamp || completedAt;
      updatedAt = item.timestamp || updatedAt;
    }
    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      sawTaskMarker = true;
      status = 'error';
      active = false;
      completedAt = item.timestamp || completedAt;
      turnId = payload.turn_id || turnId;
      updatedAt = item.timestamp || updatedAt;
    }
  }

  return { status, active, startedAt, completedAt, updatedAt, turnId, sawRuntimeActivity, sawTaskMarker };
}

function quickCodexRuntimeFromFile(file, stat = null) {
  let fileStat = stat;
  if (!fileStat) {
    try { fileStat = fs.statSync(file); } catch { fileStat = null; }
  }
  const cacheKey = fileStat ? `${file}:${fileCacheSignature(fileStat)}` : '';
  if (cacheKey && runtimeSummaryCache.has(cacheKey)) return runtimeSummaryCache.get(cacheKey);
  const isFresh = fileStat ? Date.now() - fileStat.mtimeMs <= CODEX_RUNTIME_STALE_MS : false;
  let runtime = summarizeCodexRuntimeItems(readJsonlTailObjects(file, CODEX_ACTIVITY_TAIL_BYTES), fileStat);

  if (
    runtime.status === 'idle' &&
    runtime.sawRuntimeActivity &&
    !runtime.sawTaskMarker &&
    isFresh &&
    fileStat &&
    fileStat.size > CODEX_ACTIVITY_TAIL_BYTES
  ) {
    runtime = summarizeCodexRuntimeItems(readJsonlTailObjects(file, CODEX_ACTIVITY_LOOKBACK_BYTES), fileStat);
  }

  if (runtime.status === 'idle' && runtime.sawRuntimeActivity && !runtime.sawTaskMarker && isFresh) {
    runtime.status = 'running';
    runtime.active = true;
  }
  if (runtime.status === 'running' && fileStat && !isFresh) {
    runtime.status = 'idle';
    runtime.active = false;
  }

  const { status, active, startedAt, completedAt, updatedAt, turnId } = runtime;
  return cacheKey
    ? boundedSet(runtimeSummaryCache, cacheKey, { status, active, startedAt, completedAt, updatedAt, turnId }, 600)
    : { status, active, startedAt, completedAt, updatedAt, turnId };
}

function displayPathName(cwd) {
  if (!cwd) return '对话';
  const normalized = path.normalize(cwd);
  if (normalized === os.homedir()) return '~';
  if (normalized === path.parse(normalized).root) return normalized;
  return path.basename(normalized) || normalized;
}

function classifyThreadProject(cwd) {
  const normalized = cwd ? path.normalize(cwd) : '';
  const codexScratchRoot = path.join(os.homedir(), 'Documents', 'Codex');
  const relativeToScratch = normalized ? path.relative(codexScratchRoot, normalized) : '';
  const isGeneratedProjectless = Boolean(
    normalized &&
    relativeToScratch &&
    !relativeToScratch.startsWith('..') &&
    !path.isAbsolute(relativeToScratch) &&
    /^\d{4}-\d{2}-\d{2}(?:$|[\\/])/.test(relativeToScratch)
  );

  if (!normalized || isGeneratedProjectless) {
    return {
      isProjectThread: false,
      projectKey: 'conversation',
      projectName: '对话',
      projectPath: '',
    };
  }

  return {
    isProjectThread: true,
    projectKey: normalized,
    projectName: displayPathName(normalized),
    projectPath: normalized,
  };
}

function listCodexThreads(limit = 80) {
  const normalizedLimit = Math.max(1, Math.min(160, Number(limit) || 80));
  const cacheKey = String(normalizedLimit);
  const cached = codexThreadListCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= CODEX_THREAD_LIST_CACHE_MS) return cached.threads;
  const miniState = readCodexMiniState();
  const pinnedThreadIds = new Set(miniState.pinnedThreadIds || []);
  const archivedThreadIds = new Set(miniState.archivedThreadIds || []);
  const titleOverrides = miniState.titleOverrides || {};
  const byId = readThreadIndex();
  for (const file of listCodexSessionFiles()) {
    const match = path.basename(file).match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i);
    if (!match) continue;
    const id = match[1];
    try {
      const stat = fs.statSync(file);
      const meta = readSessionMeta(file);
      const runtime = quickCodexRuntimeFromFile(file, stat);
      const project = classifyThreadProject(meta.cwd || '');
      const existing = byId.get(id) || { id, name: '', updatedAt: '' };
      const fallbackName = isPlaceholderThreadName(existing.name) ? findFirstCodexUserMessage(file) : '';
      existing.name = isPlaceholderThreadName(existing.name) ? (fallbackName || '未命名任务') : existing.name;
      existing.nameSource = fallbackName && existing.name === fallbackName ? 'first_user_message' : 'index';
      const override = titleOverrides[id];
      if (override && typeof override.name === 'string' && override.name.trim()) {
        const overrideTime = Date.parse(override.renamedAt || '') || 0;
        const indexTime = Date.parse(existing.updatedAt || '') || 0;
        if (!indexTime || !overrideTime || indexTime <= overrideTime + 2000 || existing.name === override.name || isPlaceholderThreadName(existing.name)) {
          existing.name = override.name.trim();
          existing.nameSource = 'codex_mini_override';
        }
      }
      existing.sessionFile = path.basename(file);
      existing.mtimeMs = stat.mtimeMs;
      existing.updatedAt = existing.updatedAt || meta.timestamp || new Date(stat.mtimeMs).toISOString();
      existing.effectiveUpdatedMs = Math.max(Date.parse(existing.updatedAt) || 0, stat.mtimeMs || 0);
      existing.cwd = meta.cwd || '';
      existing.source = meta.source || '';
      existing.threadSource = meta.thread_source || '';
      existing.runtimeStatus = runtime.status;
      existing.runtimeActive = runtime.active;
      existing.runtimeStartedAt = runtime.startedAt;
      existing.runtimeCompletedAt = runtime.completedAt;
      existing.runtimeUpdatedAt = runtime.updatedAt;
      existing.runtimeTurnId = runtime.turnId;
      existing.pinned = pinnedThreadIds.has(id);
      Object.assign(existing, project);
      byId.set(id, existing);
    } catch {}
  }
  const threads = [...byId.values()]
    .filter(item => item.sessionFile && !archivedThreadIds.has(item.id))
    .map(item => {
      const effectiveUpdatedMs = item.effectiveUpdatedMs || Math.max(Date.parse(item.updatedAt) || 0, item.mtimeMs || 0);
      return { ...item, effectiveUpdatedMs, effectiveUpdatedAt: new Date(effectiveUpdatedMs).toISOString() };
    })
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.effectiveUpdatedMs - a.effectiveUpdatedMs)
    .slice(0, normalizedLimit);
  boundedSet(codexThreadListCache, cacheKey, { at: Date.now(), threads }, 20);
  return threads;
}

function listArchivedCodexThreads(limit = 80) {
  const normalizedLimit = Math.max(1, Math.min(160, Number(limit) || 80));
  const miniState = readCodexMiniState();
  const archivedThreadIds = [...new Set((miniState.archivedThreadIds || []).filter(isCodexThreadId))];
  if (!archivedThreadIds.length) return [];
  const archivedSet = new Set(archivedThreadIds);
  const titleOverrides = miniState.titleOverrides || {};
  const byId = readThreadIndex();
  for (const file of listCodexSessionFiles()) {
    const match = path.basename(file).match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i);
    if (!match || !archivedSet.has(match[1])) continue;
    const id = match[1];
    try {
      const stat = fs.statSync(file);
      const meta = readSessionMeta(file);
      const runtime = quickCodexRuntimeFromFile(file, stat);
      const project = classifyThreadProject(meta.cwd || '');
      const existing = byId.get(id) || { id, name: '', updatedAt: '' };
      const fallbackName = isPlaceholderThreadName(existing.name) ? findFirstCodexUserMessage(file) : '';
      existing.name = isPlaceholderThreadName(existing.name) ? (fallbackName || '未命名任务') : existing.name;
      const override = titleOverrides[id];
      if (override && typeof override.name === 'string' && override.name.trim()) existing.name = override.name.trim();
      existing.sessionFile = path.basename(file);
      existing.mtimeMs = stat.mtimeMs;
      existing.updatedAt = existing.updatedAt || meta.timestamp || new Date(stat.mtimeMs).toISOString();
      existing.effectiveUpdatedMs = Math.max(Date.parse(existing.updatedAt) || 0, stat.mtimeMs || 0);
      existing.cwd = meta.cwd || '';
      existing.source = meta.source || '';
      existing.threadSource = meta.thread_source || '';
      existing.runtimeStatus = runtime.status;
      existing.runtimeActive = runtime.active;
      Object.assign(existing, project);
      byId.set(id, existing);
    } catch {}
  }
  return archivedThreadIds
    .map(id => {
      const item = byId.get(id) || { id, name: '已归档任务', updatedAt: '', effectiveUpdatedMs: 0 };
      const project = item.projectName ? {} : classifyThreadProject(item.cwd || '');
      const effectiveUpdatedMs = item.effectiveUpdatedMs || Math.max(Date.parse(item.updatedAt) || 0, item.mtimeMs || 0);
      return { ...item, ...project, archived: true, effectiveUpdatedMs, effectiveUpdatedAt: effectiveUpdatedMs ? new Date(effectiveUpdatedMs).toISOString() : '' };
    })
    .sort((a, b) => b.effectiveUpdatedMs - a.effectiveUpdatedMs)
    .slice(0, normalizedLimit);
}

function appServerThreadRuntimeStatus(status = {}) {
  if (status.type === 'active') return { status: 'running', active: true };
  if (status.type === 'systemError') return { status: 'error', active: false };
  return { status: 'idle', active: false };
}

function normalizeAppServerThreads(rows = []) {
  const miniState = readCodexMiniState();
  const pinnedThreadIds = new Set(miniState.pinnedThreadIds || []);
  const titleOverrides = miniState.titleOverrides || {};
  return rows.map(row => {
    const updatedMs = Math.max(0, Number(row.recencyAt || row.updatedAt || row.createdAt || 0) * 1000);
    const updatedAt = updatedMs ? new Date(updatedMs).toISOString() : '';
    const cwd = String(row.cwd || '');
    const project = classifyThreadProject(cwd);
    const runtime = appServerThreadRuntimeStatus(row.status || {});
    const overrideName = String(titleOverrides[row.id]?.name || '').trim();
    const previewName = summarizeThreadTitle(cleanUserHistoryText(row.preview || ''), 50);
    const name = String(row.name || overrideName || previewName || '未命名任务').trim();
    return {
      id: row.id,
      name,
      nameSource: row.name ? 'app_server' : overrideName ? 'local_override' : 'preview',
      preview: row.preview || '',
      sessionFile: row.path ? path.basename(row.path) : '',
      cwd,
      source: typeof row.source === 'string' ? row.source : JSON.stringify(row.source || {}),
      threadSource: typeof row.threadSource === 'string' ? row.threadSource : JSON.stringify(row.threadSource || {}),
      updatedAt,
      effectiveUpdatedAt: updatedAt,
      effectiveUpdatedMs: updatedMs,
      runtimeStatus: runtime.status,
      runtimeActive: runtime.active,
      runtimeStartedAt: '',
      runtimeCompletedAt: '',
      runtimeUpdatedAt: updatedAt,
      runtimeTurnId: codexAppServer.runtimeForThread(row.id)?.activeTurnId || '',
      pinned: typeof row.isPinned === 'boolean' ? row.isPinned : pinnedThreadIds.has(row.id),
      canAcceptDirectInput: row.canAcceptDirectInput,
      ...project,
    };
  }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.effectiveUpdatedMs - a.effectiveUpdatedMs);
}

async function handleThreads(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const limit = Math.max(1, Math.min(160, Number(url.searchParams.get('limit')) || 80));
  try {
    const rows = await codexAppServer.listThreads({ limit });
    const threads = normalizeAppServerThreads(rows).slice(0, limit);
    return json(res, 200, {
      ok: true,
      transport: 'app-server',
      threads,
      ...activeDesktopThreadHint(threads),
    });
  } catch (error) {
    const threads = listCodexThreads(limit);
    return json(res, 200, {
      ok: true,
      transport: 'session-files',
      appServerError: error.message || String(error),
      threads,
      ...activeDesktopThreadHint(threads),
    });
  }
}

function activeDesktopThreadHint(threads = []) {
  const activeThreads = threads
    .filter(item => item && item.id && (item.runtimeActive || item.runtimeStatus === 'running'))
    .sort((left, right) => (Date.parse(right.runtimeUpdatedAt || right.updatedAt || '') || 0)
      - (Date.parse(left.runtimeUpdatedAt || left.updatedAt || '') || 0));
  if (activeThreads.length) {
    return { activeThreadId: activeThreads[0].id, activeThreadSource: 'running-thread' };
  }

  // Session records are updated by the desktop app while it is producing a turn.
  // Do not use an idle recent record, otherwise browsing an older mobile task would be overwritten.
  const latestFile = findLatestCodexSessionFile();
  if (!latestFile) return { activeThreadId: '', activeThreadSource: '' };
  try {
    const stat = fs.statSync(latestFile);
    const runtime = quickCodexRuntimeFromFile(latestFile, stat);
    const threadId = threadIdFromSessionFile(latestFile);
    if (threadId && runtime.active && threads.some(item => item.id === threadId)) {
      return { activeThreadId: threadId, activeThreadSource: 'active-session' };
    }
  } catch {
    // A session file can rotate while the list endpoint is being assembled.
  }
  return { activeThreadId: '', activeThreadSource: '' };
}

async function handleArchivedThreads(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const limit = Math.max(1, Math.min(160, Number(url.searchParams.get('limit')) || 80));
  return json(res, 200, {
    ok: true,
    transport: 'local-state',
    threads: listArchivedCodexThreads(limit),
  });
}

async function listWorkspaceThreads(limit = 160) {
  try {
    const rows = await codexAppServer.listThreads({ limit });
    return { transport: 'app-server', threads: normalizeAppServerThreads(rows).slice(0, limit) };
  } catch (error) {
    return {
      transport: 'session-files',
      appServerError: error.message || String(error),
      threads: listCodexThreads(limit),
    };
  }
}

function existingProjectCwds(threads = []) {
  const values = [__dirname, ...threads.map(item => item?.projectPath || item?.cwd || '')];
  const found = new Set();
  for (const value of values) {
    const cwd = String(value || '').trim();
    if (!cwd || found.has(cwd)) continue;
    try {
      if (fs.statSync(cwd).isDirectory()) found.add(cwd);
    } catch {}
  }
  return [...found].slice(0, 20);
}

function normalizePluginRows(payload = {}) {
  const plugins = [];
  const marketplaces = Array.isArray(payload?.marketplaces) ? payload.marketplaces : [];
  for (const marketplace of marketplaces) {
    const marketplaceName = String(marketplace?.interface?.displayName || marketplace?.name || '插件市场').trim();
    for (const plugin of Array.isArray(marketplace?.plugins) ? marketplace.plugins : []) {
      if (!plugin || !plugin.id) continue;
      const details = plugin.interface && typeof plugin.interface === 'object' ? plugin.interface : {};
      plugins.push({
        id: String(plugin.id),
        name: String(details.displayName || plugin.name || plugin.id),
        description: String(details.shortDescription || ''),
        category: String(details.category || ''),
        marketplace: marketplaceName,
        installed: plugin.installed === true,
        enabled: plugin.enabled === true,
        availability: String(plugin.availability || ''),
        version: String(plugin.localVersion || plugin.version || ''),
        brandColor: /^#[0-9a-f]{6}$/i.test(String(details.brandColor || '')) ? String(details.brandColor) : '',
      });
    }
  }
  return plugins.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name, 'zh-CN'));
}

function normalizeSkillRows(rows = []) {
  const skills = [];
  const seen = new Set();
  for (const row of rows) {
    for (const skill of Array.isArray(row?.skills) ? row.skills : []) {
      const name = String(skill?.name || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const details = skill.interface && typeof skill.interface === 'object' ? skill.interface : {};
      skills.push({
        name,
        displayName: String(details.displayName || name),
        description: String(details.shortDescription || skill.description || ''),
        enabled: skill.enabled !== false,
        scope: String(skill.scope || ''),
      });
    }
  }
  return skills.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
}

function normalizeAppRows(rows = []) {
  return rows
    .filter(row => row && row.id)
    .map(row => ({
      id: String(row.id),
      name: String(row.name || row.id),
      description: String(row.description || ''),
      accessible: row.isAccessible === true,
      enabled: row.isEnabled === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function normalizeTomlKey(raw = '') {
  const value = String(raw || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function listConfiguredMcpServers() {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const text = fs.readFileSync(configPath, 'utf8');
    const seen = new Set();
    const servers = [];
    for (const match of text.matchAll(/^\s*\[mcp_servers\.([^\]\r\n]+)\]\s*$/gm)) {
      const name = normalizeTomlKey(match[1]);
      if (name.includes('.')) continue;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      servers.push({ name, enabled: true, source: 'config' });
    }
    return servers.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } catch {
    return [];
  }
}

async function handlePlugins(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const workspace = await listWorkspaceThreads(160);
  const cwds = existingProjectCwds(workspace.threads);
  const results = await Promise.allSettled([
    codexAppServer.listPlugins(),
    codexAppServer.listSkills(cwds, { forceReload: false }),
    codexAppServer.listApps({ forceRefetch: false }),
  ]);
  const [pluginResult, skillResult, appResult] = results;
  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason?.message || String(result.reason || '读取失败'));
  return json(res, 200, {
    ok: true,
    transport: 'app-server',
    projectCwds: cwds.map(cwd => ({ cwd, name: displayPathName(cwd) })),
    plugins: pluginResult.status === 'fulfilled' ? normalizePluginRows(pluginResult.value) : [],
    skills: skillResult.status === 'fulfilled' ? normalizeSkillRows(skillResult.value) : [],
    apps: appResult.status === 'fulfilled' ? normalizeAppRows(appResult.value) : [],
    mcpServers: listConfiguredMcpServers(),
    errors,
  });
}

function gitCommandError(message = 'Git 参数无效。') {
  return new Error(message);
}

// git pathspec 白名单：仅允许仓库内相对路径，拒绝绝对路径、盘符与 .. 穿越
function isSafeGitPathSpec(value) {
  const spec = String(value || '');
  if (!spec || spec.includes('\0')) return false;
  if (path.isAbsolute(spec) || /^[a-zA-Z]:/.test(spec)) return false;
  return !spec.split(/[\\/]+/).includes('..');
}

function normalizeGitCwd(value) {
  const cwd = validLocalDirectory(String(value || '').trim());
  if (!cwd) throw gitCommandError('Git 工作目录无效。');
  return cwd;
}

function normalizeGitCommandArgs(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw gitCommandError();
  }
  if (args.length < 3 || args[0] !== '-C') throw gitCommandError();

  const cwd = normalizeGitCwd(args[1]);
  const command = args[2];
  const rest = args.slice(3);
  const exact = (...expected) => rest.length === expected.length && rest.every((arg, index) => arg === expected[index]);
  const branchArg = value => {
    const branch = normalizeGitBranch(value);
    return branch && branch === value ? branch : '';
  };

  switch (command) {
    case 'rev-parse':
      if (exact('--show-toplevel') || exact('--abbrev-ref', '--symbolic-full-name', '@{u}')) return ['-C', cwd, command, ...rest];
      break;
    case 'branch':
      if (exact('--show-current')) return ['-C', cwd, command, ...rest];
      break;
    case 'remote':
      if (exact('get-url', 'origin')) return ['-C', cwd, command, ...rest];
      break;
    case 'status':
      if (exact('--short') || exact('--porcelain')) return ['-C', cwd, command, ...rest];
      break;
    case 'diff':
      if (exact('--numstat', 'HEAD')) return ['-C', cwd, command, ...rest];
      if (rest.length === 2 && rest[0] === '--numstat' && rest[1].startsWith('HEAD..')) {
        const branch = branchArg(rest[1].slice('HEAD..'.length));
        if (branch) return ['-C', cwd, command, '--numstat', `HEAD..${branch}`];
      }
      // 只读 diff 查看：整仓或指定相对路径文件（供手机端工作区变更面板使用）
      if (exact('HEAD')) return ['-C', cwd, command, 'HEAD'];
      if (rest.length === 3 && rest[0] === 'HEAD' && rest[1] === '--' && isSafeGitPathSpec(rest[2])) {
        return ['-C', cwd, command, 'HEAD', '--', rest[2]];
      }
      break;
    case 'for-each-ref':
      if (exact('--format=%(refname:short)', 'refs/heads', 'refs/remotes') || exact('--format=%(refname:short)', 'refs/heads')) {
        return ['-C', cwd, command, ...rest];
      }
      break;
    case 'log':
      if (exact('-1', '--format=%H%x00%s%x00%an%x00%ad', '--date=iso-strict')) return ['-C', cwd, command, ...rest];
      if (rest.length === 4 && rest[0] === '-1' && rest[1] === '--format=%H%x00%s%x00%ad' && rest[2] === '--date=iso-strict') {
        const branch = branchArg(rest[3]);
        if (branch) return ['-C', cwd, command, '-1', '--format=%H%x00%s%x00%ad', '--date=iso-strict', branch];
      }
      break;
    case 'ls-files':
      if (exact('--others', '--exclude-standard', '-z')) return ['-C', cwd, command, ...rest];
      break;
    case 'switch': {
      const branch = rest.length === 3 && rest[0] === '--quiet' && rest[1] === '--' ? branchArg(rest[2]) : '';
      if (branch) return ['-C', cwd, command, '--quiet', '--', branch];
      break;
    }
    case 'add':
      if (exact('--all')) return ['-C', cwd, command, ...rest];
      break;
    case 'commit':
      if (rest.length === 2 && rest[0] === '-m' && rest[1].trim() && rest[1].length <= 180 && !/[\r\n]/.test(rest[1])) {
        return ['-C', cwd, command, '-m', rest[1]];
      }
      break;
    case 'push':
      if (rest.length === 0) return ['-C', cwd, command];
      break;
  }

  throw gitCommandError();
}

function runGit(args, options = {}) {
  let safeArgs;
  try {
    safeArgs = normalizeGitCommandArgs(args);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', safeArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('git 命令超时。'));
    }, Math.max(1000, Number(options.timeoutMs) || 8000));
    child.stdout.on('data', chunk => { stdout += String(chunk || ''); });
    child.stderr.on('data', chunk => { stderr += String(chunk || ''); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code === 0) return finish(null, { stdout, stderr });
      const error = new Error(stderr.trim() || `git exited with code ${code}`);
      error.code = code;
      finish(error);
    });
  });
}

function parseGitStatusRows(output = '') {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(0, ENVIRONMENT_MAX_FILES)
    .map(line => {
      const status = line.slice(0, 2).trim() || '?';
      const pathText = line.slice(3).trim() || line.trim();
      return { status, path: pathText };
    });
}

function parseGitNumstat(output = '') {
  return String(output || '').split(/\r?\n/).reduce((summary, line) => {
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) return summary;
    summary.additions += match[1] === '-' ? 0 : Number(match[1]);
    summary.deletions += match[2] === '-' ? 0 : Number(match[2]);
    summary.files += 1;
    return summary;
  }, { additions: 0, deletions: 0, files: 0 });
}

function countGitStatusRows(output = '') {
  return String(output || '').split(/\r?\n/).filter(Boolean).length;
}

function countTextFileLines(buffer) {
  if (!buffer?.length || buffer.includes(0)) return null;
  let lines = 0;
  for (const byte of buffer) {
    if (byte === 10) lines += 1;
  }
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
}

async function readUntrackedGitChanges(root) {
  let output = '';
  try {
    const result = await runGit(['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], { timeoutMs: 10000 });
    output = String(result.stdout || '');
  } catch {
    return { additions: 0, files: 0 };
  }

  const files = output.split('\0').filter(relativePath => (
    relativePath &&
    !path.isAbsolute(relativePath) &&
    !relativePath.split(/[\\/]+/).includes('..')
  )).length;
  return { additions: 0, files };
}

function normalizeGitBranch(value = '') {
  const branch = String(value || '').trim();
  if (!branch || branch.length > 240 || branch.startsWith('-')) return '';
  try {
    if (branch.includes('..') || branch.includes('\\0')) return '';
    return branch;
  } catch {
    return '';
  }
}

async function readGitEnvironment(cwd, compareBranch = '') {
  const environment = {
    cwd,
    name: displayPathName(cwd),
    git: {
      available: false,
      branch: '',
      remote: '',
      changes: { additions: 0, deletions: 0, files: 0 },
      files: [],
      branches: [],
      localBranches: [],
      lastCommit: null,
    },
    compare: null,
  };
  let root;
  try {
    const result = await runGit(['-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 8000 });
    root = String(result.stdout || '').trim();
  } catch {
    return environment;
  }
  if (!root) return environment;

  const results = await Promise.allSettled([
    runGit(['-C', root, 'branch', '--show-current'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'remote', 'get-url', 'origin'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'status', '--short'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'diff', '--numstat', 'HEAD'], { timeoutMs: 10000 }),
    readUntrackedGitChanges(root),
    runGit(['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { timeoutMs: 8000 }),
    runGit(['-C', root, 'log', '-1', '--format=%H%x00%s%x00%an%x00%ad', '--date=iso-strict'], { timeoutMs: 8000 }),
  ]);
  const valueAt = index => results[index]?.status === 'fulfilled' ? String(results[index].value.stdout || '').trim() : '';
  const commitParts = valueAt(6).split('\\0');
  const branches = valueAt(5).split(/\r?\n/).map(normalizeGitBranch).filter(Boolean);
  const localBranches = valueAt(7).split(/\r?\n/).map(normalizeGitBranch).filter(Boolean);
  const trackedChanges = parseGitNumstat(valueAt(3));
  const untrackedChanges = results[4]?.status === 'fulfilled' ? results[4].value : { additions: 0, files: 0 };
  environment.git = {
    available: true,
    root,
    branch: valueAt(0),
    remote: valueAt(1),
    changes: {
      additions: trackedChanges.additions + (Number(untrackedChanges?.additions) || 0),
      deletions: trackedChanges.deletions,
      files: Math.max(trackedChanges.files, countGitStatusRows(valueAt(2))),
    },
    files: parseGitStatusRows(valueAt(2)),
    branches: [...new Set(branches)].slice(0, ENVIRONMENT_MAX_BRANCHES),
    localBranches: [...new Set(localBranches)].slice(0, ENVIRONMENT_MAX_BRANCHES),
    lastCommit: commitParts[0] ? {
      hash: commitParts[0],
      subject: commitParts[1] || '',
      author: commitParts[2] || '',
      date: commitParts[3] || '',
    } : null,
  };

  const compare = normalizeGitBranch(compareBranch);
  if (compare && environment.git.branches.includes(compare) && compare !== environment.git.branch) {
    const compareResults = await Promise.allSettled([
      runGit(['-C', root, 'diff', '--numstat', `HEAD..${compare}`], { timeoutMs: 10000 }),
      runGit(['-C', root, 'log', '-1', '--format=%H%x00%s%x00%ad', '--date=iso-strict', compare], { timeoutMs: 8000 }),
    ]);
    const compareStat = compareResults[0]?.status === 'fulfilled' ? parseGitNumstat(compareResults[0].value.stdout) : null;
    const compareCommit = compareResults[1]?.status === 'fulfilled' ? String(compareResults[1].value.stdout || '').trim().split('\\0') : [];
    environment.compare = {
      branch: compare,
      changes: compareStat || { additions: 0, deletions: 0, files: 0 },
      lastCommit: compareCommit[0] ? { hash: compareCommit[0], subject: compareCommit[1] || '', date: compareCommit[2] || '' } : null,
    };
  }
  return environment;
}

async function handleEnvironment(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let workspace = { threads: [] };
  try { workspace = await listWorkspaceThreads(160); } catch {}
  const projects = existingProjectCwds(workspace.threads);
  const requestedCwd = String(url.searchParams.get('cwd') || '').trim();
  const cwd = requestedCwd && projects.includes(requestedCwd) ? requestedCwd : (projects[0] || __dirname);
  const compareBranch = url.searchParams.get('compare') || '';
  const gitEnvironment = await readGitEnvironment(cwd, compareBranch);
  const git = gitEnvironment.git || { available: false, branches: [], files: [], changes: { additions: 0, deletions: 0, files: 0 } };
  let cdp = null;
  if (platform.cdpStatus) {
    try { cdp = await platform.cdpStatus(); } catch (error) { cdp = { available: false, code: error.code || 'CDP_STATUS_FAILED', message: error.message || '浏览器状态读取失败。' }; }
  }
  const appServer = codexAppServer.status();
  const processes = [
    { id: `node-${process.pid}`, label: `${APP_NAME} 服务`, command: 'node server.js', pid: process.pid, status: 'running', cwd: __dirname },
  ];
  if (appServer.pid) processes.push({ id: `codex-${appServer.pid}`, label: 'Codex App Server', command: appServer.executable || 'codex', pid: appServer.pid, status: appServer.available ? 'running' : 'stopped', cwd });
  return json(res, 200, {
    ok: true,
    transport: 'app-server',
    cwd,
    name: displayPathName(cwd),
    git,
    compare: gitEnvironment.compare,
    processes,
    browser: {
      available: Boolean(cdp?.available),
      port: Number(cdp?.port) || 9222,
      screenshot: {
        available: Boolean(cdp?.available && typeof platform.captureCdpScreenshot === 'function'),
        maxAgeMs: SCREENSHOT_CACHE_TTL_MS,
      },
      message: cdp?.available ? 'CDP 浏览器已连接' : '当前没有连接桌面浏览器',
      tabs: [],
    },
    sources: [
      { name: '当前项目', path: cwd, kind: 'workspace' },
      { name: '手机远程页面', path: '/public/index.html', kind: 'web' },
      { name: '本机服务', path: '/server.js', kind: 'server' },
    ],
    capabilities: {
      canCompare: Boolean(git.available),
      canCommit: Boolean(git.available && git.branch),
      canPush: Boolean(git.available && git.branch && git.remote),
      canCheckout: Boolean(git.available && (git.localBranches || git.branches).length),
      canDownload: Boolean(projects.length),
      downloadLimit: MAX_DOWNLOAD_BYTES,
    },
    limitation: '提交、推送和切换分支都会在这台电脑上执行，并要求手机端再次确认。',
    updatedAt: new Date().toISOString(),
  });
}

async function resolveGitActionTarget(cwdValue = '') {
  let workspace = { threads: [] };
  try { workspace = await listWorkspaceThreads(160); } catch {}
  const projects = existingProjectCwds(workspace.threads);
  const requested = validLocalDirectory(String(cwdValue || '').trim());
  const cwd = requested && projects.includes(requested) ? requested : (projects[0] || __dirname);
  const environment = await readGitEnvironment(cwd);
  if (!environment.git?.available || !environment.git.root) {
    const error = new Error('当前项目不是可操作的 Git 仓库。');
    error.status = 409;
    error.code = 'GIT_REPOSITORY_REQUIRED';
    throw error;
  }
  return { cwd, root: environment.git.root, environment, projects };
}

function gitActionError(message, code = 'GIT_ACTION_FAILED', status = 400) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function handleGitAction(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const action = String(payload.action || '').trim().toLowerCase();
  if (!['commit', 'push', 'checkout'].includes(action)) {
    return json(res, 400, { ok: false, code: 'BAD_GIT_ACTION', message: '不支持的 Git 操作。' });
  }

  const startedAt = Date.now();
  const logGit = (status, errorText = '', detail = {}) => {
    try {
      persistentQueue.logExecution('', `git_${action}`, status, Date.now() - startedAt, errorText, detail);
    } catch {}
  };
  const gitDetail = () => ({ cwd: payload.cwd || '', branch: payload.branch || '', message: String(payload.message || '').slice(0, 200) });

  try {
    const target = await resolveGitActionTarget(payload.cwd);
    const root = target.root;
    const currentBranch = target.environment.git.branch;
    if (!currentBranch && action !== 'checkout') {
      throw gitActionError('当前处于 detached HEAD，不能直接提交或推送。', 'GIT_DETACHED_HEAD', 409);
    }

    if (action === 'checkout') {
      const branch = normalizeGitBranch(payload.branch);
      const localBranches = new Set(target.environment.git.localBranches || target.environment.git.branches);
      if (!branch || !localBranches.has(branch)) {
        throw gitActionError('只能切换到已存在的本地分支。', 'GIT_BRANCH_NOT_FOUND', 400);
      }
      if (branch === currentBranch) {
        logGit('completed', '', { branch, gitDetail: gitDetail() });
        return json(res, 200, { ok: true, action, branch, environment: target.environment, message: '当前已经在这个分支上。' });
      }
      const status = await runGit(['-C', root, 'status', '--porcelain'], { timeoutMs: 8000 });
      if (String(status.stdout || '').trim()) {
        throw gitActionError('工作区有未提交改动，请先提交或暂存后再切换分支。', 'GIT_WORKTREE_DIRTY', 409);
      }
      await runGit(['-C', root, 'switch', '--quiet', '--', branch], { timeoutMs: 15000 });
      const environment = await readGitEnvironment(target.cwd);
      logGit('completed', '', { branch, gitDetail: gitDetail() });
      return json(res, 200, { ok: true, action, branch, environment, message: `已切换到 ${branch}。` });
    }

    if (action === 'commit') {
      const message = String(payload.message || '').replace(/\s+/g, ' ').trim();
      if (!message) throw gitActionError('提交说明不能为空。', 'EMPTY_COMMIT_MESSAGE', 400);
      if (message.length > 180) throw gitActionError('提交说明不能超过 180 个字符。', 'COMMIT_MESSAGE_TOO_LONG', 400);
      const status = await runGit(['-C', root, 'status', '--porcelain'], { timeoutMs: 8000 });
      if (!String(status.stdout || '').trim()) throw gitActionError('工作区没有可提交的改动。', 'GIT_WORKTREE_CLEAN', 409);
      await runGit(['-C', root, 'add', '--all'], { timeoutMs: 20000 });
      const commit = await runGit(['-C', root, 'commit', '-m', message], { timeoutMs: 30000 });
      const environment = await readGitEnvironment(target.cwd);
      const hash = String(commit.stdout || '').match(/\[[^\]]+ ([a-f0-9]{7,})\]/)?.[1] || '';
      logGit('completed', '', { commitHash: hash, gitDetail: gitDetail() });
      return json(res, 200, {
        ok: true,
        action,
        environment,
        output: String(commit.stdout || '').trim(),
        message: '已提交当前改动。',
      });
    }

    if (!target.environment.git.remote) {
      throw gitActionError('当前仓库没有 origin 远程地址，无法推送。', 'GIT_REMOTE_REQUIRED', 409);
    }
    try {
      await runGit(['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 8000 });
    } catch {
      throw gitActionError('当前分支还没有设置上游分支，暂时不能自动推送。', 'GIT_UPSTREAM_REQUIRED', 409);
    }
    const push = await runGit(['-C', root, 'push'], { timeoutMs: 60000 });
    const environment = await readGitEnvironment(target.cwd);
    logGit('completed', '', { remote: target.environment.git.remote, gitDetail: gitDetail() });
    return json(res, 200, {
      ok: true,
      action,
      environment,
      output: String(push.stdout || push.stderr || '').trim(),
      message: '已推送当前分支。',
    });
  } catch (error) {
    logGit('failed', error?.message || 'Git 操作失败。', { code: error?.code || 'GIT_ACTION_FAILED', gitDetail: gitDetail() });
    return json(res, error?.status || 500, {
      ok: false,
      code: error?.code || 'GIT_ACTION_FAILED',
      message: error?.message || 'Git 操作失败。',
      detail: error?.stderr || '',
    });
  }
}

function githubRepositoryFromRemote(value) {
  const remote = String(value || '').trim();
  const match = remote.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com(?::|\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) return null;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function fetchGitHubJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:',
      hostname: 'api.github.com',
      method: 'GET',
      path: pathname,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `${APP_NAME.replace(/[^a-z0-9._-]/gi, '-')}/1.0`,
      },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > GITHUB_RESPONSE_MAX_BYTES) {
          response.destroy(new Error('GitHub 响应过大。'));
        }
      });
      response.on('error', reject);
      response.on('end', () => {
        const status = Number(response.statusCode) || 0;
        let data;
        try { data = body ? JSON.parse(body) : null; } catch {
          return reject(new Error('GitHub 返回了无法识别的数据。'));
        }
        if (status < 200 || status >= 300) {
          const message = String(data?.message || `GitHub 请求失败（${status}）。`);
          const error = new Error(message);
          error.status = status;
          return reject(error);
        }
        resolve(data);
      });
    });
    request.setTimeout(GITHUB_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('GitHub 请求超时。')));
    request.on('error', reject);
    request.end();
  });
}

async function listGitHubPullRequests(repository) {
  const cached = pullRequestCache.get(repository.fullName);
  if (cached && Date.now() - cached.at < 60000) return cached.rows;
  const pathname = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls?state=open&per_page=50`;
  const payload = await fetchGitHubJson(pathname);
  const rows = Array.isArray(payload) ? payload.map(row => ({
    number: Number(row.number) || 0,
    title: truncateText(row.title || '未命名拉取请求', 240),
    url: String(row.html_url || ''),
    author: String(row.user?.login || ''),
    draft: row.draft === true,
    updatedAt: normalizeIsoTimestamp(row.updated_at),
    head: String(row.head?.ref || ''),
    base: String(row.base?.ref || ''),
  })).filter(row => row.number && /^https:\/\/github\.com\//i.test(row.url)) : [];
  boundedSet(pullRequestCache, repository.fullName, { at: Date.now(), rows }, 30);
  return rows;
}

async function readGitHubProject(cwd) {
  let origin;
  try {
    const result = await runGit(['-C', cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 8000 });
    origin = String(result.stdout || '').trim();
  } catch {
    return null;
  }
  const repository = githubRepositoryFromRemote(origin);
  if (!repository) return null;
  const pullRequests = await listGitHubPullRequests(repository);
  return {
    cwd,
    name: displayPathName(cwd),
    repository: repository.fullName,
    url: `https://github.com/${repository.fullName}`,
    pullRequests,
  };
}

async function handlePullRequests(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const workspace = await listWorkspaceThreads(160);
  const cwds = existingProjectCwds(workspace.threads).slice(0, 12);
  const results = await Promise.allSettled(cwds.map(readGitHubProject));
  const projects = results
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason?.message || String(result.reason || 'GitHub 读取失败'));
  return json(res, 200, {
    ok: true,
    projects,
    errors,
    updatedAt: new Date().toISOString(),
  });
}

function readTailLines(file) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - CODEX_SESSION_TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function readTailLinesWithLimit(file, maxBytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text.split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function scanCodexThreadHistoryLines(lines, limit = MAX_HISTORY_MESSAGES, threadId = '') {
  // 单遍扫描：每行只 JSON.parse 一次；滚动窗口只保留最近 limit 条消息（等价于旧实现的 slice(-limit)）
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  const messages = [];
  let currentTurn = null;
  let count = 0;

  function historyDurationText(startedAt = '', completedAt = '') {
    const startMs = Date.parse(startedAt || '');
    const endMs = Date.parse(completedAt || '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '';
    const total = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  function historyCompleteLabel(startedAt = '', completedAt = '') {
    const duration = historyDurationText(startedAt, completedAt);
    return duration ? `Codex · 已处理 ${duration}` : 'Codex';
  }

  function historyFailureLabel(startedAt = '', completedAt = '') {
    const duration = historyDurationText(startedAt, completedAt);
    return duration ? `Codex · 失败 ${duration}` : 'Codex';
  }

  function pushMessage(message) {
    messages.push(message);
    count += 1;
    if (messages.length <= normalizedLimit) return;
    messages.shift();
    if (currentTurn) {
      currentTurn.assistantIndex = currentTurn.assistantIndex > 0 ? currentTurn.assistantIndex - 1 : -1;
    }
  }

  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item.payload || {};

    if (item.type === 'event_msg' && payload.type === 'task_started') {
      currentTurn = { hasAssistant: false, assistantIndex: -1, failureText: '', startedAt: item.timestamp || '', turnId: payload.turn_id || '' };
      continue;
    }

    if (currentTurn && item.type === 'event_msg') {
      currentTurn.failureText = currentTurn.failureText || extractFailureTextFromPayload(payload);
    }

    if (currentTurn && item.type === 'turn_context') {
      currentTurn.turnId = payload.turn_id || currentTurn.turnId;
    }

    if (item.type === 'event_msg' && payload.type === 'user_message') {
      const text = cleanUserHistoryText(payload.message);
      const attachments = extractUserAttachments(payload);
      if (text || attachments.length) {
        pushMessage({
          role: 'user',
          label: attachments.length ? `你 · ${attachments.length} 张图片` : '你',
          text: text || (attachments.length ? ' ' : ''),
          attachments: attachments.map(historyAttachmentDescriptor).filter(Boolean),
          timestamp: item.timestamp || '',
        });
      }
      continue;
    }

    if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      if (payload.phase !== 'final_answer') continue;
      const text = normalizeHistoryText(extractMessageText(payload.content));
      if (text) {
        pushMessage({
          role: 'assistant',
          label: 'Codex',
          text,
          timestamp: item.timestamp || '',
        });
        if (currentTurn) {
          currentTurn.hasAssistant = true;
          currentTurn.assistantIndex = messages.length - 1;
        }
      }
      continue;
    }

    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      const lastMessage = normalizeHistoryText(payload.last_agent_message || '');
      const completedAt = item.timestamp || '';
      if (currentTurn && !currentTurn.hasAssistant) {
        const failureText = resolveFailureTextForTurn(threadId, {
          turnId: currentTurn.turnId || '',
          startedAt: currentTurn.startedAt || '',
          completedAt,
          failureText: currentTurn.failureText || '',
        });
        pushMessage({
          role: 'assistant',
          label: failureText ? historyFailureLabel(currentTurn.startedAt, completedAt) : historyCompleteLabel(currentTurn.startedAt, completedAt),
          text: lastMessage || failureText || emptyCodexFailureText(),
          timestamp: completedAt || currentTurn.startedAt || '',
        });
      } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
        messages[currentTurn.assistantIndex].label = historyCompleteLabel(currentTurn.startedAt, completedAt);
      }
      currentTurn = null;
    }

    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      const failureText = normalizeHistoryText(extractFailureTextFromPayload(payload) || currentTurn?.failureText || '');
      if (currentTurn && !currentTurn.hasAssistant) {
        pushMessage({
          role: 'assistant',
          label: historyFailureLabel(currentTurn.startedAt, item.timestamp || ''),
          text: failureText || emptyCodexFailureText(),
          timestamp: item.timestamp || currentTurn.startedAt || '',
        });
      } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
        messages[currentTurn.assistantIndex].label = historyFailureLabel(currentTurn.startedAt, item.timestamp || '');
      }
      currentTurn = null;
    }
  }

  return { messages, count };
}

function readHistoryTailLines(file, limit = MAX_HISTORY_MESSAGES, threadId = '') {
  // 自适应读取：小文件直接读尾；大文件先读初始尾部，不足 limit 条消息才扩大到完整上限
  const stat = fs.statSync(file);
  const maxBytes = Math.min(stat.size, CODEX_HISTORY_TAIL_BYTES);
  const desired = Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));

  if (maxBytes <= CODEX_HISTORY_INITIAL_TAIL_BYTES * 6) {
    return { lines: readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
  }

  const initialBytes = Math.min(CODEX_HISTORY_INITIAL_TAIL_BYTES, maxBytes);
  const initialLines = readTailLinesWithLimit(file, initialBytes);
  if (scanCodexThreadHistoryLines(initialLines, desired, threadId).count >= desired) {
    return { lines: initialLines, stat, scannedBytes: initialBytes };
  }

  return { lines: readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
}

function extractUserAttachments(payload) {
  const paths = [];
  for (const key of ['local_images', 'images']) {
    if (!Array.isArray(payload[key])) continue;
    for (const item of payload[key]) {
      if (typeof item === 'string') paths.push(item);
      else if (item && typeof item.path === 'string') paths.push(item.path);
      else if (item && typeof item.filePath === 'string') paths.push(item.filePath);
    }
  }
  return paths;
}

function historyAttachmentDescriptor(filePath) {
  const absolutePath = path.resolve(String(filePath || ''));
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(absolutePath).toLowerCase()];
  if (!mime) return null;
  try {
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) return null;
  } catch { return null; }
  const now = Date.now();
  const existingId = historyAttachmentIdByPath.get(absolutePath);
  if (existingId) {
    const item = historyAttachmentCache.get(existingId);
    if (item && item.expiresAt > now && item.filePath === absolutePath) {
      return { name: path.basename(absolutePath), url: `/codex/attachment?id=${encodeURIComponent(existingId)}` };
    }
    historyAttachmentIdByPath.delete(absolutePath);
  }
  while (historyAttachmentCache.size >= HISTORY_ATTACHMENT_LIMIT) {
    const oldestId = historyAttachmentCache.keys().next().value;
    const oldest = historyAttachmentCache.get(oldestId);
    historyAttachmentCache.delete(oldestId);
    if (oldest) historyAttachmentIdByPath.delete(oldest.filePath);
  }
  const id = crypto.randomBytes(18).toString('base64url');
  historyAttachmentCache.set(id, { filePath: absolutePath, mime, expiresAt: now + HISTORY_ATTACHMENT_TTL_MS });
  historyAttachmentIdByPath.set(absolutePath, id);
  return { name: path.basename(absolutePath), url: `/codex/attachment?id=${encodeURIComponent(id)}` };
}

function parseCodexThreadHistory(threadId, limit = MAX_HISTORY_MESSAGES) {
  const file = findCodexSessionFileByThreadId(threadId);
  if (!file) {
    return {
      ok: true,
      available: false,
      threadId,
      sessionFile: '',
      messages: [],
      message: '没有找到所选任务的 Codex 会话文件。',
    };
  }

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  const historyTail = readHistoryTailLines(file, normalizedLimit, threadId);
  const scan = scanCodexThreadHistoryLines(historyTail.lines, normalizedLimit, threadId);

  return {
    ok: true,
    available: true,
    threadId,
    sessionFile: path.basename(file),
    truncated: historyTail.stat.size > CODEX_HISTORY_TAIL_BYTES,
    messages: scan.messages,
  };
}

function appServerTurnLabel(turn = {}, failed = false) {
  const durationMs = Number(turn.durationMs || 0);
  const seconds = durationMs > 0 ? Math.max(0, Math.floor(durationMs / 1000)) : 0;
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : seconds ? `${seconds}s` : '';
  if (failed) return duration ? `Codex · 失败 ${duration}` : 'Codex · 失败';
  return duration ? `Codex · 已处理 ${duration}` : 'Codex';
}

function appServerUserMessage(item = {}, timestamp = '') {
  const textParts = [];
  const attachments = [];
  for (const content of item.content || []) {
    if (content?.type === 'text' && content.text) textParts.push(content.text);
    if (content?.type === 'localImage' && content.path) {
      const attachment = historyAttachmentDescriptor(content.path);
      if (attachment) attachments.push(attachment);
    } else if (content?.type === 'image' && content.url) {
      attachments.push({ filePath: content.url, name: 'image' });
    }
  }
  const text = cleanUserHistoryText(textParts.join('\n'));
  if (!text && !attachments.length) return null;
  return {
    role: 'user',
    label: attachments.length ? `你 · ${attachments.length} 张图片` : '你',
    text: text || ' ',
    attachments,
    timestamp,
  };
}

function appServerActivityText(item = {}) {
  const type = String(item.type || '').trim();
  const activityTypes = new Set(['mcpToolCall', 'fileChange', 'contextCompaction', 'compacted', 'commandExecution', 'shellCommand', 'webSearch', 'imageGeneration', 'imageView', 'browserAction']);
  if (!activityTypes.has(type)) return null;
  const rawTool = String(item.tool || item.name || item.command || '').trim();
  const tool = rawTool.split('.').pop().toLowerCase();
  const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
  const title = String(args.title || item.title || '').replace(/\s+/g, ' ').trim();
  const code = String(args.code || '').trim();

  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.map(change => change?.path).filter(Boolean).map(shortPath);
    return {
      kind: 'tool',
      category: 'file',
      label: '文件',
      text: paths.length ? `编辑 ${uniqueList(paths, 3).join('、')}` : '编辑文件',
    };
  }
  if (type === 'contextCompaction' || type === 'compacted') {
    return { kind: 'tool', category: 'context', label: '上下文', text: '压缩上下文' };
  }

  const looksLikeImage = tool === 'view_image' || /(?:view_image|查看图片|已查看\s*\d*\s*张?(?:图片|图像)|\bimage(?:s)?\b)/i.test(`${rawTool} ${title}`) || /\bview_image\b/i.test(code);
  if (looksLikeImage) return { kind: 'tool', category: 'image', label: '图片', text: title || '查看图片' };

  const looksLikeBrowser = /(?:browser|chrome|网页|页面|tab|domsnapshot|screenshot|playwright|goto\s*\()/i.test(`${rawTool} ${title} ${code}`);
  const looksLikeCommand = /(?:exec_command|shell_command|powershell|命令|npm\s|node\s|git\s|Get-[A-Za-z]|rg\s|sed\s|\bcat\s)/i.test(`${rawTool} ${title} ${code}`);
  if (looksLikeBrowser) return { kind: 'tool', category: 'browser', label: '浏览器', text: title || '检查网页' };
  if (looksLikeCommand) return { kind: 'tool', category: 'command', label: '命令', text: title || '运行命令' };

  if (type === 'commandExecution' || type === 'shellCommand') {
    return { kind: 'tool', category: 'command', label: '命令', text: title || item.command || '运行命令' };
  }
  if (type === 'webSearch' || /search/i.test(tool)) return { kind: 'tool', category: 'search', label: '搜索', text: title || '搜索资料' };
  return { kind: 'tool', category: 'tool', label: '工具', text: title || rawTool || '使用工具' };
}

function appServerTurnActivities(turn = {}) {
  const activities = [];
  for (const item of turn.items || []) {
    if (!item || !item.type) continue;
    const activity = appServerActivityText(item);
    if (activity) activities.push({ ...activity, id: item.id || '', status: item.status || '' });
  }
  return activities.slice(-500);
}

function historyFromAppServerThread(thread, limit = MAX_HISTORY_MESSAGES) {
  const messages = [];
  // The app server can return turns in cache or newest-first order. The phone
  // must always mirror the desktop conversation from oldest to newest.
  const turns = [...(thread?.turns || [])]
    .map((turn, index) => ({ turn, index }))
    .sort((left, right) => {
      const leftTime = Number(left.turn?.startedAt || left.turn?.createdAt || 0);
      const rightTime = Number(right.turn?.startedAt || right.turn?.createdAt || 0);
      return leftTime - rightTime || left.index - right.index;
    });
  for (const { turn } of turns) {
    const startedAt = Number(turn.startedAt || 0) ? new Date(Number(turn.startedAt) * 1000).toISOString() : '';
    const completedAt = Number(turn.completedAt || 0) ? new Date(Number(turn.completedAt) * 1000).toISOString() : '';
    const agentItems = [];
    const activities = appServerTurnActivities(turn);
    let hasExplicitFinal = false;
    for (const item of turn.items || []) {
      if (item?.type === 'userMessage') {
        const message = appServerUserMessage(item, startedAt);
        if (message) messages.push(message);
      }
      if (item?.type === 'agentMessage' && item.text) {
        agentItems.push(item);
        if (item.phase === 'final_answer') hasExplicitFinal = true;
      }
    }

    const visibleAgents = hasExplicitFinal
      ? agentItems.filter(item => item.phase === 'final_answer')
      : (turn.status === 'completed' ? agentItems.slice(-1) : []);
    for (const item of visibleAgents) {
      const text = normalizeHistoryText(item.text || '');
      if (!text) continue;
      messages.push({
        role: 'assistant',
        label: appServerTurnLabel(turn, false),
        text,
        steps: activities,
        timestamp: completedAt || startedAt,
      });
    }

    if (turn.status === 'failed' && !visibleAgents.length) {
      const failure = normalizeHistoryText(turn.error?.message || turn.error?.additionalDetails || '') || emptyCodexFailureText();
      messages.push({
        role: 'assistant',
        label: appServerTurnLabel(turn, true),
        text: failure,
        steps: activities,
        timestamp: completedAt || startedAt,
      });
    }
  }

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  return {
    ok: true,
    available: Boolean(thread),
    transport: 'app-server',
    threadId: thread?.id || '',
    sessionFile: thread?.path ? path.basename(thread.path) : '',
    truncated: messages.length > normalizedLimit,
    messages: messages.slice(-normalizedLimit),
  };
}

async function handleThreadHistory(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const threadId = url.searchParams.get('thread') || '';
    if (!isCodexThreadId(threadId)) {
      return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
    }
    const limit = url.searchParams.get('limit') || MAX_HISTORY_MESSAGES;
    try {
      const thread = await codexAppServer.readThread(threadId, true);
      return json(res, 200, historyFromAppServerThread(thread, limit));
    } catch (appServerError) {
      return json(res, 200, {
        ...parseCodexThreadHistory(threadId, limit),
        transport: 'session-files',
        appServerError: appServerError.message || String(appServerError),
      });
    }
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_HISTORY_FAILED', message: '读取 Codex 聊天记录失败。', detail: String(error && error.message || error) });
  }
}

function buildMarkdownExport(threadId, data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const lines = [
    '# Codex 对话导出',
    '',
    `- 任务 ID：${threadId}`,
    `- 导出时间：${new Date().toISOString()}`,
    `- 消息数：${messages.length}`,
    '',
  ];
  for (const row of messages) {
    const roleLabel = row?.role === 'user' ? '用户' : 'Codex Remote Bridge';
    const time = row?.timestamp ? `（${row.timestamp}）` : '';
    lines.push(`## ${roleLabel}${time}`, '');
    const text = String(row?.text || '').replace(/\r\n/g, '\n').trim();
    lines.push(text || '（无文本）');
    if (Array.isArray(row?.attachments) && row.attachments.length) {
      for (const attachment of row.attachments) {
        const name = attachment?.name ? ` ${attachment.name}` : '';
        const url = attachment?.url ? `（${attachment.url}）` : '';
        lines.push(`- 附件${name}${url}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function handleExport(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const threadId = url.searchParams.get('thread') || '';
    if (!isCodexThreadId(threadId)) {
      return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
    }
    const limit = url.searchParams.get('limit') || MAX_HISTORY_MESSAGES;
    let data;
    try {
      const thread = await codexAppServer.readThread(threadId, true);
      data = historyFromAppServerThread(thread, limit);
    } catch (appServerError) {
      data = parseCodexThreadHistory(threadId, limit);
    }
    const markdown = buildMarkdownExport(threadId, data);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const fileName = `codex-thread-${threadId.slice(0, 8)}-${stamp}.md`;
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': Buffer.byteLength(markdown),
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    });
    res.end(markdown);
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_EXPORT_FAILED', message: '导出对话失败。', detail: String(error && error.message || error) });
  }
}

function searchSnippet(text, index, needleLength, radius = 60) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needleLength + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

function searchableTextFromItem(item) {
  const payload = item && item.payload || {};
  if (item.type === 'event_msg' && payload.type === 'user_message') {
    return cleanUserHistoryText(payload.message);
  }
  if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer') {
    return normalizeHistoryText(extractMessageText(payload.content));
  }
  return '';
}

function searchCodexSessions(query, options = {}) {
  const rawQuery = String(query || '').trim();
  const needle = rawQuery.toLocaleLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit) || 50, CODEX_SEARCH_MAX_RESULTS));
  const startedAt = Date.now();
  if (needle.length < CODEX_SEARCH_MIN_QUERY_LENGTH) {
    return { ok: true, query: rawQuery, limit, tookMs: 0, results: [] };
  }
  const files = listCodexSessionFiles({ force: true });
  const candidates = [];
  for (const file of files) {
    try {
      candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // ignore disappearing files
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanned = candidates.slice(0, CODEX_SEARCH_MAX_FILES);
  const hits = [];
  for (const { file, mtimeMs } of scanned) {
    const items = readJsonlTailObjects(file, CODEX_SEARCH_TAIL_BYTES);
    let best = null;
    for (const item of items) {
      const text = searchableTextFromItem(item);
      if (!text) continue;
      const lower = text.toLocaleLowerCase();
      const index = lower.indexOf(needle);
      if (index < 0) continue;
      const snippet = searchSnippet(text, index, needle.length);
      const updatedAt = item.timestamp || new Date(mtimeMs).toISOString();
      if (!best || (Date.parse(updatedAt) || 0) > (Date.parse(best.updatedAt) || 0)) {
        best = { snippet, updatedAt };
      }
    }
    if (best) {
      const meta = readSessionMeta(file);
      hits.push({
        threadId: threadIdFromSessionFile(file),
        title: String(meta.title || '').trim().slice(0, 60),
        snippet: best.snippet,
        updatedAt: best.updatedAt,
        sessionFile: path.basename(file),
      });
    }
  }
  hits.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return {
    ok: true,
    query: rawQuery,
    limit,
    tookMs: Date.now() - startedAt,
    results: hits.slice(0, limit),
  };
}

async function handleSearch(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = String(url.searchParams.get('q') || '').trim();
    if (query.length < CODEX_SEARCH_MIN_QUERY_LENGTH) {
      return json(res, 400, { ok: false, code: 'BAD_QUERY', message: '搜索词至少需要 2 个字符。' });
    }
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, CODEX_SEARCH_MAX_RESULTS));
    return json(res, 200, searchCodexSessions(query, { limit }));
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_SEARCH_FAILED', message: '搜索对话内容失败。', detail: String(error && error.message || error) });
  }
}
function extractReasoningText(payload) {
  const parts = [];
  if (Array.isArray(payload.summary)) {
    for (const item of payload.summary) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item.text === 'string') parts.push(item.text);
      else if (item && typeof item.summary === 'string') parts.push(item.summary);
    }
  }
  if (Array.isArray(payload.content)) {
    for (const item of payload.content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item.text === 'string') parts.push(item.text);
    }
  }
  if (typeof payload.text === 'string') parts.push(payload.text);
  const visible = parts.map(x => String(x).trim()).filter(Boolean).join('\n');
  return visible;
}

function parseToolArguments(payload) {
  const raw = payload.arguments || payload.input || '';
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { raw: String(raw) }; }
}

function shellQuotePattern() {
  return String.raw`(?:(?:"[^"]+")|(?:'[^']+')|(?:\\\S|\S)+)`;
}

function stripShellQuotes(value) {
  let text = String(value || '').trim();
  while ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.replace(/\\([\s"'])/g, '$1');
}

function shortPath(value) {
  const text = stripShellQuotes(value).replace(/^~\//, '~/');
  if (!text) return '';
  const home = os.homedir();
  const normalized = text.startsWith(home) ? `~${text.slice(home.length)}` : text;
  if (/^[./~\w-].*\.(?:js|ts|tsx|jsx|html|css|json|jsonl|md|txt|sh|swift|py|yml|yaml|webmanifest|png|jpg|jpeg|gif|svg)$/i.test(normalized)) {
    return normalized.replace(/^\.\//, '');
  }
  return normalized.replace(/^\.\//, '');
}


function isLikelyToolFile(value) {
  const text = stripShellQuotes(value);
  if (!text || text.startsWith('-') || text.startsWith('<') || /^\d+$/.test(text)) return false;
  if (/^[A-Z_]+$/.test(text)) return false;
  return /[./~]/.test(text) || /\.[A-Za-z0-9]{1,12}$/.test(text);
}

function uniqueList(values, limit = 3) {
  const out = [];
  for (const value of values) {
    const text = shortPath(value);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function joinToolTargets(values) {
  const list = uniqueList(values, 4);
  if (!list.length) return '';
  return list.join(', ');
}

function extractSearchTargets(cmd) {
  const afterGlob = cmd.replace(/--glob\s+(?:"[^"]+"|'[^']+'|\S+)/g, '');
  const matches = [...afterGlob.matchAll(/(?:^|\s)([./~\w-][^\s|;&]*\.(?:js|ts|tsx|jsx|html|css|json|jsonl|md|txt|sh|swift|py|yml|yaml|webmanifest))(?:\s|$)/gi)];
  return uniqueList(matches.map(match => match[1]), 4);
}

function truncateCommand(cmd, max = 120) {
  const oneLine = String(cmd || '').split('\n')[0].replace(/\s+/g, ' ').trim();
  const home = os.homedir();
  const text = oneLine.startsWith(home) ? `~${oneLine.slice(home.length)}` : oneLine.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function patchStats(patch) {
  const files = [];
  let added = 0;
  let removed = 0;
  for (const line of String(patch || '').split('\n')) {
    const fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/) || line.match(/^@@\s+(.+?)\s*$/);
    if (fileMatch && !fileMatch[1].startsWith('@@')) files.push(fileMatch[1].trim());
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { files: uniqueList(files, 3), added, removed };
}

function formatToolCall(payload, options = {}) {
  const rawName = String(payload.name || 'tool');
  const name = rawName.split('.').pop();
  const args = parseToolArguments(payload);

  if (name === 'exec_command' || name === 'shell_command') {
    const cmd = String(args.command || args.cmd || args.raw || '').trim();
    if (/\b(?:rg|grep)\b/.test(cmd)) {
      const targets = joinToolTargets(extractSearchTargets(cmd));
      return targets ? `Search ${targets}` : 'Search project files';
    }
    if (/\bfind\b/.test(cmd)) return 'Find files';
    if (/\bls\b/.test(cmd)) return 'List files';
    if (/\bgit\s+diff\b/.test(cmd)) return `Review diff${joinToolTargets(extractSearchTargets(cmd)) ? ` in ${joinToolTargets(extractSearchTargets(cmd))}` : ''}`;
    if (/\bgit\s+status\b/.test(cmd)) return 'Check git status';
    if (/\bgit\b/.test(cmd)) return `Run git: ${truncateCommand(cmd, 90)}`;
    if (/\b(?:node --check|npm run check)\b/.test(cmd)) return 'Run checks';
    if (/\bcurl\b/.test(cmd)) return `Check endpoint: ${truncateCommand(cmd, 100)}`;
    if (/\b(?:npm start|node\s+server\.js)\b/.test(cmd)) return 'Start local service';
    if (/\b(?:osascript|cliclick|open -b com\.openai\.codex)\b/.test(cmd)) return 'Control Codex desktop';
    if (/\.codex\/sessions|session_index\.jsonl|Codex session/.test(cmd)) return 'Inspect Codex session log';
    if (/\b(?:python3|node\s+-)\b/.test(cmd)) return `Run script: ${truncateCommand(cmd, 90)}`;
    return `Run: ${truncateCommand(cmd) || 'local command'}`;
  }

  if (name === 'apply_patch') {
    const patch = typeof args.raw === 'string' ? args.raw : String(payload.arguments || '');
    const stats = patchStats(patch);
    const target = stats.files.length ? stats.files.join(', ') : 'files';
    const delta = stats.added || stats.removed ? ` +${stats.added} -${stats.removed}` : '';
    return `${options.complete ? '已编辑' : '正在编辑'} ${target}${delta}`;
  }

  if (name === 'wait' || name === 'wait_agent' || name === 'wait_threads') return '';
  if (name === 'exec') return '运行命令或工具';
  if (name === 'write_stdin') return '读取命令输出';
  if (name === 'view_image') return `查看图片${args.path ? ` ${shortPath(args.path)}` : ''}`;
  if (name === 'read_mcp_resource') return '读取资源';
  if (name.includes('browser') || name.includes('chrome')) return '检查网页';
  if (name.includes('search')) return '搜索资料';
  if (name.includes('read')) return '读取信息';
  return '使用工具';
}

function cleanVisibleProgress(value) {
  let text = normalizeHistoryText(value || '')
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (/^(?:wait|exec|apply_patch|shell_command)\s*\{/i.test(text)) return '';
  if (/^\{[\s\S]*\}$/.test(text)) return '';
  const hanCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const letterCount = (text.match(/[A-Za-z]/g) || []).length;
  if (!hanCount && letterCount > 24) return '';
  return truncateText(text, 220);
}


function contextUsageFromItems(items) {
  let windowTokens = 0;
  let latestUsage = null;
  let updatedAt = '';

  for (const item of items) {
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      const value = Number(payload.model_context_window || 0);
      if (Number.isFinite(value) && value > 0) windowTokens = value;
    }
    if (item.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const info = payload.info || {};
    const value = Number(info.model_context_window || 0);
    if (Number.isFinite(value) && value > 0) windowTokens = value;
    const usage = info.last_token_usage || info.current_token_usage || null;
    if (usage && typeof usage === 'object') {
      latestUsage = usage;
      updatedAt = item.timestamp || updatedAt;
    }
  }

  if (!latestUsage || !windowTokens) {
    return {
      available: false,
      usedTokens: 0,
      windowTokens: windowTokens || 0,
      remainingTokens: windowTokens || 0,
      percent: null,
      updatedAt,
    };
  }

  const inputTokens = Number(latestUsage.input_tokens || 0) || 0;
  const outputTokens = Number(latestUsage.output_tokens || 0) || 0;
  const totalTokens = Number(latestUsage.total_tokens || 0) || 0;
  let usedTokens = totalTokens || (inputTokens + outputTokens) || inputTokens;
  if (usedTokens > windowTokens * 1.15 && inputTokens > 0 && inputTokens <= windowTokens * 1.15) {
    usedTokens = inputTokens + outputTokens;
  }
  usedTokens = Math.max(0, Math.round(usedTokens));
  const percent = Math.max(0, Math.min(100, (usedTokens / windowTokens) * 100));

  return {
    available: true,
    usedTokens,
    windowTokens,
    remainingTokens: Math.max(0, Math.round(windowTokens - usedTokens)),
    percent,
    updatedAt,
  };
}

function modelInfoFromId(modelId = '', updatedAt = '') {
  const id = String(modelId || '').trim();
  const option = findModelOption(id);
  if (option) return { available: true, id, version: '', source: 'local', label: option.label, displayName: option.displayName, updatedAt };

  if (id === 'gpt-5.5') return { available: true, id, version: '5.5', source: 'official', label: '5.5', displayName: 'GPT-5.5', updatedAt };
  if (id === 'gpt-5.4') return { available: true, id, version: '5.4', source: 'official', label: '5.4', displayName: 'GPT-5.4', updatedAt };
  if (id === 'gpt-5.4-mini') return { available: true, id, version: 'mini', source: 'official', label: 'mini', displayName: 'GPT-5.4 Mini', updatedAt };
  if (id === 'gpt-5.3-codex') return { available: true, id, version: '5.3', source: 'official', label: '5.3', displayName: 'GPT-5.3 Codex', updatedAt };
  if (id === 'gpt-5.2') return { available: true, id, version: '5.2', source: 'official', label: '5.2', displayName: 'GPT-5.2', updatedAt };

  return {
    available: Boolean(id),
    id,
    version: '',
    source: id.startsWith('gpt-') ? 'official' : id ? 'unknown' : '',
    label: labelFromModelName(id),
    displayName: id,
    updatedAt,
  };
}

function currentModelFromItems(items) {
  let modelId = '';
  let updatedAt = '';
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type === 'session_meta' && payload.model) {
      modelId = payload.model;
      updatedAt = item.timestamp || payload.timestamp || updatedAt;
    }
    if (item.type === 'turn_context' && payload.model) {
      modelId = payload.model;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  return modelInfoFromId(modelId, updatedAt);
}

function reasoningModeFromValue(value = '', updatedAt = '') {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = {
    low: 'low',
    '低': 'low',
    medium: 'medium',
    med: 'medium',
    middle: 'medium',
    '中': 'medium',
    high: 'high',
    '高': 'high',
    xhigh: 'xhigh',
    'x-high': 'xhigh',
    'extra-high': 'xhigh',
    extreme: 'xhigh',
    max: 'max',
    maximum: 'max',
    ultra: 'ultra',
    '超高': 'xhigh',
    '最高': 'max',
    '极高': 'max',
    '极致': 'ultra',
  };
  const key = aliases[raw] || '';
  const target = key ? REASONING_MODE_TARGETS[key] : null;
  return {
    available: Boolean(target || raw),
    key: target?.key || '',
    value: target?.value || raw,
    label: target?.label || '',
    displayName: target?.displayName || value || '',
    updatedAt,
  };
}

function currentReasoningModeFromItems(items) {
  let value = '';
  let updatedAt = '';
  for (const item of items) {
    const payload = item.payload || {};
    const settings = payload.collaboration_mode && typeof payload.collaboration_mode === 'object'
      ? payload.collaboration_mode.settings || {}
      : {};
    const reasoning = payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning : {};
    const next = payload.reasoning_effort || payload.reasoningMode || payload.reasoning_mode || settings.reasoning_effort || reasoning.effort || '';
    if (item.type === 'turn_context' && next) {
      value = next;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  return reasoningModeFromValue(value, updatedAt);
}

function stepFromEvent(item) {
  const payload = item.payload || {};
  if (item.type === 'event_msg') {
    const failureText = extractFailureTextFromPayload(payload);
    if (failureText) return { kind: 'error', label: '失败', text: failureText, time: item.timestamp };
    if (payload.type === 'task_started') return { kind: 'start', label: '开始', text: '开始处理这条消息', time: item.timestamp };
    if (payload.type === 'task_complete') return { kind: 'complete', label: '完成', text: '回复完成', time: item.timestamp };
    if (payload.type === 'agent_message') return null;
    return null;
  }

  if (item.type === 'response_item') {
    if (payload.type === 'reasoning') {
      return null;
    }
    if (payload.type === 'function_call') {
      const text = formatToolCall(payload);
      return text ? { kind: 'tool', label: '工具', text, callId: payload.call_id || '', time: item.timestamp } : null;
    }
    if (payload.type === 'message') {
      const text = extractMessageText(payload.content);
      if (text && payload.role === 'assistant' && payload.phase === 'commentary') {
        const progress = cleanVisibleProgress(text);
        return progress ? { kind: 'thinking', label: '进度', text: progress, time: item.timestamp } : null;
      }
      if (text && payload.role === 'assistant') return { kind: payload.phase === 'final_answer' ? 'final' : 'assistant', label: '回复', text: truncateText(text, 1200), time: item.timestamp };
    }
  }
  return null;
}

function parseCodexStatus(options = {}) {
  const sinceMs = options.since ? Date.parse(options.since) : 0;
  const wantsExactSession = Boolean(options.threadId || options.sessionFile);
  const requestedFile = options.threadId ? findCodexSessionFileByThreadId(options.threadId) : options.sessionFile ? findCodexSessionFileByName(options.sessionFile) : null;
  const file = requestedFile || (wantsExactSession ? null : findLatestCodexSessionFile({
    afterMs: options.expectNewThread ? sinceMs : 0,
    excludeThreadId: options.excludeThreadId || '',
    cwd: options.cwd || '',
  }));
  if (!file) {
    return {
      ok: true,
      available: false,
      active: Boolean(options.expectNewThread && sinceMs),
      status: wantsExactSession ? 'missing' : options.expectNewThread && sinceMs ? 'waiting' : 'idle',
      threadId: options.threadId || '',
      sessionFile: options.sessionFile || '',
      message: wantsExactSession ? '没有找到所选任务的 Codex 会话文件。' : '还没有找到 Codex 会话文件。',
      steps: [],
      preview: options.expectNewThread && sinceMs ? '已发送，等待 Codex 创建新任务记录…' : '还没有找到这个任务的回复记录。',
      final: '',
      durationMs: 0,
    };
  }
  // Phase 3.1: 增量尾部读取（文件未变零重读；追加只读新增字节；截断/重写整体重读）
  const tailRead = statusTailReader.read(file);
  const rawItems = tailRead.items;
  let fileMtimeMs = tailRead.stat ? tailRead.stat.mtimeMs : 0;
  if (!fileMtimeMs) {
    try { fileMtimeMs = fs.statSync(file).mtimeMs; } catch { fileMtimeMs = Date.now(); }
  }
  let startIndex = -1;
  if (sinceMs) {
    for (let i = 0; i < rawItems.length; i += 1) {
      const t = Date.parse(rawItems[i].timestamp || '');
      if (Number.isFinite(t) && t >= sinceMs) {
        startIndex = i;
        break;
      }
    }
  }

  if (startIndex < 0) {
    for (let i = rawItems.length - 1; i >= 0; i -= 1) {
      if (rawItems[i].type === 'event_msg' && rawItems[i].payload && rawItems[i].payload.type === 'task_started') {
        startIndex = i;
        break;
      }
    }
  }
  if (startIndex < 0) startIndex = Math.max(0, rawItems.length - 80);

  // If watching a specific send, begin at the first task_started after that send when possible.
  if (sinceMs) {
    for (let i = startIndex; i < rawItems.length; i += 1) {
      const item = rawItems[i];
      const t = Date.parse(item.timestamp || '');
      if (Number.isFinite(t) && t >= sinceMs && item.type === 'event_msg' && item.payload && item.payload.type === 'task_started') {
        startIndex = i;
        break;
      }
    }
  }

  const turnItems = rawItems.slice(startIndex).filter(item => {
    if (!sinceMs) return true;
    const t = Date.parse(item.timestamp || '');
    return !Number.isFinite(t) || t >= sinceMs;
  });

  let active = Boolean(sinceMs);
  let completed = false;
  let turnId = null;
  let final = '';
  let preview = '';
  let startedAt = '';
  let completedAt = '';
  let sawTaskStarted = false;
  let failureText = '';
  let emptyComplete = false;
  const steps = [];
  const seenThinking = new Set();
  const toolCallsById = new Map();
  const toolStepIndexById = new Map();

  for (const item of turnItems) {
    const payload = item.payload || {};
    failureText = failureText || extractFailureTextFromPayload(payload);
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      active = true;
      sawTaskStarted = true;
      turnId = payload.turn_id || turnId;
      startedAt = startedAt || item.timestamp || '';
    }
    if (item.type === 'turn_context') turnId = payload.turn_id || turnId;
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      active = false;
      completed = true;
      completedAt = item.timestamp || completedAt;
      const lastMessage = normalizeHistoryText(payload.last_agent_message || '');
      final = lastMessage || final;
      if (!lastMessage && !final && !preview && sawTaskStarted) emptyComplete = true;
    }
    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      active = false;
      completed = true;
      completedAt = item.timestamp || completedAt;
      turnId = payload.turn_id || turnId;
    }

    if (item.type === 'response_item' && payload.type === 'function_call_output' && payload.call_id && toolStepIndexById.has(payload.call_id)) {
      const callPayload = toolCallsById.get(payload.call_id);
      if (callPayload && String(callPayload.name || '').split('.').pop() === 'apply_patch') {
        const stepIndex = toolStepIndexById.get(payload.call_id);
        if (steps[stepIndex]) steps[stepIndex].text = formatToolCall(callPayload, { complete: true });
      }
    }

    const step = stepFromEvent(item);
    if (!step) continue;
    if (step.kind === 'thinking') {
      const key = step.text || 'thinking';
      if (seenThinking.has(key)) continue;
      seenThinking.add(key);
    }
    if ((step.kind === 'assistant' || step.kind === 'final') && step.text) preview = step.text;
    if (step.kind === 'final' && step.text) final = step.text;
    if (['start', 'thinking', 'tool', 'complete', 'error'].includes(step.kind)) {
      if (step.kind === 'tool' && step.callId) {
        toolCallsById.set(step.callId, payload);
        toolStepIndexById.set(step.callId, steps.length);
      }
      steps.push(step);
    }
  }

  const context = contextUsageFromItems(rawItems);
  const model = currentModelFromItems(rawItems);
  const reasoningMode = currentReasoningModeFromItems(rawItems);
  const threadId = threadIdFromSessionFile(file);
  const failed = completed && !final && (emptyComplete || Boolean(failureText));
  const finalFailureText = failed
    ? (resolveFailureTextForTurn(threadId, { turnId, startedAt, completedAt, failureText }) || emptyCodexFailureText())
    : '';
  const statusSteps = steps.slice(-30);
  if (failed && finalFailureText && !statusSteps.some(step => step.kind === 'error' && step.text === finalFailureText)) {
    statusSteps.push({ kind: 'error', label: '失败', text: finalFailureText, time: completedAt || new Date(fileMtimeMs).toISOString() });
  }
  const lastStep = statusSteps[statusSteps.length - 1] || steps[steps.length - 1];
  const status = failed ? 'error' : completed ? 'complete' : active ? 'running' : 'idle';
  const waiting = sinceMs && !steps.length;
  const startMs = Date.parse(startedAt || '') || sinceMs || 0;
  const endMs = completedAt ? Date.parse(completedAt) : Date.now();
  const durationMs = startMs ? Math.max(0, endMs - startMs) : 0;
  const toolCount = statusSteps.filter(step => step.kind === 'tool').length;
  const latestProgress = [...statusSteps].reverse().find(step => step.kind === 'thinking')?.text || '';
  return {
    ok: true,
    available: true,
    active: waiting ? true : active,
    status: waiting ? 'waiting' : status,
    turnId,
    sessionFile: path.basename(file),
    threadId,
    updatedAt: lastStep ? lastStep.time : new Date(fileMtimeMs).toISOString(),
    startedAt,
    completedAt,
    durationMs,
    context,
    model,
    reasoningMode,
    toolCount,
    latestProgress,
    processSummary: latestProgress || (toolCount ? `正在运行 ${toolCount} 个操作` : active ? '正在处理请求' : ''),
    processText: statusSteps.map(step => `${step.label || '事件'}：${step.text || ''}`).join('\\n'),
    preview: final || preview || finalFailureText || (waiting ? '已发送，等待 Codex 开始回复…' : active ? 'Codex 正在回复…' : '暂无可显示回复。'),
    final: final || '',
    error: finalFailureText,
    steps: statusSteps,
  };
}

function handleCodexStatus(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return json(res, 200, parseCodexStatus({
      since: url.searchParams.get('since') || '',
      sessionFile: url.searchParams.get('session') || '',
      threadId: url.searchParams.get('thread') || '',
      expectNewThread: url.searchParams.get('expectNewThread') === '1',
      excludeThreadId: url.searchParams.get('excludeThread') || '',
      cwd: url.searchParams.get('cwd') || '',
    }));
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_STATUS_FAILED', message: '读取 Codex 回复状态失败。', detail: String(error && error.message || error) });
  }
}

function handleCodexApprovals(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const threadId = String(url.searchParams.get('thread') || '').trim();
  if (threadId && !isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
  }

  return json(res, 200, {
    ok: true,
    available: codexAppServer.isAvailable(),
    approvals: codexAppServer.listPendingApprovals({ threadId }),
  });
}

async function handleCodexApproval(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const requestId = String(payload.requestId || '').trim();
  const decision = String(payload.decision || '').trim();
  if (!requestId || requestId.length > 200 || !decision) {
    return json(res, 400, { ok: false, code: 'BAD_APPROVAL_REQUEST', message: '授权请求或操作不正确。' });
  }

  try {
    const result = codexAppServer.resolvePendingApproval(requestId, decision);
    return json(res, 200, { ok: true, ...result, message: '已将授权决定发送给 Codex。' });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return json(res, status, {
      ok: false,
      code: error?.code || 'APPROVAL_FAILED',
      message: error?.message || '处理 Codex 授权失败。',
    });
  }
}

async function handleSelectThread(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  if (!isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
  }

  try {
    await activateCodexThread(threadId);
    return json(res, 200, { ok: true, threadId, message: '已切换到所选 Codex 任务。' });
  } catch (error) {
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}


const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...(res._corsHeaders || corsHeaders()),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

// CORS 安全头计算已提取到 src/routes/corsHeaders（server.js 直接复用）
function options(req, res) {
  res.writeHead(204, corsHeaders(req));
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      reject(error);
    };
    const onData = chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(Object.assign(new Error('输入太长了，请分段发送。'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => fail(Object.assign(new Error('请求读取超时，请稍后再试。'), { status: 408 })), 30000);
    if (timer.unref) timer.unref();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', error => {
      clearTimeout(timer);
      fail(error);
    });
  });
}

function isAuthorized(req) {
  return security.isAuthorized(req);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function cleanupRecentSendRequests() {
  const cutoff = Date.now() - RECENT_SEND_TTL_MS;
  for (const [id, entry] of recentSendRequests) {
    if (!entry || entry.createdAt < cutoff) recentSendRequests.delete(id);
  }
}

function normalizeClientRequestId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9._:-]{8,120}$/.test(id) ? id : '';
}

function runProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${command} exited with code ${code}`), { code, stdout, stderr }));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function explainAutomationError(error) {
  const raw = String(error && (error.stderr || error.message) || '');
  const lower = raw.toLowerCase();
  if (process.platform === 'win32') {
    if (lower.includes('codex') || lower.includes('window') || lower.includes('窗口') || lower.includes('start-process')) {
      return {
        code: 'CODEX_WINDOW_NOT_READY',
        message: 'Windows 没能激活 Codex Desktop。请确认 Codex Desktop 已安装、已登录，并且 codex:// 协议能从运行服务的这个桌面会话打开。',
        detail: raw,
      };
    }
    if (lower.includes('clipboard') || lower.includes('剪贴板')) {
      return {
        code: 'WINDOWS_CLIPBOARD_FAILED',
        message: 'Windows 剪贴板写入失败。请确认当前桌面没有其他程序长时间占用剪贴板，然后重试。',
        detail: raw,
      };
    }
    return {
      code: 'WINDOWS_AUTOMATION_FAILED',
      message: 'Windows 自动粘贴失败。请确认 Codex Desktop 正在当前用户桌面运行，且服务不是在锁屏、UAC 或非交互会话里运行。',
      detail: raw,
    };
  }
  if (lower.includes('assistive') || lower.includes('accessibility') || lower.includes('-25211') || lower.includes('not allowed') || lower.includes('not authorized')) {
    return {
      code: 'ACCESSIBILITY_PERMISSION_REQUIRED',
      message: 'Mac 还没有允许这个终端控制键盘。请到 系统设置 → 隐私与安全性 → 辅助功能，允许 Terminal / Ghostty / Codex 正在使用的终端，然后重启服务再试。',
      detail: raw,
    };
  }
  return {
    code: 'MAC_AUTOMATION_FAILED',
    message: 'Mac 自动粘贴失败。请确认当前有可输入的前台应用，并检查辅助功能权限。',
    detail: raw,
  };
}

function explainTargetError(error, target) {
  const raw = String(error && (error.stderr || error.message) || '');
  if (target === 'codex') {
    if (process.platform === 'win32') {
      return {
        code: 'CODEX_FOCUS_FAILED',
        message: '已经收到文字，但没能自动聚焦 Codex 输入框。请确认 Codex Desktop 正在当前 Windows 桌面运行，且服务不是在锁屏或非交互会话里运行。',
        detail: raw,
      };
    }
    return {
      code: 'CODEX_FOCUS_FAILED',
      message: '已经收到文字，但没能自动聚焦 Codex 输入框。请确认 Codex 正在运行，且当前终端已开启辅助功能权限。',
      detail: raw,
    };
  }
  return explainAutomationError(error);
}

async function copyTextToClipboard(text) {
  return platform.copyTextToClipboard(text);
}

function getClickTool() {
  for (const candidate of ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function toCliclickAbsolutePoint(point) {
  // cliclick treats leading +/- as relative movement. Prefix negative absolute
  // coordinates with '=' for multi-display layouts above/left of the main screen.
  return point.split(',').map(part => part.startsWith('-') ? `=${part}` : part).join(',');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasFreshCodexThreadActivation(threadId) {
  return false;
}

async function focusTarget(target, threadId = '', options = {}) {
  return platform.focusTarget(target, threadId, options);
}

function codexFocusOptions(threadId = '', options = {}) {
  if (process.platform !== 'win32') return options;
  const normalized = {
    ...options,
    skipComposerClick: options.forceComposerClick === true ? false : true,
  };
  if (
    isCodexThreadId(threadId) &&
    (options.bounceViaNewThread === true || process.env.CODEX_MAX_WIN32_ALWAYS_NEW_THREAD_BOUNCE === '1' || process.env.CODEX_MINI_WIN32_ALWAYS_NEW_THREAD_BOUNCE === '1')
  ) {
    return { ...normalized, bounceViaNewThread: true };
  }
  return normalized;
}

async function activateCodexThread(threadId = '', options = {}) {
  return platform.activateCodexThread(threadId, options);
}

async function activateNewCodexThread(cwd = '') {
  return platform.activateNewCodexThread(cwd);
}

async function activateNewProjectlessCodexThread(anchorThreadId = '') {
  return platform.activateNewProjectlessCodexThread(anchorThreadId);
}

function validLocalDirectory(value) {
  const normalized = value ? path.normalize(value) : '';
  if (!normalized || !path.isAbsolute(normalized)) return '';
  try {
    return fs.statSync(normalized).isDirectory() ? normalized : '';
  } catch {
    return '';
  }
}

function normalizeNewThreadScope(payload = {}) {
  const raw = typeof payload.scope === 'string' ? payload.scope.trim().toLowerCase() : '';
  if (raw === 'conversation' || raw === 'project') return raw;
  if (payload.isProjectThread === false) return 'conversation';
  if (payload.isProjectThread === true) return 'project';
  return '';
}

function projectCwdOrEmpty(value) {
  const cwd = validLocalDirectory(value);
  if (!cwd) return '';
  return classifyThreadProject(cwd).isProjectThread ? cwd : '';
}

function resolveNewThreadTarget(payload = {}) {
  const scope = normalizeNewThreadScope(payload);
  const projectPath = projectCwdOrEmpty(typeof payload.projectPath === 'string' ? payload.projectPath : '');
  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';

  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('任务 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }

  if (scope === 'conversation') {
    return { scope: 'conversation', cwd: '', anchorThreadId: threadId };
  }

  if (scope === 'project' && projectPath) {
    return { scope: 'project', cwd: projectPath, anchorThreadId: threadId };
  }

  if (threadId) {
    const file = findCodexSessionFileByThreadId(threadId);
    const metaCwd = file ? readSessionMeta(file).cwd || '' : '';
    const metaProject = classifyThreadProject(validLocalDirectory(metaCwd) || '');
    if (metaProject.isProjectThread) {
      return { scope: 'project', cwd: metaProject.projectPath, anchorThreadId: threadId };
    }
    return { scope: 'conversation', cwd: '', anchorThreadId: threadId };
  }

  if (projectPath) return { scope: 'project', cwd: projectPath, anchorThreadId: '' };
  return { scope: 'conversation', cwd: '', anchorThreadId: '' };
}

async function handleNewCodexThread(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const target = resolveNewThreadTarget(payload);
    const project = classifyThreadProject(target.cwd);
    try {
      const started = await codexAppServer.startThread({ cwd: project.isProjectThread ? target.cwd : '' });
      const threadId = started.thread.id;
      invalidateCodexThreadListCache();
      return json(res, 200, {
        ok: true,
        pending: false,
        transport: 'app-server',
        threadId,
        cwd: project.isProjectThread ? target.cwd : '',
        projectName: project.projectName,
        projectPath: project.projectPath,
        projectKey: project.projectKey,
        scope: project.isProjectThread ? 'project' : 'conversation',
        message: project.isProjectThread
          ? `已在“${project.projectName}”中新建任务。`
          : '已新建一个对话任务。',
      });
    } catch (appServerError) {
      if (project.isProjectThread) {
        await activateNewCodexThread(target.cwd);
      } else {
        await activateNewProjectlessCodexThread(target.anchorThreadId);
      }
      return json(res, 200, {
        ok: true,
        pending: true,
        transport: 'desktop-gui',
        appServerError: appServerError.message || String(appServerError),
        cwd: project.isProjectThread ? target.cwd : '',
        projectName: project.projectName,
        projectPath: project.projectPath,
        projectKey: project.projectKey,
        scope: project.isProjectThread ? 'project' : 'conversation',
        message: project.isProjectThread
          ? `已在 ChatGPT Desktop 打开“${project.projectName}”的新任务。`
          : '已在 ChatGPT Desktop 打开一个新的对话任务。',
      });
    }
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '新建任务失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

// createScheduledTaskRecord 已迁移到 src/scheduler 模块

// ===== 调度器已迁移到 Scheduler 模块 =====
function scheduledTaskSummary() {
  return scheduler.getTasks();
}

function startScheduledTaskRunner() {
  scheduler.start();
}

function stopScheduledTaskRunner() {
  scheduler.stop();
}

async function handleSchedules(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const workspace = await listWorkspaceThreads(160);
  const projects = existingProjectCwds(workspace.threads).map(cwd => ({ cwd, name: displayPathName(cwd) }));
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, schedules: scheduler.getTasks(), projects });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const action = String(payload.action || '').trim();
  const id = String(payload.id || '').trim();
  try {
    if (action === 'create') {
      const task = scheduler.createTask(payload);
      return json(res, 200, { ok: true, schedule: task, schedules: scheduler.getTasks(), projects, message: '已创建计划。' });
    }
    if (action === 'update') {
      const task = scheduler.updateTask(id, payload);
      return json(res, 200, { ok: true, schedule: task, schedules: scheduler.getTasks(), projects, message: '已更新计划。' });
    }
    if (action === 'toggle') {
      const enabled = payload.enabled === true;
      const task = scheduler.toggleTask(id, enabled);
      return json(res, 200, { ok: true, schedule: task, schedules: scheduler.getTasks(), projects, message: enabled ? '已启用计划。' : '已暂停计划。' });
    }
    if (action === 'delete') {
      scheduler.deleteTask(id);
      return json(res, 200, { ok: true, schedules: scheduler.getTasks(), projects, message: '已删除计划。' });
    }
    if (action === 'run') {
      await scheduler.runTask(id, { force: true });
      return json(res, 200, { ok: true, schedules: scheduler.getTasks(), projects, message: '已提交本次计划。' });
    }
    return json(res, 400, { ok: false, code: 'BAD_SCHEDULE_ACTION', message: '不支持的计划操作。' });
  } catch (error) {
    return json(res, error?.status || 500, {
      ok: false,
      code: error?.code || 'SCHEDULE_FAILED',
      message: error?.message || '计划操作失败。',
    });
  }
}

async function handlePromptLibrary(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const state = readCodexMiniState();
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, prompts: state.promptLibrary });
  }
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }
  const action = String(payload.action || '').trim();
  const id = String(payload.id || '').trim();
  let prompts = state.promptLibrary;
  try {
    if (action === 'create') {
      const title = String(payload.title || '').trim().slice(0, 60);
      const text = String(payload.text || '').trim().slice(0, 4000);
      if (!title || !text) {
        return json(res, 400, { ok: false, code: 'BAD_PROMPT', message: '提示词标题和内容不能为空。' });
      }
      const now = Date.now();
      prompts = [...prompts, {
        id: `p_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        text,
        createdAt: now,
        updatedAt: now,
      }].slice(-MAX_PROMPT_LIBRARY_ITEMS);
      writeCodexMiniState({ ...state, promptLibrary: prompts });
      return json(res, 200, { ok: true, prompts, message: '已保存提示词。' });
    }
    if (action === 'update') {
      const existing = prompts.find(item => item.id === id);
      if (!existing) {
        return json(res, 404, { ok: false, code: 'PROMPT_NOT_FOUND', message: '没有找到这条提示词。' });
      }
      const title = String(payload.title !== undefined ? payload.title : existing.title).trim().slice(0, 60);
      const text = String(payload.text !== undefined ? payload.text : existing.text).trim().slice(0, 4000);
      if (!title || !text) {
        return json(res, 400, { ok: false, code: 'BAD_PROMPT', message: '提示词标题和内容不能为空。' });
      }
      prompts = prompts.map(item => item.id === id ? { ...item, title, text, updatedAt: Date.now() } : item);
      writeCodexMiniState({ ...state, promptLibrary: prompts });
      return json(res, 200, { ok: true, prompts, message: '已更新提示词。' });
    }
    if (action === 'delete') {
      prompts = prompts.filter(item => item.id !== id);
      writeCodexMiniState({ ...state, promptLibrary: prompts });
      return json(res, 200, { ok: true, prompts, message: '已删除提示词。' });
    }
    return json(res, 400, { ok: false, code: 'BAD_PROMPT_ACTION', message: '不支持的提示词库操作。' });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      code: 'PROMPT_LIBRARY_FAILED',
      message: '提示词库操作失败。',
      detail: String(error && error.message || error),
    });
  }
}

function sanitizeFileName(name, fallback = 'image') {
  const base = path.basename(String(name || fallback)).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return base || fallback;
}

function extensionForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/heic') return '.heic';
  return '.img';
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function decodeAttachment(attachment, index) {
  const mime = String(attachment && attachment.type || '').toLowerCase();
  if (!mime.startsWith('image/')) throw new Error('目前只支持图片附件。');
  const dataUrl = String(attachment.dataUrl || '');
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('图片数据格式不正确。');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`单张图片太大，请控制在 ${formatBytes(MAX_ATTACHMENT_BYTES)} 以内。`);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = extensionForMime(mime);
  const fileName = `${Date.now()}-${index}-${sanitizeFileName(attachment.name || `image${ext}`)}`;
  const safeName = fileName.endsWith(ext) ? fileName : `${fileName}${ext}`;
  const uploadRoot = path.resolve(UPLOAD_DIR);
  const filePath = path.resolve(uploadRoot, safeName);
  const relative = path.relative(uploadRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('图片文件名不正确。');
  fs.writeFileSync(filePath, buffer);
  return { filePath, mime, name: attachment.name || path.basename(filePath), size: buffer.length };
}

function decodeAttachments(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_ATTACHMENTS) throw new Error(`图片最多一次发送 ${MAX_ATTACHMENTS} 张。`);
  return input.map(decodeAttachment);
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function copyImageToClipboard(file) {
  return platform.copyImageToClipboard(file);
}

async function pressPaste() {
  return platform.pressPaste();
}

async function pressPasteAndEnter() {
  // Keep paste and return as separate automation events. Electron/Codex can
  // accept the pasted text asynchronously; if Return is posted too quickly
  // (especially after iOS dictation commits), the text appears in the composer
  // but the submit key can be swallowed. A short explicit settle plus a fresh
  // System Events command makes the submit step reliable without changing the
  // rest of the send flow.
  await pressPaste();
  await delay(TEXT_PASTE_SETTLE_MS);
  await pressEnter();
}

async function typeTextAndEnter(text) {
  await pasteTextAndEnter(text);
}

async function pasteTextAndEnter(text) {
  if (platform.pasteTextAndEnter) {
    await platform.pasteTextAndEnter(text);
    return;
  }
  await copyTextToClipboard(text);
  await pressPasteAndEnter();
}

async function pasteCodexCommandSelection(command, selection, options = {}) {
  if (platform.runCodexCommandSelection) {
    await platform.runCodexCommandSelection(command, selection, options);
    return;
  }
  await pasteTextAndEnter(command);
  await delay(options.commandSettleMs || CODEX_COMMAND_SETTLE_MS);
  await pasteTextAndEnter(selection);
  await delay(options.selectionSettleMs || CODEX_COMMAND_SETTLE_MS);
}

async function pressEnter() {
  return platform.pressEnter();
}

async function pressCodexShortcut(key, modifiers = []) {
  return platform.pressCodexShortcut(key, modifiers);
}

async function pressCancelCodexResponse() {
  return platform.pressCancelCodexResponse();
}


async function pasteAndEnter(text, target = 'frontmost', attachments = [], threadId = '', options = {}) {
  if (process.platform === 'win32' && target === 'codex') {
    return platform.runExclusive(async () => {
      if (!attachments.length) {
        if (!options.assumeThreadSynced && isCodexThreadId(threadId)) {
          await activateCodexThread(threadId, { allowCached: false });
        }
        if (text) {
          await pasteTextAndEnter(text);
          return;
        }
        await pressEnter();
        return;
      }

      if (!options.assumeThreadSynced && isCodexThreadId(threadId)) {
        await activateCodexThread(threadId, { allowCached: false, preferCdp: false });
      } else {
        await focusTarget('codex', threadId, { ...codexFocusOptions(threadId, options), preferCdp: false });
      }
      for (const attachment of attachments) {
        await copyImageToClipboard(attachment);
        await pressPaste();
        await delay(ATTACHMENT_PASTE_SETTLE_MS);
      }
      if (text) {
        await copyTextToClipboard(text);
        await pressPasteAndEnter();
        return;
      }
      await pressEnter();
    });
  }

  return platform.withClipboardPreserved(async () => {
    await focusTarget(target, threadId, target === 'codex' ? codexFocusOptions(threadId, options) : options);

    for (const attachment of attachments) {
      await copyImageToClipboard(attachment);
      await pressPaste();
      await delay(ATTACHMENT_PASTE_SETTLE_MS);
    }

    if (text) {
      await pasteTextAndEnter(text);
      return;
    }

    await pressEnter();
  });
}

function modelSwitchTargetForCurrent(current = {}, requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  const catalogTarget = findModelOption(explicit);
  if (catalogTarget) return catalogTarget;
  if (!explicit) {
    const options = readModelCatalogOptions();
    if (options.length) return options[0];
  }
  const error = new Error(explicit ? '未找到这个模型。' : '没有读取到可切换的模型。');
  error.status = 400;
  error.code = 'MODEL_TARGET_NOT_FOUND';
  throw error;
}

async function switchCodexGuiModel(threadId = '', targetKey = '', options = {}) {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('任务 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
  const targetThreadId = threadId || (file ? threadIdFromSessionFile(file) : '');
  const current = file ? currentModelFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : modelInfoFromId('');
  const target = modelSwitchTargetForCurrent(current, targetKey);

  if (process.platform === 'win32') {
    await platform.runExclusive(async () => {
      if (!options.assumeThreadSynced && isCodexThreadId(targetThreadId)) {
        await activateCodexThread(targetThreadId, { allowCached: false });
      }
      await pasteCodexCommandSelection('/模型', target.displayName, {
        commandSettleMs: CODEX_MODEL_COMMAND_SETTLE_MS,
        selectionSettleMs: CODEX_COMMAND_SETTLE_MS,
        timeoutMs: 10000,
      });
    });
    return {
      ok: true,
      verified: false,
      threadId: targetThreadId,
      currentModel: current,
      targetModel: { ...target, available: true, updatedAt: new Date().toISOString() },
      focusFallback: '',
      message: `已向 Codex 发送模型切换命令：${target.displayName}`,
    };
  }

  return platform.withClipboardPreserved(async () => {
    await focusTarget('codex', targetThreadId, codexFocusOptions(targetThreadId));
    await pasteCodexCommandSelection('/模型', target.displayName, {
      commandSettleMs: CODEX_MODEL_COMMAND_SETTLE_MS,
      selectionSettleMs: CODEX_COMMAND_SETTLE_MS,
      timeoutMs: 10000,
    });
    const verifiedToolbar = await verifyWindowsToolbarSwitch('model', target);
    return {
      ok: true,
      verified: true,
      threadId: targetThreadId,
      currentModel: current,
      targetModel: { ...target, available: true, updatedAt: new Date().toISOString() },
      toolbar: verifiedToolbar || undefined,
      focusFallback: '',
      message: `已切换到 ${target.displayName}`,
    };
  });
}

function reasoningModeTargetForCurrent(current = {}, requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  if (REASONING_MODE_TARGETS[explicit]) return REASONING_MODE_TARGETS[explicit];
  const order = ['low', 'medium', 'high', 'xhigh'];
  const currentIndex = order.indexOf(current.key);
  const nextKey = order[(currentIndex + 1 + order.length) % order.length] || 'medium';
  return REASONING_MODE_TARGETS[nextKey] || REASONING_MODE_TARGETS.medium;
}

function createSwitchVerificationError(kind, expected, actual = {}) {
  const raw = actual && actual.raw ? `当前 Codex 显示为 ${actual.raw}` : '没有读到 Codex 底部模型/推理状态';
  const label = kind === 'model' ? '模型' : '推理模式';
  const error = new Error(`${label}没有实际切换成功，${raw}。`);
  error.status = 409;
  error.code = kind === 'model' ? 'MODEL_SWITCH_NOT_APPLIED' : 'REASONING_SWITCH_NOT_APPLIED';
  error.actual = actual;
  error.expected = expected;
  return error;
}

function modelLabelsMatch(expected = {}, actualLabel = '') {
  const actual = String(actualLabel || '').trim().toLowerCase();
  if (!actual) return false;
  const candidates = [
    expected.label,
    expected.displayName,
    expected.id,
    expected.key,
    labelFromModelName(expected.displayName || expected.id || expected.key || ''),
  ]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return candidates.some(value => value === actual || value.includes(actual) || actual.includes(value));
}

async function verifyWindowsToolbarSwitch(kind, target) {
  if (process.platform !== 'win32' || !platform.getToolbarState) return null;
  let state = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await delay(attempt ? 350 : 180);
    state = await platform.getToolbarState();
    if (kind === 'reasoning' && state && state.reasoningLabel === target.displayName) return state;
    if (kind === 'model' && state && modelLabelsMatch(target, state.modelLabel)) return state;
  }
  throw createSwitchVerificationError(kind, target, state);
}

async function switchCodexReasoningMode(threadId = '', targetKey = '', options = {}) {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('任务 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
  const targetThreadId = threadId || (file ? threadIdFromSessionFile(file) : '');
  const current = file ? currentReasoningModeFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : reasoningModeFromValue('');
  const target = reasoningModeTargetForCurrent(current, targetKey);

  if (process.platform === 'win32') {
    if (platform.switchReasoningMode) {
      try {
        const toolbar = await platform.runExclusive(async () => {
          if (!options.assumeThreadSynced && isCodexThreadId(targetThreadId)) {
            await activateCodexThread(targetThreadId, { allowCached: false });
          }
          return platform.switchReasoningMode(target.key);
        });
        return {
          ok: true,
          verified: true,
          threadId: targetThreadId,
          currentReasoningMode: current,
          targetReasoningMode: { ...target, available: true, updatedAt: new Date().toISOString() },
          toolbar,
          focusFallback: '',
          message: `已切换推理模式为 ${target.displayName}`,
        };
      } catch (error) {
        const wrapped = new Error(`CDP 推理模式切换失败：${error.message || '未知错误'}`);
        wrapped.status = error.code === 'CDP_BAD_REASONING_TARGET' ? 400 : 503;
        wrapped.code = error.code || 'CDP_REASONING_FAILED';
        throw wrapped;
      }
    }

    await platform.runExclusive(async () => {
      if (!options.assumeThreadSynced && isCodexThreadId(targetThreadId)) {
        await activateCodexThread(targetThreadId, { allowCached: false });
      }
      await pasteCodexCommandSelection('/推理模式', target.displayName, {
        commandSettleMs: CODEX_REASONING_COMMAND_SETTLE_MS,
        selectionSettleMs: CODEX_COMMAND_SETTLE_MS,
        timeoutMs: 10000,
      });
    });
    return {
      ok: true,
      verified: false,
      threadId: targetThreadId,
      currentReasoningMode: current,
      targetReasoningMode: { ...target, available: true, updatedAt: new Date().toISOString() },
      focusFallback: '',
      message: `已向 Codex 发送推理模式切换命令：${target.displayName}`,
    };
  }

  return platform.withClipboardPreserved(async () => {
    await focusTarget('codex', targetThreadId, codexFocusOptions(targetThreadId));
    await pasteCodexCommandSelection('/推理模式', target.displayName, {
      commandSettleMs: CODEX_REASONING_COMMAND_SETTLE_MS,
      selectionSettleMs: CODEX_COMMAND_SETTLE_MS,
      timeoutMs: 10000,
    });
    const verifiedToolbar = await verifyWindowsToolbarSwitch('reasoning', target);
    return {
      ok: true,
      verified: true,
      threadId: targetThreadId,
      currentReasoningMode: current,
      targetReasoningMode: { ...target, available: true, updatedAt: new Date().toISOString() },
      toolbar: verifiedToolbar || undefined,
      focusFallback: '',
      message: `已切换推理模式为 ${target.displayName}`,
    };
  });
}

async function stopCodexResponse(threadId = '') {
  return platform.runExclusive(async () => {
    await focusTarget('codex', threadId, codexFocusOptions(threadId));
    await pressCancelCodexResponse();
  });
}

async function runCodexThreadCommand(threadId, command, options = {}) {
  return platform.withClipboardPreserved(async () => {
    if (threadId && !isCodexThreadId(threadId)) {
      const error = new Error('任务 ID 不正确。');
      error.status = 400;
      error.code = 'BAD_THREAD_ID';
      throw error;
    }
    await activateCodexThread(threadId);

    if (command === 'archive') {
      await pressCodexShortcut('a', ['command', 'shift']);
      await delay(CODEX_COMMAND_SETTLE_MS);
      return { message: '已归档当前 Codex 任务。' };
    }

    if (command === 'pin') {
      await pressCodexShortcut('p', ['command', 'option']);
      await delay(CODEX_COMMAND_SETTLE_MS);
      return { message: options.pinned ? '已置顶当前 Codex 任务。' : '已取消置顶当前 Codex 任务。' };
    }

    if (command === 'rename') {
      const name = String(options.name || '').replace(/\s+/g, ' ').trim();
      if (!name) {
        const error = new Error('新名称不能为空。');
        error.status = 400;
        error.code = 'EMPTY_THREAD_NAME';
        throw error;
      }
      if (name.length > 120) {
        const error = new Error('新名称太长，请控制在 120 个字符以内。');
        error.status = 400;
        error.code = 'THREAD_NAME_TOO_LONG';
        throw error;
      }
      await pressCodexShortcut('r', ['command', 'option']);
      await delay(CODEX_COMMAND_SETTLE_MS);
      await copyTextToClipboard(name);
      await pressPaste();
      await delay(120);
      await pressEnter();
      await delay(CODEX_COMMAND_SETTLE_MS);
      return { message: '已重命名当前 Codex 任务。', name };
    }

    const error = new Error('不支持的任务操作。');
    error.status = 400;
    error.code = 'BAD_THREAD_ACTION';
    throw error;
  });
}

async function handleThreadAction(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const action = String(payload.action || '').trim();
  if (!isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
  }

  try {
    const state = readCodexMiniState();
    let result;
    if (action === 'archive') {
      try {
        await codexAppServer.archiveThread(threadId);
        result = { message: '已归档当前任务。', transport: 'app-server' };
      } catch (appServerError) {
        result = await runCodexThreadCommand(threadId, 'archive');
        result.transport = 'desktop-gui';
        result.appServerError = appServerError.message || String(appServerError);
      }
      state.archivedThreadIds = setThreadSetMembership(state.archivedThreadIds, threadId, true);
      state.pinnedThreadIds = setThreadSetMembership(state.pinnedThreadIds, threadId, false);
    } else if (action === 'pin' || action === 'unpin') {
      const pinned = action === 'pin';
      try {
        await codexAppServer.setThreadPinned(threadId, pinned);
        result = {
          message: pinned ? '已置顶当前任务。' : '已取消置顶当前任务。',
          transport: 'app-server',
        };
      } catch (appServerError) {
        result = await runCodexThreadCommand(threadId, 'pin', { pinned });
        result.transport = 'desktop-gui';
        result.appServerError = appServerError.message || String(appServerError);
      }
      state.pinnedThreadIds = setThreadSetMembership(state.pinnedThreadIds, threadId, pinned);
    } else if (action === 'compact') {
      await codexAppServer.compactThread(threadId);
      result = {
        message: '已开始压缩当前任务的上下文。',
        transport: 'app-server',
      };
    } else if (action === 'review') {
      const review = await codexAppServer.startReview(threadId, {
        delivery: 'inline',
        target: { type: 'uncommittedChanges' },
      });
      result = {
        message: '已开始审查当前项目的未提交改动。',
        transport: 'app-server',
        turnId: review?.turn?.id || '',
        reviewThreadId: review?.reviewThreadId || threadId,
      };
    } else if (action === 'rename') {
      const name = String(payload.name || '').replace(/\s+/g, ' ').trim();
      if (!name) {
        return json(res, 400, { ok: false, code: 'EMPTY_THREAD_NAME', message: '新名称不能为空。' });
      }
      if (name.length > 120) {
        return json(res, 400, { ok: false, code: 'THREAD_NAME_TOO_LONG', message: '新名称太长，请控制在 120 个字符以内。' });
      }
      try {
        await codexAppServer.setThreadName(threadId, name);
        result = { message: '已重命名当前任务。', name, transport: 'app-server' };
      } catch (appServerError) {
        result = await runCodexThreadCommand(threadId, 'rename', { name });
        result.transport = 'desktop-gui';
        result.appServerError = appServerError.message || String(appServerError);
      }
      state.titleOverrides = state.titleOverrides || {};
      state.titleOverrides[threadId] = { name: result.name, renamedAt: new Date().toISOString() };
    } else {
      return json(res, 400, { ok: false, code: 'BAD_THREAD_ACTION', message: '不支持的任务操作。' });
    }
    writeCodexMiniState(state);
    const nextThreadId = action === 'archive' ? (listCodexThreads(120)[0]?.id || '') : threadId;
    return json(res, 200, { ok: true, action, threadId, nextThreadId, ...result });
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '任务操作失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function handleStopCodex(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  if (threadId && !isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
  }

  try {
    const runtime = codexAppServer.runtimeForThread(threadId);
    if (threadId && runtime?.status === 'running' && runtime.activeTurnId) {
      await codexAppServer.interrupt(threadId, runtime.activeTurnId);
      return json(res, 200, { ok: true, threadId, transport: 'app-server', message: '已停止当前回复。' });
    }
    await stopCodexResponse(threadId);
    return json(res, 200, { ok: true, threadId, transport: 'desktop-gui', message: '已向 ChatGPT Desktop 发送停止指令。' });
  } catch (error) {
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function handleModelSwitch(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  const assumeThreadSynced = payload.assumeThreadSynced === true;
  try {
    if (isCodexThreadId(threadId) && target) {
      try {
        const models = await codexAppServer.listModels();
        const model = models.find(item => item.id === target || item.model === target);
        if (!model) {
          const error = new Error('未找到这个模型。');
          error.status = 400;
          error.code = 'MODEL_TARGET_NOT_FOUND';
          throw error;
        }
        const file = findCodexSessionFileByThreadId(threadId);
        const current = file ? currentModelFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : modelInfoFromId('');
        await codexAppServer.updateThreadSettings(threadId, { model: model.model || model.id });
        return json(res, 200, {
          ok: true,
          verified: true,
          transport: 'app-server',
          threadId,
          currentModel: current,
          targetModel: {
            available: true,
            key: model.id,
            id: model.id,
            label: labelFromModelName(model.displayName || model.id),
            displayName: model.displayName || model.id,
            source: 'app-server',
            updatedAt: new Date().toISOString(),
          },
          message: `后续回复将使用 ${model.displayName || model.id}`,
        });
      } catch (appServerError) {
        if (appServerError.status && appServerError.code !== 'MODEL_TARGET_NOT_FOUND') throw appServerError;
      }
    }
    const result = await switchCodexGuiModel(threadId, target, { assumeThreadSynced });
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '切换模型失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained, message: '没能通过 Codex GUI 切换模型。请确认 Codex Desktop 正在运行，且当前系统的自动化权限正常。' });
  }
}

async function handleReasoningMode(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  const assumeThreadSynced = payload.assumeThreadSynced === true;
  try {
    if (isCodexThreadId(threadId) && REASONING_MODE_TARGETS[target]) {
      try {
        const file = findCodexSessionFileByThreadId(threadId);
        const current = file ? currentReasoningModeFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : reasoningModeFromValue('');
        const targetMode = REASONING_MODE_TARGETS[target];
        await codexAppServer.updateThreadSettings(threadId, { effort: targetMode.value });
        return json(res, 200, {
          ok: true,
          verified: true,
          transport: 'app-server',
          threadId,
          currentReasoningMode: current,
          targetReasoningMode: { ...targetMode, available: true, updatedAt: new Date().toISOString() },
          message: `后续回复的推理等级为${targetMode.displayName}`,
        });
      } catch {}
    }
    const result = await switchCodexReasoningMode(threadId, target, { assumeThreadSynced });
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '切换推理模式失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained, message: '没能通过 Codex GUI 切换推理模式。请确认 Codex Desktop 正在运行，且当前系统的自动化权限正常。' });
  }
}

async function handleSend(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。请使用启动服务时打印出来的完整手机链接。' });
  }

  let payload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body || '{}');
  } catch (error) {
    return json(res, error.status || 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const text = typeof payload.text === 'string' ? payload.text : '';
  const target = payload.target === 'codex' ? 'codex' : 'frontmost';
  const selectedThreadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const assumeThreadSynced = payload.assumeThreadSynced === true;
  const expectNewThread = payload.expectNewThread === true && target === 'codex' && !selectedThreadId;
  const directPasteWithoutClick = process.platform === 'win32' && target === 'codex'
    ? payload.forceComposerClick !== true
    : payload.directPasteWithoutClick === true && expectNewThread;
  const previousThreadId = isCodexThreadId(payload.previousThreadId) ? payload.previousThreadId : '';
  const expectedNewThreadCwd = validLocalDirectory(typeof payload.expectedCwd === 'string' ? payload.expectedCwd : '');
  const clientRequestId = normalizeClientRequestId(payload.clientRequestId);
  cleanupRecentSendRequests();
  if (clientRequestId) {
    const existing = recentSendRequests.get(clientRequestId);
    if (existing?.result) return json(res, 200, { ...existing.result, duplicate: true });
    if (existing?.watch) {
      return json(res, 200, {
        ok: true,
        duplicate: true,
        message: '这条发送请求已经被接收，正在继续等待 Codex 回复。',
        target,
        sentAt: existing.sentAt,
        watch: existing.watch,
      });
    }
  }
  let attachments = [];
  try {
    attachments = decodeAttachments(payload.attachments);
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_ATTACHMENT', message: error.message || '图片附件不正确。' });
  }
  if (!text.trim() && !attachments.length) {
    return json(res, 400, { ok: false, code: 'EMPTY_TEXT', message: '请输入文字或添加图片。' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return json(res, 413, { ok: false, code: 'TEXT_TOO_LONG', message: `文字太长了，请控制在 ${MAX_TEXT_LENGTH} 字以内。` });
  }

  try {
    const watchSince = new Date(Date.now() - 750).toISOString();
    const watchSinceMs = Date.parse(watchSince) || Date.now();
    const watchFile = expectNewThread ? null : selectedThreadId ? findCodexSessionFileByThreadId(selectedThreadId) : findLatestCodexSessionFile();
    let watch = target === 'codex' ? {
      since: watchSince,
      threadId: selectedThreadId,
      sessionFile: watchFile ? path.basename(watchFile) : '',
      expectNewThread,
      excludeThreadId: expectNewThread ? previousThreadId : '',
      cwd: expectNewThread ? expectedNewThreadCwd : '',
    } : null;
    if (clientRequestId) {
      recentSendRequests.set(clientRequestId, {
        createdAt: Date.now(),
        sentAt: new Date().toISOString(),
        watch,
      });
    }
    const effectiveThreadId = selectedThreadId || (watchFile ? threadIdFromSessionFile(watchFile) : '');
    let directResult = null;
    let appServerError = null;
    if (target === 'codex') {
      const fileStatus = effectiveThreadId ? parseCodexStatus({ threadId: effectiveThreadId }) : null;
      const appRuntime = effectiveThreadId ? codexAppServer.runtimeForThread(effectiveThreadId) : null;
      const externallyActive = Boolean(fileStatus?.active && !(appRuntime?.status === 'running' && appRuntime.activeTurnId));
      if (!externallyActive) {
        try {
          directResult = await codexAppServer.sendTurn({
            threadId: effectiveThreadId,
            cwd: expectedNewThreadCwd,
            text,
            imagePaths: attachments.map(item => item.filePath),
            clientUserMessageId: clientRequestId || undefined,
          });
          const directThreadId = directResult.threadId;
          const directFile = findCodexSessionFileByThreadId(directThreadId);
          watch = {
            since: watchSince,
            threadId: directThreadId,
            sessionFile: directFile ? path.basename(directFile) : '',
            expectNewThread: false,
            excludeThreadId: '',
            cwd: '',
          };
        } catch (error) {
          appServerError = error;
        }
      }
    }

    if (!directResult) {
      const sendOptions = { assumeThreadSynced, expectNewThread, skipComposerClick: directPasteWithoutClick };
      await pasteAndEnter(text, target, attachments, effectiveThreadId, sendOptions);
    }
    if (!directResult && expectNewThread && watch) {
      const newSessionFile = await waitForCodexSessionFileForNewSend({
        sinceMs: watchSinceMs,
        text,
        cwd: expectedNewThreadCwd,
        excludeThreadId: previousThreadId,
      });
      if (newSessionFile) {
        watch = {
          ...watch,
          threadId: threadIdFromSessionFile(newSessionFile),
          sessionFile: path.basename(newSessionFile),
          expectNewThread: false,
          excludeThreadId: '',
        };
      }
    }
    const result = {
      ok: true,
      message: directResult
        ? (directResult.steered ? '已追加到正在运行的任务。' : '已通过 Codex App Server 发送。')
        : target === 'codex' ? '已发送到 ChatGPT Desktop。' : '已粘贴并按下回车。',
      target,
      transport: directResult ? 'app-server' : target === 'codex' ? 'desktop-gui' : 'frontmost',
      sentAt: new Date().toISOString(),
      attachments: attachments.map(item => ({ name: item.name, size: item.size, type: item.mime })),
      watch,
      focusFallback: '',
    };
    if (appServerError) result.appServerError = appServerError.message || String(appServerError);
    if (clientRequestId) {
      recentSendRequests.set(clientRequestId, {
        createdAt: Date.now(),
        sentAt: result.sentAt,
        watch,
        result,
      });
    }
    persistentQueue.logExecution(effectiveThreadId, 'send', 'completed', 0, '', { transport: result.transport, sentAt: result.sentAt });
    fireWebhook('send.completed', { threadId: effectiveThreadId || '', target, transport: result.transport });
    return json(res, 200, result);
  } catch (error) {
    if (clientRequestId) recentSendRequests.delete(clientRequestId);
    const explained = explainTargetError(error, target);
    persistentQueue.logExecution(effectiveThreadId || '', 'send', 'failed', 0, explained.message || error.message || String(error), {});
    fireWebhook('send.failed', { threadId: effectiveThreadId || '', target, error: explained.message || error.message || String(error) });
    return json(res, 500, { ok: false, ...explained });
  }
}

// 静态资源 LRU 内存缓存（避免高频页面/图标重复读盘；超过 256KB 或 200 项自动淘汰）
const staticFileCache = new Map();
const STATIC_CACHE_MAX_ITEMS = 200;
const STATIC_CACHE_MAX_BYTES = 256 * 1024;
// 缓存命中后跳过磁盘 stat 的 TTL（毫秒）：静态资源几乎不会在 1 秒内变更，
// 到期后仍会做 mtime/size 校验，保证文件更新可感知
const STATIC_CACHE_STAT_TTL_MS = 1000;

function resolveStaticFilePath(rootDir, requestPathname) {
  const relativePath = String(requestPathname || '/').replace(/^\/+/, '') || 'index.html';
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..' || segment.includes('\0'))) return '';
  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, ...segments);
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? filePath : '';
}

function serveStatic(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    return res.end('Bad Request');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    return res.end('Bad Request');
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = resolveStaticFilePath(PUBLIC_DIR, pathname);
  if (!filePath) {
    res.writeHead(403, { 'x-content-type-options': 'nosniff' });
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath);
  const cacheKey = filePath;
  const now = Date.now();

  // 命中内存缓存且 TTL 内：跳过磁盘 stat，直接复用（热点静态资源零磁盘 I/O）
  const cached = staticFileCache.get(cacheKey);
  if (cached && now - cached.checkedAt < STATIC_CACHE_STAT_TTL_MS) {
    staticFileCache.delete(cacheKey); // LRU：移到末尾
    staticFileCache.set(cacheKey, cached);
    const headers = staticHeaders(ext, url, cached.size, cached.data.length, req);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : cached.data);
    return;
  }

  let stat = null;
  try { stat = fs.statSync(filePath); } catch {}

  // 命中缓存（mtime 与 size 未变则直接复用内存数据）
  if (stat && stat.isFile() && stat.size <= STATIC_CACHE_MAX_BYTES) {
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cached.checkedAt = now;
      staticFileCache.delete(cacheKey); // LRU：移到末尾
      staticFileCache.set(cacheKey, cached);
      const headers = staticHeaders(ext, url, stat.size, cached.data.length, req);
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : cached.data);
      return;
    }
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (cached) staticFileCache.delete(cacheKey);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
      return res.end('Not found');
    }
    // 可缓存的小文件写入 LRU
    if (stat && stat.isFile() && data.length <= STATIC_CACHE_MAX_BYTES) {
      if (staticFileCache.size >= STATIC_CACHE_MAX_ITEMS) {
        staticFileCache.delete(staticFileCache.keys().next().value);
      }
      staticFileCache.set(cacheKey, { data, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
    }
    const headers = staticHeaders(ext, url, data.length, data.length, req);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function staticHeaders(ext, url, contentLength, dataLength, req) {
  const headers = {
    'content-type': mimeTypes[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    'content-length': dataLength,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (ext === '.html') {
    headers['x-frame-options'] = 'DENY';
    // 单文件前端使用内联脚本/样式，CSP 限制外部资源加载与 iframe 嵌套
    headers['content-security-policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
  }
  if (ext === '.html' && security.isAuthorized(req)) {
    if (security.sessionFromRequest(req)) {
      headers['set-cookie'] = 'codexMiniToken=; Path=/; Max-Age=0; SameSite=Lax';
    } else {
      const created = sessionManager.createSession(req.headers['user-agent'] || '', { scope: security.tokenScopeFromRequest(req) });
      headers['set-cookie'] = [sessionManager.sessionCookie(created.token), 'codexMiniToken=; Path=/; Max-Age=0; SameSite=Lax'];
    }
  }
  return headers;
}

function parseVersionParts(version) {
  return String(version || '').split('.').map(part => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function compareVersions(a, b) {
  const ap = parseVersionParts(a);
  const bp = parseVersionParts(b);
  for (let i = 0; i < Math.max(ap.length, bp.length); i += 1) {
    const diff = (ap[i] || 0) - (bp[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function latestAndroidApkInfo() {
  let best = null;
  try {
    for (const entry of fs.readdirSync(DIST_ANDROID_DIR, { withFileTypes: true })) {
      const match = /^ChatGPT-AZ-Android-v([\d.]+)\.apk$/i.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const candidate = { version: match[1], name: entry.name };
      if (!best || compareVersions(candidate.version, best.version) > 0) best = candidate;
    }
  } catch {}
  return best;
}

function latestWindowsInstallerInfo() {
  try {
    const candidates = [
      'Codex-Remote-Bridge-Windows-Setup.exe',
      'ChatGPT-Win-Windows-Setup.exe',
    ];
    for (const name of candidates) {
      const file = path.join(DIST_WINDOWS_INSTALLER_DIR, name);
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      return { version: SERVICE_VERSION, name, size: stat.size };
    }
  } catch {}
  return null;
}

function updateInfo() {
  const android = latestAndroidApkInfo();
  const windows = latestWindowsInstallerInfo();
  return {
    service: SERVICE_VERSION,
    currentVersion: SERVICE_VERSION,
    channel: UPDATE_CHANNEL,
    repository: UPDATE_REPOSITORY,
    manifestUrl: UPDATE_MANIFEST_URL,
    releaseUrl: UPDATE_RELEASE_URL,
    android: android ? { latestVersion: android.version, fileName: android.name, available: true } : { available: false },
    windows: windows ? { latestVersion: windows.version, fileName: windows.name, size: windows.size, available: true } : { available: false },
  };
}

/** 本机所有非内部 IPv4 地址（证书 SAN 与局域网 URL 的共同来源）。 */
function getLanIPv4Addresses() {
  const nets = os.networkInterfaces();
  const addresses = new Set();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) addresses.add(net.address);
    }
  }
  return [...addresses];
}

const RUNTIME_INFO_FILE = path.join(STATE_DIR, 'runtime.json');

/**
 * 写出运行时连接信息，供 Windows/macOS 壳读取协议与证书指纹。
 * 内容不含 token：壳层自己有 token，这里只解决「服务到底起在 http 还是 https」与「该信任哪张证书」。
 */
function writeRuntimeInfo() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const payload = {
      protocol: LAN_PROTOCOL,
      tls: Boolean(CERT_FINGERPRINT),
      certFingerprint: CERT_FINGERPRINT || '',
      port: PORT,
      host: HOST,
      version: SERVICE_VERSION,
      lanAddresses: getLanIPv4Addresses(),
      updatedAt: new Date().toISOString(),
    };
    const tempFile = `${RUNTIME_INFO_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempFile, RUNTIME_INFO_FILE);
  } catch (error) {
    logger.warn('runtime_info_write_failed', { error: error && error.message || String(error) });
  }
}

function getLanApiBases() {
  const scheme = LAN_PROTOCOL === 'https' ? 'https' : 'http';
  return getLanIPv4Addresses().map(address => `${scheme}://${address}:${PORT}`);
}

async function handleClientConfig(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const extraHeaders = {};
  const sessionToken = security.sessionTokenFromRequest(req);
  if (security.sessionFromRequest(req)) {
    if (sessionToken) {
      extraHeaders['set-cookie'] = [sessionManager.sessionCookie(sessionToken), 'codexMiniToken=; Path=/; Max-Age=0; SameSite=Lax'];
    }
  } else {
    const created = sessionManager.createSession(req.headers['user-agent'] || '', { scope: security.tokenScopeFromRequest(req) });
    extraHeaders['set-cookie'] = [sessionManager.sessionCookie(created.token), 'codexMiniToken=; Path=/; Max-Age=0; SameSite=Lax'];
  }
  let modelOptions = readModelCatalogOptions();
  let transport = 'session-files';
  try {
    const models = await codexAppServer.listModels();
    if (models.length) {
      const appServerModels = models.map(model => ({
        key: model.id,
        id: model.id,
        label: labelFromModelName(model.displayName || model.id),
        displayName: model.displayName || model.id,
        source: 'app-server',
        isDefault: model.isDefault === true,
        supportedReasoningEfforts: normalizeSupportedReasoningEfforts(model.supportedReasoningEfforts),
      }));
      modelOptions = mergeModelOptions(modelOptions, appServerModels);
      transport = 'app-server';
    }
  } catch {}
  return json(res, 200, {
    ok: true,
    service: 'codex-max',
    appName: APP_NAME,
    localOnly: true,
    scope: security.tokenScopeFromRequest(req),
    localApiBases: getLanApiBases(),
    transport,
    modelOptions,
    reasoningOptions: Object.values(REASONING_MODE_TARGETS),
    update: updateInfo(),
  }, extraHeaders);
}

async function handlePairingCode(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const requestedScope = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('scope');
  if (requestedScope && !['read-only', 'read-write'].includes(requestedScope)) {
    return json(res, 400, { ok: false, code: 'BAD_SCOPE', message: '无效的配对权限。' });
  }
  const scope = security.tokenScopeFromRequest(req) === 'read-only' || requestedScope === 'read-only' ? 'read-only' : 'read-write';
  const created = pairingManager.createPairingCode(scope);
  logger.info('pairing_code_created', { scope, expiresIn: Math.round((Date.parse(created.expiresAt) - Date.now()) / 1000) });
  return json(res, 200, {
    ok: true,
    code: created.code,
    expiresAt: created.expiresAt,
    scope: created.scope,
    message: '配对码 90 秒内有效，仅可使用一次；新设备配对后不会再在 URL 中携带长期令牌。',
  });
}

async function handlePair(req, res) {
  const ip = getClientIp(req);
  if (!pairingManager.attemptAllowed(ip)) {
    return json(res, 429, { ok: false, code: 'RATE_LIMITED', message: '配对尝试过于频繁，请稍后再试。' });
  }
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }
  const code = String(payload.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return json(res, 400, { ok: false, code: 'BAD_PAIRING_CODE', message: '配对码为 6 位数字。' });
  }
  const scope = pairingManager.redeemPairingCode(code);
  if (!scope) {
    logger.warn('pairing_code_rejected', { ip });
    return json(res, 401, { ok: false, code: 'PAIRING_CODE_INVALID', message: '配对码无效或已过期，请在电脑端重新获取。' });
  }
  const created = sessionManager.createSession(req.headers['user-agent'] || '', { scope });
  logger.info('pairing_code_redeemed', { ip, scope });
  return json(res, 200, {
    ok: true,
    scope,
    message: '配对成功，已建立安全会话。',
  }, { 'set-cookie': [sessionManager.sessionCookie(created.token)] });
}

async function handleHealth(req, res) {
  // 健康检查不需要鉴权（用于监控），但返回信息有限
  const authorized = isAuthorized(req);
  let cdp = null;
  if (platform.cdpStatus) {
    try {
      cdp = await platform.cdpStatus();
    } catch (error) {
      cdp = {
        available: false,
        code: error.code || 'CDP_STATUS_FAILED',
        message: error.message || 'CDP 状态读取失败。',
      };
    }
  }
  const mem = process.memoryUsage();
  // 指纹与协议属于「连接引导」信息，未鉴权也返回：
  // 桌面壳在拿到会话前就必须能固定自签名证书，否则 TLS 握手直接失败。
  const base = {
    ok: true,
    service: APP_NAME,
    version: SERVICE_VERSION,
    host: os.hostname(),
    platform: platform.name,
    now: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    protocol: LAN_PROTOCOL,
    tls: Boolean(CERT_FINGERPRINT),
    certFingerprint: CERT_FINGERPRINT || undefined,
    lanAddresses: getLanIPv4Addresses(),
  };
  if (!authorized) {
    // 未鉴权请求只返回基础信息
    return json(res, 200, base);
  }
  return json(res, 200, {
    ...base,
    controlMode: codexAppServer.isAvailable() ? 'app-server' : cdp && cdp.available ? 'cdp' : 'gui',
    appServer: codexAppServer.status(),
    cdp,
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    nodeVersion: process.versions.node,
    scheduledTasks: scheduler.getTasks().length,
    activeScheduledTasks: scheduler.getTasks().filter(t => t.enabled).length,
  });
}

async function handleCdpLaunch(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (!platform.launchCodexCdp) {
    return json(res, 400, {
      ok: false,
      code: 'CDP_LAUNCH_UNSUPPORTED',
      message: '当前平台不支持从 Codex Remote Bridge 启动 CDP 受控版 ChatGPT。',
    });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const result = await platform.runExclusive(() => platform.launchCodexCdp({
      forceRestart: payload.forceRestart !== false,
      waitMs: payload.waitMs,
    }));
    return json(res, 200, result);
  } catch (error) {
    return json(res, 503, {
      ok: false,
      code: error.code || 'CDP_LAUNCH_FAILED',
      message: error.message || '启动 Codex CDP 受控版本失败。',
      launch: error.launch,
      cdp: error.cdp,
    });
  }
}

async function handleKeepAwake(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, ...keepAwakeStatus() });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const enabled = payload.enabled === true;
    const status = await (enabled ? startKeepAwake() : stopKeepAwake());
    return json(res, 200, {
      ok: true,
      ...status,
      message: status.enabled ? '已开启保持亮屏，电脑不会自动休眠' : '已关闭保持亮屏',
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      code: error.code || 'KEEP_AWAKE_FAILED',
      message: error.message || '切换保持亮屏失败。',
    });
  }
}

function getLanUrls(options = {}) {
  const nets = os.networkInterfaces();
  const scheme = LAN_PROTOCOL === 'https' ? 'https' : 'http';
  // includeToken=false 用于控制台横幅：长期 token 不应落进终端回滚缓冲与壳层日志。
  const withToken = options.includeToken !== false;
  const suffix = withToken ? `/?token=${TOKEN}` : '/';
  const urls = new Set([`${scheme}://localhost:${PORT}${suffix}`]);
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.add(`${scheme}://${net.address}:${PORT}${suffix}`);
      }
    }
  }
  return [...urls];
}

const DOWNLOAD_MIME_BY_EXT = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

function downloadMimeFor(filePath) {
  return DOWNLOAD_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function downloadSafeName(fileName) {
  return String(fileName || 'download').replace(/[\"\r\n\\/]/g, '_');
}

async function handleFileDownload(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cwdValue = String(url.searchParams.get('cwd') || '').trim();
  const relativePath = String(url.searchParams.get('file') || '').trim();
  if (!cwdValue || !relativePath) return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '缺少 cwd 或 file 参数。' });
  if (path.isAbsolute(relativePath)) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '仅允许下载工作区内的相对路径文件。' });
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '文件路径不能包含上级目录。' });
  let workspace = { threads: [] };
  try { workspace = await listWorkspaceThreads(160); } catch {}
  const projects = existingProjectCwds(workspace.threads);
  if (!projects.includes(cwdValue)) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '目标目录不在可下载白名单内。' });
  const resolved = path.resolve(cwdValue, relativePath);
  const withinRoot = path.relative(cwdValue, resolved);
  if (withinRoot.startsWith('..') || path.isAbsolute(withinRoot)) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '文件路径超出工作区范围。' });
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { return json(res, 404, { ok: false, code: 'DOWNLOAD_NOT_FOUND', message: '文件不存在。' }); }
  if (!stat.isFile() || stat.isSymbolicLink()) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '仅允许下载普通文件。' });
  if (stat.size > MAX_DOWNLOAD_BYTES) return json(res, 413, { ok: false, code: 'DOWNLOAD_TOO_LARGE', message: `文件大小超过 ${formatBytes(MAX_DOWNLOAD_BYTES)} 上限。` });
  const fileName = path.basename(resolved);
  res.writeHead(200, {
    'Content-Type': downloadMimeFor(resolved),
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${downloadSafeName(fileName)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(resolved).on('error', () => res.destroy()).pipe(res);
}

async function handleFileList(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cwdValue = String(url.searchParams.get('cwd') || '').trim();
  const pathParam = String(url.searchParams.get('path') || '').trim();
  const showHidden = String(url.searchParams.get('showHidden') || '') === '1';
  let workspace = { threads: [] };
  try { workspace = await listWorkspaceThreads(160); } catch {}
  const projects = existingProjectCwds(workspace.threads);
  if (!cwdValue) {
    return json(res, 200, {
      ok: true,
      cwd: '',
      path: '',
      project: '',
      parent: '',
      showHidden,
      projects,
      items: [],
    });
  }
  if (path.isAbsolute(pathParam)) return json(res, 403, { ok: false, code: 'FILE_LIST_FORBIDDEN', message: '仅允许浏览工作区内的相对路径目录。' });
  const segments = pathParam.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) return json(res, 403, { ok: false, code: 'FILE_LIST_FORBIDDEN', message: '目录路径不能包含上级目录。' });
  if (!projects.includes(cwdValue)) return json(res, 403, { ok: false, code: 'FILE_LIST_FORBIDDEN', message: '目标目录不在可浏览白名单内。' });
  const resolved = path.resolve(cwdValue, pathParam);
  const withinRoot = path.relative(cwdValue, resolved);
  if (withinRoot.startsWith('..') || path.isAbsolute(withinRoot)) return json(res, 403, { ok: false, code: 'FILE_LIST_FORBIDDEN', message: '目录路径超出工作区范围。' });
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { return json(res, 404, { ok: false, code: 'FILE_LIST_NOT_FOUND', message: '目录不存在。' }); }
  if (stat.isSymbolicLink()) {
    try { const targetStat = fs.statSync(resolved); stat = targetStat; } catch {}
  }
  if (!stat.isDirectory()) return json(res, 400, { ok: false, code: 'FILE_LIST_NOT_DIR', message: '目标不是目录。' });
  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return json(res, 500, { ok: false, code: 'FILE_LIST_FAILED', message: '读取目录失败。' });
  }
  const items = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!showHidden && name.startsWith('.')) continue;
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    let isSymlink = entry.isSymbolicLink();
    let size = 0;
    let mtimeMs = 0;
    if (isSymlink) {
      try {
        const targetStat = fs.statSync(path.join(resolved, name));
        if (targetStat.isDirectory()) { isDir = true; isFile = false; }
        else { isFile = true; isDir = false; }
        size = isFile ? targetStat.size : 0;
        mtimeMs = targetStat.mtimeMs;
      } catch {}
    } else if (isFile) {
      try {
        const fileStat = fs.statSync(path.join(resolved, name));
        size = fileStat.size;
        mtimeMs = fileStat.mtimeMs;
      } catch {}
    } else if (isDir) {
      try {
        const dirStat = fs.statSync(path.join(resolved, name));
        mtimeMs = dirStat.mtimeMs;
      } catch {}
    }
    items.push({
      name,
      isDir,
      isFile,
      isSymlink,
      size,
      mtimeMs,
      downloadable: isFile && size <= MAX_DOWNLOAD_BYTES,
    });
  }
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), 'zh');
  });
  const parentPath = withinRoot === '.' ? '' : path.posix.normalize(path.dirname(withinRoot.split(path.sep).join('/')));
  return json(res, 200, {
    ok: true,
    cwd: cwdValue,
    path: pathParam,
    project: cwdValue,
    parent: parentPath === '.' ? '' : parentPath,
    showHidden,
    projects,
    items,
  });
}

async function handleDownload(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (String(url.searchParams.get('cwd') || '').trim()) return handleFileDownload(req, res);
  const kind = String(url.searchParams.get('file') || '');
  if (kind === 'android') {
    const info = latestAndroidApkInfo();
    if (!info) return json(res, 404, { ok: false, code: 'UPDATE_NOT_FOUND', message: '没有可用的 Android 安装包。' });
    const filePath = path.join(DIST_ANDROID_DIR, info.name);
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${info.name}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    } catch {
      return json(res, 404, { ok: false, code: 'UPDATE_NOT_FOUND', message: 'Android 安装包不可用。' });
    }
    return;
  }
  if (kind === 'windows-installer') {
    const info = latestWindowsInstallerInfo();
    if (!info) return json(res, 404, { ok: false, code: 'UPDATE_NOT_FOUND', message: '没有可用的 Windows 安装包。' });
    const filePath = path.join(DIST_WINDOWS_INSTALLER_DIR, info.name);
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${info.name}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    } catch {
      return json(res, 404, { ok: false, code: 'UPDATE_NOT_FOUND', message: 'Windows 安装包不可用。' });
    }
    return;
  }
  return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '未知的下载类型。' });
}

async function handleRotateToken(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  const nextToken = rotateAccessToken();
  return json(res, 200, {
    ok: true,
    token: nextToken,
    urls: getLanUrls(),
    message: '访问令牌已轮换，请使用新的链接重新连接。',
  });
}

async function handleSessions(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '请重新连接。' });
  if (security.tokenScopeFromRequest(req) === 'read-only') return json(res, 403, { ok: false, code: 'TOKEN_READ_ONLY', message: '只读设备不能管理其他设备。' });
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, sessions: sessionManager.listSessions(security.sessionTokenFromRequest(req)) });
  }
  let payload;
  try { payload = JSON.parse(await readBody(req) || '{}'); } catch {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '请求格式不正确。' });
  }
  if (!payload || typeof payload.id !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.id)) {
    return json(res, 400, { ok: false, code: 'BAD_SESSION_ID', message: '无效的设备会话。' });
  }
  const revoked = sessionManager.revokeById(payload.id);
  cdpWsHub.disconnectUnauthorized();
  return json(res, 200, { ok: true, revoked });
}

function handleHistoryAttachment(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const id = String(url.searchParams.get('id') || '');
  const item = historyAttachmentCache.get(id);
  if (!item || item.expiresAt <= Date.now()) {
    historyAttachmentCache.delete(id);
    if (item) historyAttachmentIdByPath.delete(item.filePath);
    return json(res, 404, { ok: false, code: 'ATTACHMENT_NOT_FOUND', message: '图片预览已失效，请刷新任务记录。' });
  }
  try {
    const stat = fs.lstatSync(item.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) throw new Error('图片文件不可用。');
    res.writeHead(200, { 'Content-Type': item.mime, 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(item.filePath).on('error', () => res.destroy()).pipe(res);
  } catch {
    historyAttachmentCache.delete(id);
    historyAttachmentIdByPath.delete(item.filePath);
    return json(res, 404, { ok: false, code: 'ATTACHMENT_NOT_FOUND', message: '图片文件不可用。' });
  }
}

async function handleScreenshot(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  let cdp = null;
  if (platform.cdpStatus) {
    try { cdp = await platform.cdpStatus(); } catch (error) { cdp = { available: false, code: error.code || 'CDP_STATUS_FAILED', message: error.message || '浏览器状态读取失败。' }; }
  }
  if (!cdp || !cdp.available) {
    return json(res, 503, { ok: false, available: false, code: cdp?.code || 'CDP_UNAVAILABLE', message: cdp?.message || 'CDP 不可用，无法获取屏幕截图。' });
  }
  if (typeof platform.captureCdpScreenshot !== 'function') {
    return json(res, 503, { ok: false, available: false, code: 'CDP_SCREENSHOT_UNSUPPORTED', message: '当前平台不支持 CDP 截图。' });
  }
  const cacheKey = `${cdp.port || ''}:${cdp.targetUrl || ''}`;
  const now = Date.now();
  const cached = screenshotCache.get(cacheKey);
  if (cached && now - cached.capturedAt <= SCREENSHOT_CACHE_TTL_MS) {
    const body = Buffer.from(cached.data, 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': body.length,
      'Cache-Control': `private, max-age=${Math.max(1, Math.floor(SCREENSHOT_CACHE_TTL_MS / 1000))}`,
      'X-Screenshot-Cache': 'hit',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return;
  }
  // 并发去重：同一 target 的重复请求等待在途截图，避免连续点击触发多次真实捕获
  if (screenshotCacheBusy.has(cacheKey)) {
    try { await screenshotCacheBusy.get(cacheKey); } catch {}
    const retried = screenshotCache.get(cacheKey);
    if (retried) {
      const body = Buffer.from(retried.data, 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': body.length,
        'Cache-Control': `private, max-age=${Math.max(1, Math.floor(SCREENSHOT_CACHE_TTL_MS / 1000))}`,
        'X-Screenshot-Cache': 'hit',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
      return;
    }
    return json(res, 503, { ok: false, available: false, code: 'CDP_SCREENSHOT_FAILED', message: '截图请求正在处理但结果不可用，请重试。' });
  }
  let shot;
  const inflight = platform.captureCdpScreenshot().then(result => { shot = result; }, error => { shot = null; throw error; });
  screenshotCacheBusy.set(cacheKey, inflight);
  try {
    await inflight;
  } catch (error) {
    return json(res, 502, { ok: false, available: false, code: error.code || 'CDP_SCREENSHOT_FAILED', message: error.message || '截图失败。' });
  } finally {
    screenshotCacheBusy.delete(cacheKey);
  }
  if (!shot || typeof shot.data !== 'string' || !shot.data) {
    return json(res, 502, { ok: false, available: false, code: 'CDP_SCREENSHOT_EMPTY', message: '截图未返回图像数据。' });
  }
  const body = Buffer.from(shot.data, 'base64');
  if (!body.length || body.length > MAX_SCREENSHOT_BYTES) {
    return json(res, 502, { ok: false, available: false, code: 'CDP_SCREENSHOT_TOO_LARGE', message: '截图数据异常，请重试。' });
  }
  boundedSet(screenshotCache, cacheKey, { data: shot.data, width: Number(shot.width) || 0, height: Number(shot.height) || 0, capturedAt: Date.now() }, 12);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': body.length,
    'Cache-Control': `private, max-age=${Math.max(1, Math.floor(SCREENSHOT_CACHE_TTL_MS / 1000))}`,
    'X-Screenshot-Cache': 'miss',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
// ===== 执行统计与 Webhook 通知 =====

function normalizeLogRow(row = {}) {
  return {
    threadId: row.thread_id ?? row.threadId ?? '',
    action: row.action ?? '',
    status: row.status ?? '',
    durationMs: row.duration_ms ?? row.durationMs ?? 0,
    error: row.error ?? '',
    createdAt: row.created_at ?? row.createdAt ?? '',
  };
}

// ===== 系统指标与工作区 Git Diff =====

function readCpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

let lastCpuSnapshot = readCpuSnapshot();
let lastCpuPct = 0;
setInterval(() => {
  const current = readCpuSnapshot();
  const idleDiff = current.idle - lastCpuSnapshot.idle;
  const totalDiff = current.total - lastCpuSnapshot.total;
  if (totalDiff > 0) {
    lastCpuPct = Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
  }
  lastCpuSnapshot = current;
}, 3000).unref();

async function handleSystemOverview(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
  const cdp = platform.cdpStatus ? await platform.cdpStatus().catch(() => null) : null;
  const keepAwake = keepAwakeStatus();

  return json(res, 200, {
    ok: true,
    hostname: os.hostname(),
    platform: platform.name,
    cpu: {
      cores: os.cpus().length,
      usagePct: lastCpuPct,
      model: os.cpus()[0]?.model || 'Unknown',
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usagePct: memPct,
    },
    uptime: Math.floor(os.uptime()),
    serviceUptime: Math.floor(process.uptime()),
    keepAwake: Boolean(keepAwake.enabled),
    cdp: {
      available: Boolean(cdp?.available),
      port: cdp?.port || 9222,
    },
    appServer: codexAppServer.status(),
  });
}

async function handleSystemControl(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (security.tokenScopeFromRequest(req) === 'read-only') {
    return json(res, 403, { ok: false, code: 'TOKEN_READ_ONLY', message: '只读令牌不能执行系统控制操作。' });
  }
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const action = String(payload.action || '').trim().toLowerCase();
  if (action === 'lock-screen') {
    if (process.platform === 'win32') {
      try {
        spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { detached: true, stdio: 'ignore' });
        return json(res, 200, { ok: true, message: '已向电脑发送锁屏指令。' });
      } catch (err) {
        return json(res, 500, { ok: false, code: 'LOCK_FAILED', message: err.message || '锁屏失败。' });
      }
    } else if (process.platform === 'darwin') {
      try {
        spawn('pmset', ['displaysleepnow'], { detached: true, stdio: 'ignore' });
        return json(res, 200, { ok: true, message: '已向 Mac 发送熄屏/锁定指令。' });
      } catch (err) {
        return json(res, 500, { ok: false, code: 'LOCK_FAILED', message: err.message || '锁定失败。' });
      }
    }
    return json(res, 400, { ok: false, code: 'UNSUPPORTED_PLATFORM', message: '当前平台不支持远程锁屏。' });
  }

  if (action === 'keep-awake') {
    const enable = payload.enabled === true;
    try {
      const status = await (enable ? startKeepAwake() : stopKeepAwake());
      return json(res, 200, { ok: true, ...status, message: status.enabled ? '已开启保持亮屏。' : '已关闭保持亮屏。' });
    } catch (err) {
      return json(res, 500, { ok: false, code: 'KEEP_AWAKE_FAILED', message: err.message || '保持亮屏设置失败。' });
    }
  }

  return json(res, 400, { ok: false, code: 'BAD_ACTION', message: '未知的控制指令。' });
}

// 读取电脑剪贴板文本（只读）
async function handleClipboardRead(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  try {
    const text = typeof platform.readClipboardText === 'function' ? await platform.readClipboardText() : '';
    return json(res, 200, { ok: true, text, hasText: Boolean(text) });
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CLIPBOARD_READ_FAILED', message: error.message || '读取剪贴板失败。' });
  }
}

// 写入电脑剪贴板文本（需要写权限）
async function handleClipboardWrite(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (security.tokenScopeFromRequest(req) === 'read-only') {
    return json(res, 403, { ok: false, code: 'TOKEN_READ_ONLY', message: '只读令牌不能写入剪贴板。' });
  }
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }
  const text = String(payload.text || '');
  if (text.length > 1024 * 1024) {
    return json(res, 413, { ok: false, code: 'CLIPBOARD_TOO_LARGE', message: '剪贴板文本过大。' });
  }
  try {
    await platform.copyTextToClipboard(text);
    return json(res, 200, { ok: true, message: '已写入电脑剪贴板。' });
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CLIPBOARD_WRITE_FAILED', message: error.message || '写入剪贴板失败。' });
  }
}

async function handleGitDiff(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cwdParam = String(url.searchParams.get('cwd') || '').trim();
  const fileParam = String(url.searchParams.get('file') || '').trim();

  let target;
  try {
    target = await resolveGitActionTarget(cwdParam);
  } catch (err) {
    return json(res, err.status || 400, { ok: false, code: err.code || 'GIT_DIFF_FAILED', message: err.message });
  }

  const root = target.root;
  try {
    const args = ['-C', root, 'diff', 'HEAD'];
    if (fileParam) {
      if (!isSafeGitPathSpec(fileParam)) {
        return json(res, 403, { ok: false, code: 'FORBIDDEN_PATH', message: '文件路径不合法。' });
      }
      args.push('--', fileParam);
    }
    const diffResult = await runGit(args, { timeoutMs: 15000 });
    const diffText = String(diffResult.stdout || '');
    return json(res, 200, {
      ok: true,
      cwd: target.cwd,
      file: fileParam || '',
      diff: diffText.slice(0, 500000), // 限制最大 500KB diff
    });
  } catch (err) {
    return json(res, 500, { ok: false, code: 'GIT_DIFF_FAILED', message: err.message || '获取 Diff 失败。' });
  }
}

async function handleStats(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  try {
    const logs = (persistentQueue.getLogs(1000) || []).map(normalizeLogRow);
    const now = Date.now();
    const dayStart = new Date(now - 24 * 3600 * 1000).toISOString();
    const weekStart = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

    let completed = 0;
    let failed = 0;
    const byAction = {};
    let todayCount = 0;
    let weekCount = 0;
    for (const log of logs) {
      const time = Date.parse(log.createdAt);
      if (log.status === 'completed') completed += 1;
      if (log.status === 'failed') failed += 1;
      byAction[log.action] = (byAction[log.action] || 0) + 1;
      if (time >= Date.parse(dayStart)) todayCount += 1;
      if (time >= Date.parse(weekStart)) weekCount += 1;
    }

    const successRate = completed + failed > 0 ? Math.round((completed / (completed + failed)) * 1000) / 10 : 0;
    return json(res, 200, {
      ok: true,
      queue: persistentQueue.getQueueStatus(),
      totals: { total: logs.length, completed, failed, successRate },
      timeRange: { today: todayCount, week: weekCount },
      byAction,
      latency: latencySummary(),
      recent: logs.slice(0, 20),
    });
  } catch (error) {
    return json(res, 500, { ok: false, code: 'STATS_FAILED', message: error.message || '统计失败。' });
  }
}

function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

async function handleWebhook(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (req.method === 'GET') {
    const state = store.readState();
    return json(res, 200, {
      ok: true,
      webhook: state.webhook || '',
      enabled: Boolean(state.webhook),
      signed: Boolean(state.webhook && state.webhookSecret),
      needsSecret: Boolean(state.webhook && !state.webhookSecret),
    });
  }
  if (req.method === 'POST') {
    let payload = {};
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch (error) {
      return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
    }
    const url = String(payload.url || '').trim();
    if (url) {
      if (!/^https?:\/\//i.test(url)) {
        return json(res, 400, { ok: false, code: 'BAD_WEBHOOK_URL', message: 'Webhook 地址必须以 http(s):// 开头。' });
      }
      try {
        const parsedUrl = new URL(url);
        const host = parsedUrl.hostname.toLowerCase();
        if (process.env.CODEX_ALLOW_PRIVATE_WEBHOOK !== '1') {
          if (
            host === 'localhost' ||
            host === '::1' ||
            host === '[::1]' ||
            host === '0.0.0.0' ||
            /^127(?:\.\d+){1,3}$/.test(host) ||
            /^169\.254(?:\.\d+){1,3}$/.test(host) ||
            host.endsWith('.internal')
          ) {
            return json(res, 400, { ok: false, code: 'FORBIDDEN_WEBHOOK_HOST', message: '禁止使用环回或元数据私有网络地址作为 Webhook。' });
          }
        }
      } catch {
        return json(res, 400, { ok: false, code: 'BAD_WEBHOOK_URL', message: 'Webhook 地址格式不正确。' });
      }
    }
    const state = store.readState();
    const shouldRotate = Boolean(payload.rotateSecret) || (Boolean(url) && !state.webhookSecret);
    const nextSecret = url && shouldRotate ? generateWebhookSecret() : url ? state.webhookSecret : '';
    state.webhook = url;
    state.webhookSecret = nextSecret;
    store.writeState(state);
    logger.info('webhook_updated', { enabled: Boolean(url), signed: Boolean(url && nextSecret), rotated: Boolean(url && shouldRotate) });
    return json(res, 200, {
      ok: true,
      webhook: url,
      enabled: Boolean(url),
      signed: Boolean(url && nextSecret),
      secret: url && shouldRotate ? nextSecret : '',
      message: url
        ? (shouldRotate ? 'Webhook 已启用，签名密钥仅显示这一次，请立即保存。' : 'Webhook 配置已保存。')
        : '已关闭 Webhook 通知。',
    });
  }
  return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
}

function fireWebhook(event, payload = {}) {
  const state = store.readState();
  const webhook = state.webhook;
  const secret = state.webhookSecret;
  if (!webhook) return;
  if (!secret) {
    logger.warn('webhook_unsigned_skipped', { event });
    return;
  }
  const httpModule = webhook.startsWith('https:') ? require('https') : require('http');
  const body = JSON.stringify({ event, ...payload, ts: new Date().toISOString() });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const request = httpModule.request(webhook, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'user-agent': `${APP_NAME}/4.0`,
      'x-codex-webhook-event': event,
      'x-codex-webhook-timestamp': timestamp,
      'x-codex-webhook-signature': `sha256=${signature}`,
    },
    timeout: 5000,
  }, response => {
    response.resume();
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => {});
  request.end(body);
}

// ===== HTTP/HTTPS 服务器创建 =====
// v4.0.0：所有 API 路由集中为路由表，由 Router 统一分发（替换手动 if 链）
const apiRouteTable = [
  { method: 'GET', prefix: '/codex/health', handler: handleHealth },
  { method: 'POST', prefix: '/codex/rotate-token', handler: handleRotateToken },
  { method: 'GET', prefix: '/codex/download', handler: handleDownload },
  { method: 'GET', prefix: '/codex/files', handler: handleFileList },
  { method: 'GET', prefix: '/codex/export', handler: handleExport },
  { method: 'GET', prefix: '/codex/search', handler: handleSearch },
  { method: 'GET', prefix: '/codex/screenshot', handler: handleScreenshot },
  { method: 'GET', prefix: '/codex/attachment', handler: handleHistoryAttachment },
  { method: 'GET', prefix: '/codex/config', handler: handleClientConfig },
  { method: 'GET', prefix: '/codex/environment', handler: handleEnvironment },
  { method: 'POST', prefix: '/codex/git-action', handler: handleGitAction },
  { method: 'POST', prefix: '/codex/cdp-launch', handler: handleCdpLaunch },
  { method: 'POST', prefix: '/send', handler: handleSend },
  { method: 'GET', prefix: '/codex/threads', handler: handleThreads },
  { method: 'GET', prefix: '/codex/archived', handler: handleArchivedThreads },
  { method: 'GET', prefix: '/codex/pull-requests', handler: handlePullRequests },
  { method: 'GET', prefix: '/codex/plugins', handler: handlePlugins },
  { method: '*', prefix: '/codex/schedules', handler: handleSchedules },
  { method: '*', prefix: '/codex/prompts', handler: handlePromptLibrary },
  { method: 'GET', prefix: '/codex/history', handler: handleThreadHistory },
  { method: 'GET', prefix: '/codex/approvals', handler: handleCodexApprovals },
  { method: 'POST', prefix: '/codex/approval', handler: handleCodexApproval },
  { method: 'GET', prefix: '/codex/status', handler: handleCodexStatus },
  { method: '*', prefix: '/codex/keep-awake', handler: handleKeepAwake },
  { method: 'POST', prefix: '/codex/select', handler: handleSelectThread },
  { method: 'POST', prefix: '/codex/new-thread', handler: handleNewCodexThread },
  { method: 'POST', prefix: '/codex/thread-action', handler: handleThreadAction },
  { method: 'POST', prefix: '/codex/model-switch', handler: handleModelSwitch },
  { method: 'POST', prefix: '/codex/reasoning-mode', handler: handleReasoningMode },
  { method: 'POST', prefix: '/codex/stop', handler: handleStopCodex },
  { method: 'GET', prefix: '/codex/stats', handler: handleStats },
  { method: '*', prefix: '/codex/webhook', handler: handleWebhook },
  { method: 'GET', prefix: '/codex/system/overview', handler: handleSystemOverview },
  { method: 'POST', prefix: '/codex/system/control', handler: handleSystemControl },
  { method: 'GET', prefix: '/codex/git/diff', handler: handleGitDiff },
  { method: 'GET', prefix: '/codex/clipboard', handler: handleClipboardRead },
  { method: 'POST', prefix: '/codex/clipboard', handler: handleClipboardWrite },
  { method: 'GET', prefix: '/codex/pairing-code', handler: handlePairingCode },
  { method: 'GET', prefix: '/codex/sessions', handler: handleSessions },
  { method: 'POST', prefix: '/codex/sessions', handler: handleSessions },
  { method: 'POST', prefix: '/codex/pair', handler: handlePair },
];

const router = new Router({
  logger,
  security,
  staticHandler: serveStatic,
  publicDir: PUBLIC_DIR,
  distDir: DIST_DIR,
  serviceVersion: SERVICE_VERSION,
});
router.registerPrefixRoutes(apiRouteTable);

const requestHandler = (req, res) => {
  // 预先按请求计算 CORS 安全头，供 json() 响应复用（回显合法 Origin，拒绝未知来源）
  res._corsHeaders = corsHeaders(req);
  if (req.method === 'OPTIONS') return options(req, res);
  // Phase 3.4: 请求级延迟观测（P50/P95）
  const requestStartedAt = process.hrtime.bigint();
  let requestPathname = '';
  try { requestPathname = new URL(req.url || '/', 'http://local').pathname; } catch { requestPathname = String(req.url || '/').split('?')[0] || '/'; }
  res.on('finish', () => {
    const requestMs = Number(process.hrtime.bigint() - requestStartedAt) / 1e6;
    recordLatency(requestPathname, Math.round(requestMs * 10) / 10);
  });
  return router.dispatch(req, res);
};

// HTTPS 证书管理
// 证书 SAN 必须覆盖所有局域网 IPv4，否则手机通过局域网 IP 访问时证书名不匹配。
// 指纹固定（TOFU）：桌面壳通过 /codex/health 获取指纹并锁定，用户无需手动信任证书。
let server;
let CERT_FINGERPRINT = '';
if (USE_HTTPS) {
  const certResult = certManager.ensureCert(['codex-max-local', ...getLanIPv4Addresses()]);
  if (certResult.ok) {
    LAN_PROTOCOL = 'https';
    CERT_FINGERPRINT = certResult.fingerprint || certManager.getCertFingerprint();
    server = https.createServer(certManager.loadCredentials(), requestHandler);
    logger.info('https_enabled', {
      fingerprint: CERT_FINGERPRINT,
      reissuedFor: certResult.reissuedFor || undefined,
    });
  } else {
    LAN_PROTOCOL = 'http';
    logger.warn('https_fallback', { reason: certResult.error });
    server = http.createServer(requestHandler);
  }
} else {
  LAN_PROTOCOL = 'http';
  server = http.createServer(requestHandler);
}

// CDP WebSocket 升级处理 - 实时状态推送
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname === '/codex/ws') {
    Promise.resolve(cdpWsHub.handleUpgrade(req, socket, head)).catch(error => {
      logger.warn('ws_upgrade_failed', { error: error && error.message || String(error) });
      try { socket.destroy(); } catch {}
    });
  } else {
    socket.destroy();
  }
});

const mdnsBroadcaster = new MdnsBroadcaster({
  port: PORT,
  name: `Codex-${os.hostname()}`,
  txt: { app: 'codex-remote-bridge', ver: SERVICE_VERSION },
});

server.listen(PORT, HOST, () => {
  startScheduledTaskRunner();
  cdpWsHub.start();
  mdnsBroadcaster.start();
  // 写入运行时连接信息（协议 + 指纹），供桌面壳读取：
  // 壳层在拿到本文件前不知道服务实际起在 https 还是 http，也无法固定自签证书。
  writeRuntimeInfo();
  // 横幅不打印长期 token：终端回滚缓冲与 Windows 壳的 service.out.log 都会长期留存。
  // 新设备统一走网页端"配对"入口（一次性 6 位码）或桌面面板二维码。
  const urls = getLanUrls({ includeToken: false });
  const protocol = LAN_PROTOCOL;
  logger.info('server_started', { port: PORT, host: HOST, protocol, version: SERVICE_VERSION, ws: true });
  console.log(`\n${APP_NAME} is running.`);
  console.log('Keep this terminal open, make sure Codex Desktop is available, then open one of these URLs on your phone:');
  for (const url of urls) console.log(`  ${url}`);
  console.log('\nNew device? Open the URL above, then use the pairing entry (one-time 6-digit code) shown by the desktop panel.');
  console.log('The long-lived access token is never printed here; it stays in the state directory and desktop launcher.');
  if (LAN_PROTOCOL === 'https') console.log('\nNote: Using HTTPS with self-signed certificate. Desktop launchers pin the fingerprint automatically.');
  else console.log('\nNote: Running over plain HTTP (CODEX_MAX_HTTP_ONLY=1). On an untrusted LAN, prefer HTTPS.');
  console.log('\nTip: phone and this computer must be on the same Wi‑Fi/LAN. Press Ctrl+C to stop.\n');
});

process.on('exit', () => {
  mdnsBroadcaster.stop();
  pairingManager.destroy();
  stopScheduledTaskRunner();
  cdpWsHub.stop();
  persistentQueue.close();
  cleanupKeepAwake();
  security.destroy();
  codexAppServer.close();
});
process.on('SIGINT', () => {
  mdnsBroadcaster.stop();
  pairingManager.destroy();
  stopScheduledTaskRunner();
  cdpWsHub.stop();
  persistentQueue.close();
  cleanupKeepAwake();
  security.destroy();
  codexAppServer.close();
  process.exit(130);
});
process.on('SIGTERM', () => {
  mdnsBroadcaster.stop();
  pairingManager.destroy();
  stopScheduledTaskRunner();
  cdpWsHub.stop();
  persistentQueue.close();
  cleanupKeepAwake();
  security.destroy();
  codexAppServer.close();
  process.exit(143);
});

process.on('uncaughtException', error => {
  logger.error('uncaught_exception', { error: error && error.message || String(error), stack: error && error.stack || '' });
});
process.on('unhandledRejection', reason => {
  logger.error('unhandled_rejection', { error: reason && reason.message || String(reason), stack: reason && reason.stack || '' });
});
