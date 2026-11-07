'use strict';

/**
 * 持久化存储层 - 管理应用状态、定时任务、配置的读写
 * 当前基于 JSON 文件，后续可迁移到 SQLite
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = process.env.CODEX_MAX_STATE_DIR || process.env.CODEX_MINI_STATE_DIR || path.join(os.homedir(), '.codex-max');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const TOKEN_FILE = path.join(STATE_DIR, 'token');

const GUI_FAILURE_REPORT_LIMIT = 80;
const SCHEDULED_TASK_LIMIT = 64;
const SCHEDULED_TASK_MIN_INTERVAL_MINUTES = 5;
const SCHEDULED_TASK_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

function isCodexThreadId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value);
}

function truncateText(value, max = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeIsoTimestamp(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function normalizeScheduleInterval(value) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return 60;
  return Math.max(SCHEDULED_TASK_MIN_INTERVAL_MINUTES, Math.min(SCHEDULED_TASK_MAX_INTERVAL_MINUTES, minutes));
}

function normalizeScheduledTask(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id || '').trim();
  const prompt = String(row.prompt || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id) || !prompt) return null;
  const runMode = row.runMode === 'thread' ? 'thread' : 'standalone';
  const threadId = isCodexThreadId(row.threadId) ? String(row.threadId) : '';
  if (runMode === 'thread' && !threadId) return null;
  const intervalMinutes = normalizeScheduleInterval(row.intervalMinutes);
  const now = new Date();
  return {
    id,
    prompt: prompt.slice(0, 8000),
    cwd: String(row.cwd || '').trim().slice(0, 2000),
    threadId: runMode === 'thread' ? threadId : '',
    runMode,
    intervalMinutes,
    enabled: row.enabled !== false,
    createdAt: normalizeIsoTimestamp(row.createdAt) || now.toISOString(),
    updatedAt: normalizeIsoTimestamp(row.updatedAt) || now.toISOString(),
    nextRunAt: normalizeIsoTimestamp(row.nextRunAt) || new Date(now.getTime() + intervalMinutes * 60000).toISOString(),
    lastRunAt: normalizeIsoTimestamp(row.lastRunAt),
    lastStatus: ['idle', 'running', 'started', 'skipped', 'error'].includes(row.lastStatus) ? row.lastStatus : 'idle',
    lastMessage: truncateText(row.lastMessage || '', 500),
    lastThreadId: isCodexThreadId(row.lastThreadId) ? String(row.lastThreadId) : '',
  };
}

function normalizeScheduledTasks(value) {
  const seen = new Set();
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map(normalizeScheduledTask)
    .filter(item => item && !seen.has(item.id) && seen.add(item.id))
    .slice(0, SCHEDULED_TASK_LIMIT)
    .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
}

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

function normalizeHistoryText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeWebhook(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const hostname = url.hostname.toLowerCase();
    if (process.env.CODEX_ALLOW_PRIVATE_WEBHOOK !== '1') {
      if (
        hostname === 'localhost' ||
        hostname === '::1' ||
        hostname === '[::1]' ||
        hostname === '0.0.0.0' ||
        /^127(?:\.\d+){1,3}$/.test(hostname) ||
        /^169\.254(?:\.\d+){1,3}$/.test(hostname) ||
        hostname.endsWith('.internal')
      ) {
        return '';
      }
    }
    return url.toString().slice(0, 2000);
  } catch {
    return '';
  }
}

function normalizeWebhookSecret(value) {
  const raw = String(value || '').trim();
  return /^[A-Za-z0-9_-]{32,128}$/.test(raw) ? raw : '';
}

function emptyState() {
  return {
    pinnedThreadIds: [],
    archivedThreadIds: [],
    titleOverrides: {},
    guiFailureReports: {},
    scheduledTasks: [],
    webhook: '',
    webhookSecret: '',
  };
}

class Store {
  constructor(options = {}) {
    this.stateDir = options.stateDir || STATE_DIR;
    this.stateFile = options.stateFile || STATE_FILE;
    this.tokenFile = options.tokenFile || TOKEN_FILE;
    this._cache = null;
  }

  // ---- Token ----

  loadPersistedToken() {
    try {
      const stored = fs.readFileSync(this.tokenFile, 'utf8').trim();
      return /^[A-Za-z0-9_-]{16,64}$/.test(stored) ? stored : '';
    } catch {
      return '';
    }
  }

  persistToken(token) {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tempFile = `${this.tokenFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempFile, token, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.renameSync(tempFile, this.tokenFile);
      } catch {
        fs.writeFileSync(this.tokenFile, token, { encoding: 'utf8', mode: 0o600 });
        try { fs.unlinkSync(tempFile); } catch {}
      }
    } catch (error) {
      console.warn('[store] 保存访问令牌失败:', error.message || error);
    }
  }

  syncLauncherToken(token) {
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

  // ---- State ----

  readState() {
    if (this._cache) return this._cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this._cache = {
        pinnedThreadIds: Array.isArray(parsed.pinnedThreadIds) ? parsed.pinnedThreadIds.filter(isCodexThreadId) : [],
        archivedThreadIds: Array.isArray(parsed.archivedThreadIds) ? parsed.archivedThreadIds.filter(isCodexThreadId) : [],
        titleOverrides: parsed.titleOverrides && typeof parsed.titleOverrides === 'object' ? parsed.titleOverrides : {},
        guiFailureReports: normalizeGuiFailureReports(parsed.guiFailureReports),
        scheduledTasks: normalizeScheduledTasks(parsed.scheduledTasks),
        webhook: normalizeWebhook(parsed.webhook),
        webhookSecret: normalizeWebhookSecret(parsed.webhookSecret),
      };
      return this._cache;
    } catch {
      this._cache = emptyState();
      return this._cache;
    }
  }

  writeState(state) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const normalized = {
      pinnedThreadIds: [...new Set((state.pinnedThreadIds || []).filter(isCodexThreadId))],
      archivedThreadIds: [...new Set((state.archivedThreadIds || []).filter(isCodexThreadId))],
      titleOverrides: state.titleOverrides && typeof state.titleOverrides === 'object' ? state.titleOverrides : {},
      guiFailureReports: normalizeGuiFailureReports(state.guiFailureReports),
      scheduledTasks: normalizeScheduledTasks(state.scheduledTasks),
      webhook: normalizeWebhook(state.webhook),
      webhookSecret: normalizeWebhookSecret(state.webhookSecret),
    };
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    const tempFile = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempFile, content, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempFile, this.stateFile);
      try { fs.chmodSync(this.stateFile, 0o600); } catch {}
    } catch {
      // 在部分 Windows 环境文件被短时独占时降级为直接写入
      fs.writeFileSync(this.stateFile, content, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(this.stateFile, 0o600); } catch {}
      try { fs.unlinkSync(tempFile); } catch {}
    }
    this._cache = normalized;
    return normalized;
  }

  invalidateCache() {
    this._cache = null;
  }

  // ---- Helpers ----

  setThreadSetMembership(list, threadId, enabled) {
    const set = new Set((Array.isArray(list) ? list : []).filter(isCodexThreadId));
    if (enabled) set.add(threadId);
    else set.delete(threadId);
    return [...set];
  }

  nextScheduledRunAt(task, nowMs = Date.now()) {
    const intervalMs = normalizeScheduleInterval(task.intervalMinutes) * 60000;
    const previous = Date.parse(task.nextRunAt || '');
    const base = Number.isFinite(previous) ? previous : nowMs;
    return new Date(Math.max(nowMs + intervalMs, base + intervalMs)).toISOString();
  }
}

module.exports = { Store, emptyState, isCodexThreadId, normalizeHistoryText, truncateText };
