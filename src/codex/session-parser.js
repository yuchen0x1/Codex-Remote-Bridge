'use strict';

/**
 * Codex 会话解析模块 - 读取、解析 Codex Desktop 的会话文件
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

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
const CODEX_SESSION_FILE_CACHE_MS = 1200;
const CODEX_THREAD_LIST_CACHE_MS = 1200;
const CODEX_HISTORY_INITIAL_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 120;
const GUI_FAILURE_LOG_SCAN_BYTES = 2 * 1024 * 1024;
const GUI_FAILURE_LOG_RECENT_MS = 15 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const HISTORY_ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const HISTORY_ATTACHMENT_LIMIT = 600;

class CodexSessionParser {
  constructor(options = {}) {
    this.store = options.store || null;
    this.sessionFilesCache = { at: 0, files: [] };
    this.threadIndexCache = { mtimeMs: 0, size: 0, byId: null };
    this.sessionMetaCache = new Map();
    this.firstUserMessageCache = new Map();
    this.runtimeSummaryCache = new Map();
    this.threadListCache = new Map();
    this.historyAttachmentCache = new Map();
  }

  // ---- File Helpers ----

  walkFiles(rootDir, predicate, out = []) {
    const root = path.resolve(rootDir || '');
    if (!root) return out;

    const visit = (dir) => {
      const resolvedDir = path.resolve(dir);
      const relativeDir = path.relative(root, resolvedDir);
      if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) return;

      let entries;
      try { entries = fs.readdirSync(resolvedDir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        const full = path.resolve(resolvedDir, entry.name);
        const relative = path.relative(root, full);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile() && predicate(full)) out.push(full);
      }
    };

    visit(root);
    return out;
  }

  fileCacheSignature(stat) {
    return stat ? `${stat.size}:${stat.mtimeMs}` : '';
  }

  boundedSet(map, key, value, limit = 300) {
    if (map.size >= limit && !map.has(key)) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
    }
    map.set(key, value);
    return value;
  }

  isCodexThreadId(value) {
    return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value);
  }

  threadIdFromSessionFile(file) {
    return (path.basename(file || '').match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i) || [])[1] || '';
  }

  // ---- Session File Discovery ----

  listSessionFiles(options = {}) {
    const now = Date.now();
    if (!options.force && this.sessionFilesCache.files.length && now - this.sessionFilesCache.at <= CODEX_SESSION_FILE_CACHE_MS) {
      return this.sessionFilesCache.files;
    }
    const files = this.walkFiles(CODEX_SESSIONS_DIR, file => file.endsWith('.jsonl'));
    this.sessionFilesCache = { at: now, files };
    return files;
  }

  findSessionFileByThreadId(threadId) {
    if (!this.isCodexThreadId(threadId)) return null;
    const files = this.listSessionFiles();
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

  findSessionFileByName(name) {
    if (!name || name.includes('/') || name.includes('..')) return null;
    const files = this.listSessionFiles();
    return files.find(file => path.basename(file) === name) || null;
  }

  findLatestSessionFile(options = {}) {
    const excludeThreadId = this.isCodexThreadId(options.excludeThreadId) ? options.excludeThreadId : '';
    const afterMs = Number(options.afterMs) || 0;
    const expectedCwd = this.validLocalDirectory(options.cwd || '');
    const files = this.listSessionFiles(afterMs ? { force: true } : {});
    let best = null;
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        const threadId = this.threadIdFromSessionFile(file);
        if (excludeThreadId && threadId === excludeThreadId) continue;
        if (afterMs && stat.mtimeMs < afterMs - 2500) continue;
        if (expectedCwd) {
          const metaCwd = this.validLocalDirectory(this.readSessionMeta(file).cwd || '');
          if (metaCwd !== expectedCwd) continue;
        }
        if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
      } catch {}
    }
    return best && best.file;
  }

  validLocalDirectory(value) {
    const normalized = value ? path.normalize(value) : '';
    if (!normalized || !path.isAbsolute(normalized)) return '';
    try { return fs.statSync(normalized).isDirectory() ? normalized : ''; } catch { return ''; }
  }

  // ---- Thread Index ----

  readThreadIndex() {
    let stat = null;
    try { stat = fs.statSync(CODEX_SESSION_INDEX); } catch {}
    if (stat && this.threadIndexCache.byId &&
        this.threadIndexCache.mtimeMs === stat.mtimeMs &&
        this.threadIndexCache.size === stat.size) {
      return new Map(this.threadIndexCache.byId);
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
    if (stat) this.threadIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, byId: new Map(byId) };
    return byId;
  }

  // ---- Session Meta ----

  readSessionMeta(file) {
    let stat = null;
    try { stat = fs.statSync(file); } catch {}
    const cacheKey = stat ? `${file}:${this.fileCacheSignature(stat)}` : '';
    if (cacheKey && this.sessionMetaCache.has(cacheKey)) return this.sessionMetaCache.get(cacheKey);
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const lines = buffer.toString('utf8', 0, bytes).split('\n').filter(Boolean).slice(0, 80);
        for (const line of lines) {
          let item;
          try { item = JSON.parse(line); } catch { continue; }
          if (item.type === 'session_meta' && item.payload) return cacheKey ? this.boundedSet(this.sessionMetaCache, cacheKey, item.payload) : item.payload;
        }
      } finally { fs.closeSync(fd); }
    } catch {}
    return cacheKey ? this.boundedSet(this.sessionMetaCache, cacheKey, {}) : {};
  }

  // ---- First User Message ----

  findFirstUserMessage(file, maxBytes = CODEX_TITLE_SCAN_BYTES) {
    let stat;
    try { stat = fs.statSync(file); } catch { return ''; }
    const cacheKey = `${file}:${this.fileCacheSignature(stat)}:${maxBytes}`;
    if (this.firstUserMessageCache.has(cacheKey)) return this.firstUserMessageCache.get(cacheKey);
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
          if (newline < 0) { carry = ''; skippingLongLine = true; continue; }
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
            const title = this.summarizeThreadTitle(payload.message || '');
            if (title) return this.boundedSet(this.firstUserMessageCache, cacheKey, title);
          }
        }
      }
      if (carry.trim() && carry.length <= maxLineBytes) {
        try {
          const item = JSON.parse(carry);
          const payload = item.payload || {};
          if (item.type === 'event_msg' && payload.type === 'user_message') {
            return this.boundedSet(this.firstUserMessageCache, cacheKey, this.summarizeThreadTitle(payload.message || ''));
          }
        } catch {}
      }
    } catch { return ''; } finally { if (typeof fd === 'number') { try { fs.closeSync(fd); } catch {} } }
    return this.boundedSet(this.firstUserMessageCache, cacheKey, '');
  }

  // ---- Text Helpers ----

  summarizeThreadTitle(value, maxLength = 34) {
    let text = this.cleanUserHistoryText(value)
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

  cleanUserHistoryText(value) {
    const text = this.normalizeHistoryText(value);
    const marker = '## My request for Codex:';
    const index = text.indexOf(marker);
    if (index >= 0) return this.normalizeHistoryText(text.slice(index + marker.length));
    return text;
  }

  normalizeHistoryText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
  }

  isPlaceholderThreadName(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return true;
    return ['未命名线程', '未命名任务', '未命名', 'untitled', 'untitled thread', 'new thread'].includes(text);
  }

  displayPathName(cwd) {
    if (!cwd) return '对话';
    const normalized = path.normalize(cwd);
    if (normalized === os.homedir()) return '~';
    if (normalized === path.parse(normalized).root) return normalized;
    return path.basename(normalized) || normalized;
  }

  classifyThreadProject(cwd) {
    const normalized = cwd ? path.normalize(cwd) : '';
    const codexScratchRoot = path.join(os.homedir(), 'Documents', 'Codex');
    const relativeToScratch = normalized ? path.relative(codexScratchRoot, normalized) : '';
    const isGeneratedProjectless = Boolean(
      normalized && relativeToScratch && !relativeToScratch.startsWith('..') &&
      !path.isAbsolute(relativeToScratch) && /^\d{4}-\d{2}-\d{2}(?:$|[\\/])/.test(relativeToScratch)
    );
    if (!normalized || isGeneratedProjectless) {
      return { isProjectThread: false, projectKey: 'conversation', projectName: '对话', projectPath: '' };
    }
    return { isProjectThread: true, projectKey: normalized, projectName: this.displayPathName(normalized), projectPath: normalized };
  }

  // ---- Runtime Status ----

  quickRuntimeFromFile(file, stat = null) {
    let fileStat = stat;
    if (!fileStat) { try { fileStat = fs.statSync(file); } catch { fileStat = null; } }
    const cacheKey = fileStat ? `${file}:${this.fileCacheSignature(fileStat)}` : '';
    if (cacheKey && this.runtimeSummaryCache.has(cacheKey)) return this.runtimeSummaryCache.get(cacheKey);
    const isFresh = fileStat ? Date.now() - fileStat.mtimeMs <= CODEX_RUNTIME_STALE_MS : false;
    let runtime = this.summarizeRuntimeItems(this.readJsonlTail(file, CODEX_ACTIVITY_TAIL_BYTES), fileStat);
    if (runtime.status === 'idle' && runtime.sawRuntimeActivity && !runtime.sawTaskMarker && isFresh && fileStat && fileStat.size > CODEX_ACTIVITY_TAIL_BYTES) {
      runtime = this.summarizeRuntimeItems(this.readJsonlTail(file, CODEX_ACTIVITY_LOOKBACK_BYTES), fileStat);
    }
    if (runtime.status === 'idle' && runtime.sawRuntimeActivity && !runtime.sawTaskMarker && isFresh) {
      runtime.status = 'running'; runtime.active = true;
    }
    if (runtime.status === 'running' && fileStat && !isFresh) {
      runtime.status = 'idle'; runtime.active = false;
    }
    const { status, active, startedAt, completedAt, updatedAt, turnId } = runtime;
    return cacheKey
      ? this.boundedSet(this.runtimeSummaryCache, cacheKey, { status, active, startedAt, completedAt, updatedAt, turnId }, 600)
      : { status, active, startedAt, completedAt, updatedAt, turnId };
  }

  summarizeRuntimeItems(items, stat = null) {
    let status = 'idle', active = false, startedAt = '', completedAt = '', updatedAt = stat ? new Date(stat.mtimeMs).toISOString() : '';
    let turnId = '', sawRuntimeActivity = false, sawTaskMarker = false;
    for (const item of items) {
      const payload = item.payload || {};
      if (item.timestamp) updatedAt = item.timestamp;
      if (item.type === 'response_item' || (item.type === 'event_msg' && payload.type && !String(payload.type).startsWith('task_'))) sawRuntimeActivity = true;
      if (item.type === 'turn_context' && payload.turn_id) turnId = payload.turn_id;
      if (item.type === 'event_msg' && payload.type === 'task_started') {
        sawTaskMarker = true; status = 'running'; active = true; startedAt = item.timestamp || startedAt; completedAt = ''; turnId = payload.turn_id || turnId; updatedAt = item.timestamp || updatedAt;
      }
      if (item.type === 'event_msg' && payload.type === 'task_complete') {
        sawTaskMarker = true; status = 'complete'; active = false; completedAt = item.timestamp || completedAt; updatedAt = item.timestamp || updatedAt;
      }
      if (item.type === 'event_msg' && this.isTerminalFailurePayload(payload)) {
        sawTaskMarker = true; status = 'error'; active = false; completedAt = item.timestamp || completedAt; turnId = payload.turn_id || turnId; updatedAt = item.timestamp || updatedAt;
      }
    }
    return { status, active, startedAt, completedAt, updatedAt, turnId, sawRuntimeActivity, sawTaskMarker };
  }

  isTerminalFailurePayload(payload = {}) {
    if (!payload || typeof payload !== 'object') return false;
    const type = String(payload.type || '').toLowerCase();
    return type === 'turn_aborted' || /(?:^|_)(?:failed|failure|error|timeout|cancelled|canceled|aborted|interrupted)$/.test(type) ||
      (this.isFailureLikePayload(payload) && /(?:abort|cancel|interrupt|fail|error|timeout|unavailable|overload)/.test(type));
  }

  isFailureLikePayload(payload = {}) {
    const type = String(payload.type || '').toLowerCase();
    const status = String(payload.status || '').toLowerCase();
    const code = String(payload.code || '').toLowerCase();
    return /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(type) ||
      /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(status) ||
      /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(code) ||
      payload.error != null || payload.detail != null || payload.details != null || payload.reason != null;
  }

  // ---- File Reading ----

  readJsonlTail(file, maxBytes) {
    let stat;
    try { stat = fs.statSync(file); } catch { return []; }
    const start = Math.max(0, stat.size - maxBytes);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString('utf8');
      if (start > 0) { const firstNewline = text.indexOf('\n'); text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''; }
      return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { return []; } finally { if (typeof fd === 'number') { try { fs.closeSync(fd); } catch {} } }
  }

  readTailLines(file) {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - CODEX_SESSION_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      return text.split('\n').filter(Boolean);
    } finally { fs.closeSync(fd); }
  }

  readTailLinesWithLimit(file, maxBytes) {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString('utf8');
      if (start > 0) { const firstNewline = text.indexOf('\n'); text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''; }
      return text.split('\n').filter(Boolean);
    } finally { fs.closeSync(fd); }
  }

  readHistoryLinesAdaptive(file, desiredMessages = MAX_HISTORY_MESSAGES) {
    const stat = fs.statSync(file);
    const maxBytes = Math.min(stat.size, CODEX_HISTORY_TAIL_BYTES);
    const desired = Math.max(1, Math.min(Number(desiredMessages) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
    if (maxBytes <= CODEX_HISTORY_INITIAL_TAIL_BYTES * 6) {
      return { lines: this.readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
    }
    const initialBytes = Math.min(CODEX_HISTORY_INITIAL_TAIL_BYTES, maxBytes);
    const initialLines = this.readTailLinesWithLimit(file, initialBytes);
    if (this.countHistoryMessages(initialLines, desired) >= desired) {
      return { lines: initialLines, stat, scannedBytes: initialBytes };
    }
    return { lines: this.readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
  }

  countHistoryMessages(lines, maxNeeded = MAX_HISTORY_MESSAGES) {
    let count = 0, currentTurn = null;
    const need = Math.max(1, Math.min(Number(maxNeeded) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
    for (const line of lines) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const payload = item.payload || {};
      if (item.type === 'event_msg' && payload.type === 'task_started') { currentTurn = { hasAssistant: false }; continue; }
      if (item.type === 'event_msg' && payload.type === 'user_message') {
        const text = this.cleanUserHistoryText(payload.message);
        const attachments = this.extractUserAttachments(payload);
        if (text || attachments.length) count += 1;
      } else if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer') {
        const text = this.normalizeHistoryText(this.extractMessageText(payload.content));
        if (text) { count += 1; if (currentTurn) currentTurn.hasAssistant = true; }
      } else if (item.type === 'event_msg' && payload.type === 'task_complete') {
        const lastMessage = this.normalizeHistoryText(payload.last_agent_message || '');
        if (currentTurn && !currentTurn.hasAssistant) count += lastMessage ? 1 : 0;
        currentTurn = null;
      } else if (item.type === 'event_msg' && this.isTerminalFailurePayload(payload)) {
        if (currentTurn && !currentTurn.hasAssistant) count += 1;
        currentTurn = null;
      }
      if (count >= need) return count;
    }
    return count;
  }

  extractMessageText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(item => item && (item.text || item.message || '')).filter(Boolean).join('\n');
  }

  extractUserAttachments(payload) {
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

  // ---- Thread List ----

  listThreads(limit = 80) {
    const normalizedLimit = Math.max(1, Math.min(160, Number(limit) || 80));
    const cacheKey = String(normalizedLimit);
    const cached = this.threadListCache.get(cacheKey);
    if (cached && Date.now() - cached.at <= CODEX_THREAD_LIST_CACHE_MS) return cached.threads;

    const state = this.store ? this.store.readState() : { pinnedThreadIds: [], archivedThreadIds: [], titleOverrides: {} };
    const pinnedThreadIds = new Set(state.pinnedThreadIds || []);
    const archivedThreadIds = new Set(state.archivedThreadIds || []);
    const titleOverrides = state.titleOverrides || {};
    const byId = this.readThreadIndex();

    for (const file of this.listSessionFiles()) {
      const match = path.basename(file).match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i);
      if (!match) continue;
      const id = match[1];
      try {
        const stat = fs.statSync(file);
        const meta = this.readSessionMeta(file);
        const runtime = this.quickRuntimeFromFile(file, stat);
        const project = this.classifyThreadProject(meta.cwd || '');
        const existing = byId.get(id) || { id, name: '', updatedAt: '' };
        const fallbackName = this.isPlaceholderThreadName(existing.name) ? this.findFirstUserMessage(file) : '';
        existing.name = this.isPlaceholderThreadName(existing.name) ? (fallbackName || '未命名任务') : existing.name;
        existing.nameSource = fallbackName && existing.name === fallbackName ? 'first_user_message' : 'index';
        const override = titleOverrides[id];
        if (override && typeof override.name === 'string' && override.name.trim()) {
          const overrideTime = Date.parse(override.renamedAt || '') || 0;
          const indexTime = Date.parse(existing.updatedAt || '') || 0;
          if (!indexTime || !overrideTime || indexTime <= overrideTime + 2000 || existing.name === override.name || this.isPlaceholderThreadName(existing.name)) {
            existing.name = override.name.trim(); existing.nameSource = 'codex_mini_override';
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
    this.boundedSet(this.threadListCache, cacheKey, { at: Date.now(), threads }, 20);
    return threads;
  }

  listArchivedThreads(limit = 80) {
    const normalizedLimit = Math.max(1, Math.min(160, Number(limit) || 80));
    const state = this.store ? this.store.readState() : { archivedThreadIds: [], titleOverrides: {} };
    const archivedThreadIds = [...new Set((state.archivedThreadIds || []).filter(id => this.isCodexThreadId(id)))];
    if (!archivedThreadIds.length) return [];
    const archivedSet = new Set(archivedThreadIds);
    const titleOverrides = state.titleOverrides || {};
    const byId = this.readThreadIndex();
    for (const file of this.listSessionFiles()) {
      const match = path.basename(file).match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i);
      if (!match || !archivedSet.has(match[1])) continue;
      const id = match[1];
      try {
        const stat = fs.statSync(file);
        const meta = this.readSessionMeta(file);
        const runtime = this.quickRuntimeFromFile(file, stat);
        const project = this.classifyThreadProject(meta.cwd || '');
        const existing = byId.get(id) || { id, name: '', updatedAt: '' };
        const fallbackName = this.isPlaceholderThreadName(existing.name) ? this.findFirstUserMessage(file) : '';
        existing.name = this.isPlaceholderThreadName(existing.name) ? (fallbackName || '未命名任务') : existing.name;
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
    return archivedThreadIds.map(id => {
      const item = byId.get(id) || { id, name: '已归档任务', updatedAt: '', effectiveUpdatedMs: 0 };
      const project = item.projectName ? {} : this.classifyThreadProject(item.cwd || '');
      const effectiveUpdatedMs = item.effectiveUpdatedMs || Math.max(Date.parse(item.updatedAt) || 0, item.mtimeMs || 0);
      return { ...item, ...project, archived: true, effectiveUpdatedMs, effectiveUpdatedAt: effectiveUpdatedMs ? new Date(effectiveUpdatedMs).toISOString() : '' };
    }).sort((a, b) => b.effectiveUpdatedMs - a.effectiveUpdatedMs).slice(0, normalizedLimit);
  }

  invalidateThreadListCache() {
    this.threadListCache.clear();
  }

  // ---- History Parsing ----

  parseThreadHistory(threadId, limit = MAX_HISTORY_MESSAGES) {
    const file = this.findSessionFileByThreadId(threadId);
    if (!file) {
      return { ok: true, available: false, threadId, sessionFile: '', messages: [], message: '没有找到所选任务的 Codex 会话文件。' };
    }

    const messages = [];
    let currentTurn = null;

    const historyDurationText = (startedAt = '', completedAt = '') => {
      const startMs = Date.parse(startedAt || '');
      const endMs = Date.parse(completedAt || '');
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '';
      const total = Math.max(0, Math.floor((endMs - startMs) / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
    };

    const historyCompleteLabel = (startedAt = '', completedAt = '') => {
      const duration = historyDurationText(startedAt, completedAt);
      return duration ? `Codex · 已处理 ${duration}` : 'Codex';
    };

    const historyFailureLabel = (startedAt = '', completedAt = '') => {
      const duration = historyDurationText(startedAt, completedAt);
      return duration ? `Codex · 失败 ${duration}` : 'Codex';
    };

    const historyTail = this.readHistoryLinesAdaptive(file, limit);
    for (const line of historyTail.lines) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const payload = item.payload || {};

      if (item.type === 'event_msg' && payload.type === 'task_started') {
        currentTurn = { hasAssistant: false, assistantIndex: -1, failureText: '', startedAt: item.timestamp || '', turnId: payload.turn_id || '' };
        continue;
      }

      if (currentTurn && item.type === 'event_msg') {
        currentTurn.failureText = currentTurn.failureText || this.extractFailureTextFromPayload(payload);
      }

      if (currentTurn && item.type === 'turn_context') {
        currentTurn.turnId = payload.turn_id || currentTurn.turnId;
      }

      if (item.type === 'event_msg' && payload.type === 'user_message') {
        const text = this.cleanUserHistoryText(payload.message);
        const attachments = this.extractUserAttachments(payload);
        if (text || attachments.length) {
          messages.push({
            role: 'user',
            label: attachments.length ? `你 · ${attachments.length} 张图片` : '你',
            text: text || (attachments.length ? ' ' : ''),
            attachments: attachments.map(a => this.historyAttachmentDescriptor(a)).filter(Boolean),
            timestamp: item.timestamp || '',
          });
        }
        continue;
      }

      if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        const isFinal = payload.phase === 'final_answer';
        if (!isFinal) continue;
        const text = this.normalizeHistoryText(this.extractMessageText(payload.content));
        if (text) {
          const assistantIndex = messages.length;
          messages.push({ role: 'assistant', label: 'Codex', text, timestamp: item.timestamp || '' });
          if (currentTurn) { currentTurn.hasAssistant = true; currentTurn.assistantIndex = assistantIndex; }
        }
        continue;
      }

      if (item.type === 'event_msg' && payload.type === 'task_complete') {
        const lastMessage = this.normalizeHistoryText(payload.last_agent_message || '');
        const completedAt = item.timestamp || '';
        if (currentTurn && !currentTurn.hasAssistant) {
          const failureText = this.resolveFailureTextForTurn(threadId, {
            turnId: currentTurn.turnId || '', startedAt: currentTurn.startedAt || '', completedAt, failureText: currentTurn.failureText || '',
          });
          messages.push({
            role: 'assistant',
            label: failureText ? historyFailureLabel(currentTurn.startedAt, completedAt) : historyCompleteLabel(currentTurn.startedAt, completedAt),
            text: lastMessage || failureText || 'Codex GUI 这次没有返回可显示回复。',
            timestamp: completedAt || currentTurn.startedAt || '',
          });
        } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
          messages[currentTurn.assistantIndex].label = historyCompleteLabel(currentTurn.startedAt, completedAt);
        }
        currentTurn = null;
      }

      if (item.type === 'event_msg' && this.isTerminalFailurePayload(payload)) {
        const failureText = this.normalizeHistoryText(this.extractFailureTextFromPayload(payload) || currentTurn?.failureText || '');
        if (currentTurn && !currentTurn.hasAssistant) {
          messages.push({
            role: 'assistant',
            label: historyFailureLabel(currentTurn.startedAt, item.timestamp || ''),
            text: failureText || 'Codex GUI 这次没有返回可显示回复。',
            timestamp: item.timestamp || currentTurn.startedAt || '',
          });
        } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
          messages[currentTurn.assistantIndex].label = historyFailureLabel(currentTurn.startedAt, item.timestamp || '');
        }
        currentTurn = null;
      }
    }

    return {
      ok: true,
      available: true,
      threadId,
      sessionFile: path.basename(file),
      truncated: historyTail.stat.size > CODEX_HISTORY_TAIL_BYTES,
      messages: messages.slice(-Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES))),
    };
  }

  // ---- Failure Text ----

  extractFailureTextFromPayload(payload = {}) {
    if (!payload || typeof payload !== 'object' || !this.isFailureLikePayload(payload)) return '';
    const text = this.extractPlainTextDeep(payload)
      .map(value => this.normalizeHistoryText(value))
      .filter(Boolean)
      .filter(value => !/^(true|false|null|undefined)$/i.test(value))
      .join('\n');
    return this.truncateText(text, 1600);
  }

  extractPlainTextDeep(value, seen = new Set()) {
    if (value == null) return [];
    if (typeof value === 'string') return [value];
    if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    if (typeof value !== 'object') return [];
    if (seen.has(value)) return [];
    seen.add(value);
    const out = [];
    if (Array.isArray(value)) { for (const item of value) out.push(...this.extractPlainTextDeep(item, seen)); return out; }
    for (const key of ['message', 'detail', 'details', 'error', 'reason', 'description', 'status', 'code', 'title', 'text']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) out.push(...this.extractPlainTextDeep(value[key], seen));
    }
    return out;
  }

  truncateText(value, max = 700) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  resolveFailureTextForTurn(threadId, options = {}) {
    const sessionText = this.normalizeHistoryText(options.failureText || '');
    if (sessionText) {
      this.storeGuiFailureText(threadId, { ...options, text: sessionText, source: 'codex_session' });
      return sessionText;
    }
    const storedText = this.findStoredGuiFailureText(threadId, options);
    if (storedText) return storedText;
    const desktopText = this.findCodexDesktopFailureText({ ...options, threadId });
    if (desktopText) return this.storeGuiFailureText(threadId, { ...options, text: desktopText, source: 'codex_desktop_log' }) || desktopText;
    return '';
  }

  storeGuiFailureText(threadId, report = {}) {
    if (!this.isCodexThreadId(threadId)) return '';
    const text = this.truncateText(this.normalizeHistoryText(report.text || ''), 2000);
    if (!text || text === 'Codex GUI 这次没有返回可显示回复。') return '';
    const state = this.store ? this.store.readState() : { guiFailureReports: {} };
    const rows = state.guiFailureReports[threadId] || [];
    const turnId = typeof report.turnId === 'string' ? report.turnId : '';
    const completedAt = typeof report.completedAt === 'string' ? report.completedAt : '';
    const existingIndex = rows.findIndex(row => (turnId && row.turnId === turnId) || (completedAt && row.completedAt === completedAt && row.text === text));
    const row = { turnId, text, capturedAt: new Date().toISOString(), completedAt, source: typeof report.source === 'string' ? report.source : 'codex_desktop' };
    if (existingIndex >= 0) rows[existingIndex] = { ...rows[existingIndex], ...row };
    else rows.push(row);
    state.guiFailureReports[threadId] = rows.slice(-GUI_FAILURE_REPORT_LIMIT);
    if (this.store) this.store.writeState(state);
    return text;
  }

  findStoredGuiFailureText(threadId, options = {}) {
    if (!this.isCodexThreadId(threadId)) return '';
    const state = this.store ? this.store.readState() : { guiFailureReports: {} };
    const rows = state.guiFailureReports[threadId] || [];
    const turnId = typeof options.turnId === 'string' ? options.turnId : '';
    if (turnId) { const exact = [...rows].reverse().find(row => row.turnId === turnId && row.text); if (exact) return exact.text; }
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

  findCodexDesktopFailureText(options = {}) {
    const threadId = this.isCodexThreadId(options.threadId) ? options.threadId : '';
    const turnId = typeof options.turnId === 'string' ? options.turnId : '';
    const startedMs = Date.parse(options.startedAt || '') || 0;
    const completedMs = Date.parse(options.completedAt || '') || Date.now();
    const minMs = startedMs ? startedMs - 60 * 1000 : completedMs - GUI_FAILURE_LOG_RECENT_MS;
    const maxMs = completedMs + 2 * 60 * 1000;
    const matches = [];
    for (const file of this.recentDesktopLogFiles(completedMs)) {
      let lines;
      try { lines = this.readTailLinesWithLimit(file, GUI_FAILURE_LOG_SCAN_BYTES); } catch { continue; }
      for (const line of lines) {
        const lineMs = Date.parse(line.slice(0, 24));
        if (Number.isFinite(lineMs) && (lineMs < minMs || lineMs > maxMs)) continue;
        const text = this.extractDesktopLogFailureText(line);
        const score = this.scoreDesktopFailureLine(line, text, options);
        if (score >= 50) matches.push({ text, lineMs: Number.isFinite(lineMs) ? lineMs : 0, score });
      }
    }
    matches.sort((a, b) => b.score - a.score || b.lineMs - a.lineMs);
    return matches[0] ? matches[0].text : '';
  }

  recentDesktopLogFiles(referenceMs = Date.now()) {
    return this.walkFiles(CODEX_DESKTOP_LOGS_DIR, file => file.endsWith('.log'))
      .map(file => { try { const stat = fs.statSync(file); return { file, mtimeMs: stat.mtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .filter(item => item.mtimeMs >= referenceMs - GUI_FAILURE_LOG_RECENT_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 40)
      .map(item => item.file);
  }

  extractDesktopLogFailureText(line) {
    const raw = String(line || '');
    if (!/(?:\berror\b|failed|failure|Forbidden|unexpected status|channel affinity|AiMaMi|revoked|Unauthorized)/i.test(raw)) return '';
    if (/(?:git\.command\.complete|worker_rpc_response_error|Conversation state not found|Received turn\/(?:started|completed) for unknown conversation|Item not found in turn state)/i.test(raw)) return '';
    const candidates = [];
    for (const key of ['error', 'result']) {
      const jsonText = this.extractJsonAssignment(raw, key);
      const parsed = jsonText ? this.safeParseJsonText(jsonText) : null;
      const directText = parsed && typeof parsed === 'object'
        ? this.normalizeHistoryText(parsed.message || parsed.detail || parsed.error || parsed.reason || '') : '';
      const text = parsed ? (directText || this.extractFailureTextFromPayload(parsed) || this.truncateText(this.extractPlainTextDeep(parsed).map(v => this.normalizeHistoryText(v)).filter(Boolean).join('\n'), 2000)) : '';
      if (text) candidates.push(text);
    }
    for (const key of ['errorMessage', 'message', 'detail']) {
      const match = raw.match(new RegExp(`(?:^|\\s)${key}="((?:\\\\.|[^"])*)"`, 'i'));
      if (match) candidates.push(this.decodeLogQuotedValue(match[1]));
    }
    if (!candidates.length && /(?:unexpected status|Forbidden|channel affinity|AiMaMi)/i.test(raw)) {
      candidates.push(raw.replace(/^\S+\s+\w+\s+\[[^\]]+\]\s*/, '').trim());
    }
    const text = [...new Set(candidates.map(v => this.normalizeHistoryText(v)).filter(Boolean).filter(v => !/^Request failed$/i.test(v)))].join('\n');
    return this.truncateText(text, 2000);
  }

  scoreDesktopFailureLine(line, text, options = {}) {
    const raw = String(line || '');
    const failure = String(text || '');
    if (!failure) return 0;
    let score = 1;
    const threadId = this.isCodexThreadId(options.threadId) ? options.threadId : '';
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

  extractJsonAssignment(line, key) {
    const marker = `${key}=`;
    const start = line.indexOf(marker);
    if (start < 0) return null;
    const open = line.indexOf('{', start + marker.length);
    if (open < 0) return null;
    let depth = 0, inString = false, escaped = false;
    for (let i = open; i < line.length; i += 1) {
      const ch = line[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') { depth -= 1; if (depth === 0) return line.slice(open, i + 1); }
    }
    return null;
  }

  safeParseJsonText(value) {
    try { return JSON.parse(value); } catch { return null; }
  }

  decodeLogQuotedValue(value) {
    const raw = String(value || '');
    if (!raw) return '';
    try { return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`); } catch { return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
  }

  // ---- Attachment ----

  historyAttachmentDescriptor(filePath) {
    const absolutePath = path.resolve(String(filePath || ''));
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(absolutePath).toLowerCase()];
    if (!mime) return null;
    try {
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) return null;
    } catch { return null; }
    const now = Date.now();
    for (const [id, item] of this.historyAttachmentCache) {
      if (item.expiresAt <= now) this.historyAttachmentCache.delete(id);
      else if (item.filePath === absolutePath) return { name: path.basename(absolutePath), url: `/codex/attachment?id=${encodeURIComponent(id)}` };
    }
    while (this.historyAttachmentCache.size >= HISTORY_ATTACHMENT_LIMIT) this.historyAttachmentCache.delete(this.historyAttachmentCache.keys().next().value);
    const id = require('crypto').randomBytes(18).toString('base64url');
    this.historyAttachmentCache.set(id, { filePath: absolutePath, mime, expiresAt: now + HISTORY_ATTACHMENT_TTL_MS });
    return { name: path.basename(absolutePath), url: `/codex/attachment?id=${encodeURIComponent(id)}` };
  }

  getHistoryAttachment(id) {
    const item = this.historyAttachmentCache.get(id);
    if (!item || item.expiresAt <= Date.now()) { this.historyAttachmentCache.delete(id); return null; }
    return item;
  }
}

module.exports = { CodexSessionParser };
