'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const APPROVAL_PREVIEW_LIMIT = 3200;
const STANDARD_APPROVAL_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);

function previewText(value, limit = APPROVAL_PREVIEW_LIMIT) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}...` : text;
}

function previewJson(value, limit = APPROVAL_PREVIEW_LIMIT) {
  if (value == null || value === '') return '';
  try {
    return previewText(JSON.stringify(value, null, 2), limit);
  } catch {
    return previewText(value, limit);
  }
}

function cloneJson(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function decisionNames(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return String(item.decision || item.id || item.value || item.name || item.type || '');
  }).filter(item => STANDARD_APPROVAL_DECISIONS.has(item)))];
}

function newestFile(paths) {
  return paths
    .map(file => {
      try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || '';
}

function findCodexExecutable() {
  const configured = String(process.env.CODEX_APP_SERVER_BIN || process.env.CODEX_CLI_PATH || '').trim();
  if (configured && fs.existsSync(configured)) return configured;

  if (process.platform === 'win32') {
    const binRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = fs.readdirSync(binRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(binRoot, entry.name, 'codex.exe'))
        .filter(file => fs.existsSync(file));
      const selected = newestFile(candidates);
      if (selected) return selected;
    } catch {}
  }

  return 'codex';
}

function asError(value, fallback = 'Codex App Server 请求失败。') {
  if (value instanceof Error) return value;
  const message = value && typeof value === 'object' ? value.message : String(value || fallback);
  const error = new Error(message || fallback);
  if (value && typeof value === 'object') {
    error.code = value.code;
    error.data = value.data;
  }
  return error;
}

class CodexAppServer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false && process.env.CODEX_MAX_APP_SERVER !== '0';
    this.executable = options.executable || findCodexExecutable();
    this.cwd = options.cwd || process.cwd();
    this.child = null;
    this.reader = null;
    this.startPromise = null;
    this.pending = new Map();
    this.pendingServerRequests = new Map();
    this.threadRuntime = new Map();
    this.nextId = 1;
    this.initialized = false;
    this.lastError = '';
    this.lastStartedAt = '';
    this.stderrTail = [];
    this.pendingServerRequestTtlMs = Math.max(60 * 1000, Number(process.env.CODEX_MAX_APPROVAL_TTL_MS) || 60 * 60 * 1000);
    this.threadRuntimeTtlMs = Math.max(60 * 1000, Number(process.env.CODEX_MAX_THREAD_RUNTIME_TTL_MS) || 6 * 60 * 60 * 1000);
    this._staleTimer = setInterval(() => this._pruneStaleState(), 60 * 1000);
    if (this._staleTimer.unref) this._staleTimer.unref();
  }

  isAvailable() {
    return Boolean(this.enabled && this.child && this.initialized && !this.child.killed);
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.isAvailable(),
      executable: this.executable,
      pid: this.child?.pid || 0,
      startedAt: this.lastStartedAt,
      lastError: this.lastError,
    };
  }

  runtimeForThread(threadId) {
    return this.threadRuntime.get(String(threadId || '')) || null;
  }

  _pruneStaleState() {
    const now = Date.now();
    for (const [key, request] of this.pendingServerRequests) {
      const received = Date.parse(request?.receivedAt || '');
      if (Number.isFinite(received) && now - received > this.pendingServerRequestTtlMs) {
        this.pendingServerRequests.delete(key);
      }
    }
    for (const [key, runtime] of this.threadRuntime) {
      const updated = Date.parse(runtime?.updatedAt || '');
      if (Number.isFinite(updated) && now - updated > this.threadRuntimeTtlMs) {
        this.threadRuntime.delete(key);
      }
    }
  }

  listPendingApprovals(options = {}) {
    const threadId = String(options.threadId || '').trim();
    return [...this.pendingServerRequests.values()]
      .map(request => this.normalizePendingApproval(request))
      .filter(Boolean)
      .filter(request => !threadId || request.threadId === threadId)
      .sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  }

  normalizePendingApproval(request) {
    const method = String(request?.method || '');
    const params = request?.params && typeof request.params === 'object' ? request.params : {};
    const common = {
      requestId: String(request?.id ?? ''),
      method,
      threadId: String(params.threadId || ''),
      turnId: String(params.turnId || ''),
      itemId: String(params.itemId || ''),
      receivedAt: request?.receivedAt || '',
      reason: previewText(params.reason, 1600),
    };

    if (method === 'item/commandExecution/requestApproval') {
      const network = params.networkApprovalContext && typeof params.networkApprovalContext === 'object'
        ? params.networkApprovalContext
        : null;
      const protocol = previewText(network?.protocol, 60);
      const host = previewText(network?.host, 300);
      const port = previewText(network?.port, 20);
      const target = network && (host || protocol || port)
        ? `${protocol ? `${protocol}://` : ''}${host}${port ? `:${port}` : ''}`
        : '';
      const decisions = decisionNames(params.availableDecisions);
      return {
        ...common,
        kind: network ? 'network' : 'command',
        title: network ? '需要允许网络访问' : '需要执行命令',
        command: previewText(params.command),
        cwd: previewText(params.cwd, 1000),
        networkTarget: target || previewJson(network, 1400),
        commandActions: previewJson(params.commandActions, 1800),
        additionalPermissions: previewJson(params.additionalPermissions, 1800),
        decisions: decisions.length ? decisions : ['accept', 'acceptForSession', 'decline', 'cancel'],
      };
    }

    if (method === 'item/fileChange/requestApproval') {
      const decisions = decisionNames(params.availableDecisions);
      return {
        ...common,
        kind: 'fileChange',
        title: '需要允许修改文件',
        grantRoot: previewText(params.grantRoot || params.cwd, 1600),
        decisions: decisions.length ? decisions : ['accept', 'acceptForSession', 'decline', 'cancel'],
      };
    }

    if (method === 'item/permissions/requestApproval') {
      return {
        ...common,
        kind: 'permissions',
        title: '需要授予额外权限',
        cwd: previewText(params.cwd, 1000),
        permissions: previewJson(params.permissions, 2600),
        decisions: ['accept', 'acceptForSession', 'decline'],
      };
    }

    if (method === 'mcpServer/elicitation/request') {
      return {
        ...common,
        kind: 'mcp',
        title: 'MCP 服务需要确认',
        serverName: previewText(params.serverName, 300),
        mode: previewText(params.mode, 80),
        message: previewText(params.message, 1800),
        url: previewText(params.url, 1800),
        schema: previewJson(params.requestedSchema, 1800),
        decisions: ['decline', 'cancel'],
      };
    }

    return null;
  }

  resolvePendingApproval(requestId, decision) {
    const key = String(requestId || '').trim();
    const request = this.pendingServerRequests.get(key);
    if (!request) {
      const error = new Error('这个授权请求已失效或已被处理。');
      error.status = 404;
      error.code = 'APPROVAL_NOT_FOUND';
      throw error;
    }

    const approval = this.normalizePendingApproval(request);
    if (!approval) {
      const error = new Error('这个 Codex 请求暂不支持通过手机处理。');
      error.status = 400;
      error.code = 'APPROVAL_NOT_SUPPORTED';
      throw error;
    }

    const selected = String(decision || '').trim();
    if (!approval.decisions.includes(selected)) {
      const error = new Error('这个授权请求不支持所选操作。');
      error.status = 400;
      error.code = 'APPROVAL_DECISION_NOT_ALLOWED';
      throw error;
    }

    const params = request.params && typeof request.params === 'object' ? request.params : {};
    let result;
    if (approval.kind === 'command' || approval.kind === 'network' || approval.kind === 'fileChange') {
      result = { decision: selected };
    } else if (approval.kind === 'permissions') {
      result = selected === 'decline'
        ? { permissions: {}, scope: 'turn' }
        : {
          permissions: cloneJson(params.permissions, {}),
          scope: selected === 'acceptForSession' ? 'session' : 'turn',
        };
    } else if (approval.kind === 'mcp') {
      result = { action: selected, content: null };
    }

    this.sendResponse(request.id, result);
    this.pendingServerRequests.delete(key);
    return {
      requestId: key,
      threadId: approval.threadId,
      turnId: approval.turnId,
      kind: approval.kind,
      decision: selected,
    };
  }

  clearPendingApprovalsForThread(threadId, turnId = '') {
    const targetThreadId = String(threadId || '');
    const targetTurnId = String(turnId || '');
    if (!targetThreadId) return;
    for (const [key, request] of this.pendingServerRequests) {
      const params = request?.params || {};
      if (String(params.threadId || '') !== targetThreadId) continue;
      if (targetTurnId && String(params.turnId || '') !== targetTurnId) continue;
      this.pendingServerRequests.delete(key);
    }
  }

  async ensureStarted() {
    if (!this.enabled) throw new Error('Codex App Server 已禁用。');
    if (this.isAvailable()) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async start() {
    this.close();
    this.lastError = '';
    this.stderrTail = [];
    let child;
    try {
      child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
        cwd: this.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.lastError = error.message || String(error);
      throw error;
    }

    this.child = child;
    this.lastStartedAt = new Date().toISOString();
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on('line', line => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const lines = String(chunk || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      this.stderrTail.push(...lines);
      if (this.stderrTail.length > 30) this.stderrTail.splice(0, this.stderrTail.length - 30);
    });
    child.on('error', error => this.handleExit(error));
    child.on('exit', (code, signal) => this.handleExit(new Error(`Codex App Server 已退出（${signal || code || 0}）。`)));

    try {
      await this.callRaw('initialize', {
        clientInfo: {
          name: 'codex_remote_bridge',
          title: 'Codex Remote Bridge',
          version: '3.1.0',
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [
            'rawResponseItem/completed',
            'rawResponse/completed',
            'command/exec/outputDelta',
            'process/outputDelta',
            'item/commandExecution/outputDelta',
            'item/fileChange/outputDelta',
          ],
        },
      }, 15000, true);
      this.sendNotification('initialized');
      this.initialized = true;
      return this;
    } catch (error) {
      this.lastError = error.message || String(error);
      this.close();
      throw error;
    }
  }

  handleExit(error) {
    if (error && !this.lastError) this.lastError = error.message || String(error);
    this.initialized = false;
    const failure = asError(error, 'Codex App Server 已断开。');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    this.pendingServerRequests.clear();
    this.child = null;
    if (this.reader) {
      try { this.reader.close(); } catch {}
      this.reader = null;
    }
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }

    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(asError(message.error));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.id !== null && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.method) this.handleNotification(message.method, message.params || {});
  }

  handleServerRequest(message) {
    if (message.method === 'currentTime/read') {
      this.sendResponse(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    this.pendingServerRequests.set(String(message.id), {
      id: message.id,
      method: message.method,
      params: message.params || {},
      receivedAt: new Date().toISOString(),
    });
  }

  handleNotification(method, params) {
    if (method === 'serverRequest/resolved') {
      const requestId = String(params.requestId ?? params.id ?? '');
      if (requestId) this.pendingServerRequests.delete(requestId);
      return;
    }

    const threadId = String(params.threadId || params.thread?.id || '');
    if (!threadId) return;
    const current = this.threadRuntime.get(threadId) || { threadId, activeTurnId: '', status: 'idle', updatedAt: '' };
    if (method === 'turn/started') {
      current.activeTurnId = String(params.turn?.id || params.turnId || '');
      current.status = 'running';
      current.fresh = false;
      current.startedAt = params.turn?.startedAt ? new Date(params.turn.startedAt * 1000).toISOString() : new Date().toISOString();
    } else if (method === 'turn/completed') {
      current.activeTurnId = '';
      current.status = params.turn?.status === 'failed' ? 'error' : 'complete';
      current.completedAt = new Date().toISOString();
      this.clearPendingApprovalsForThread(threadId, params.turn?.id || params.turnId || '');
    } else if (method === 'thread/status/changed') {
      const statusType = params.status?.type || params.thread?.status?.type || '';
      if (statusType === 'active') current.status = 'running';
      else if (statusType === 'idle') current.status = 'idle';
      else if (statusType === 'systemError') current.status = 'error';
    }
    current.updatedAt = new Date().toISOString();
    this.threadRuntime.set(threadId, current);
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server 尚未连接。');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendNotification(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.send(message);
  }

  sendResponse(id, result) {
    this.send({ id, result });
  }

  async callRaw(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, skipEnsure = false) {
    if (!skipEnsure) await this.ensureStarted();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async call(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    return this.callRaw(method, params, timeoutMs, false);
  }

  async listThreads(options = {}) {
    const response = await this.call('thread/list', {
      limit: Math.max(1, Math.min(160, Number(options.limit) || 80)),
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: options.archived === true,
      searchTerm: options.searchTerm || null,
    });
    return Array.isArray(response?.data) ? response.data : [];
  }

  async readThread(threadId, includeTurns = true) {
    const response = await this.call('thread/read', { threadId, includeTurns }, 60000);
    return response?.thread || null;
  }

  async startThread(options = {}) {
    const params = {};
    if (options.cwd) params.cwd = options.cwd;
    if (options.model) params.model = options.model;
    const response = await this.call('thread/start', params, 45000);
    const thread = response?.thread;
    if (!thread?.id) throw new Error('Codex 没有返回新任务 ID。');
    this.threadRuntime.set(thread.id, {
      threadId: thread.id,
      activeTurnId: '',
      status: 'idle',
      fresh: true,
      updatedAt: new Date().toISOString(),
    });
    return response;
  }

  async resumeThread(threadId, options = {}) {
    const params = { threadId, excludeTurns: options.excludeTurns !== false };
    if (options.cwd) params.cwd = options.cwd;
    if (options.model) params.model = options.model;
    const response = await this.call('thread/resume', params, 60000);
    const status = response?.thread?.status;
    const current = this.threadRuntime.get(threadId) || { threadId, activeTurnId: '', status: 'idle', updatedAt: '' };
    if (status?.type === 'active') current.status = 'running';
    else if (status?.type === 'systemError') current.status = 'error';
    else current.status = 'idle';
    current.fresh = false;
    current.updatedAt = new Date().toISOString();
    this.threadRuntime.set(threadId, current);
    return response;
  }

  async updateThreadSettings(threadId, settings = {}) {
    await this.resumeThread(threadId, { excludeTurns: true });
    const params = { threadId };
    if (settings.model) params.model = settings.model;
    if (settings.effort) params.effort = settings.effort;
    if (settings.cwd) params.cwd = settings.cwd;
    return this.call('thread/settings/update', params);
  }

  async sendTurn(options = {}) {
    let threadId = String(options.threadId || '');
    let threadResponse;
    const existingRuntime = threadId ? this.threadRuntime.get(threadId) : null;
    if (threadId && existingRuntime?.fresh) {
      threadResponse = { thread: { id: threadId, status: { type: 'idle' }, turns: [] } };
    } else if (threadId) {
      threadResponse = await this.resumeThread(threadId, { cwd: options.cwd, model: options.model, excludeTurns: true });
    }
    else {
      threadResponse = await this.startThread({ cwd: options.cwd, model: options.model });
      threadId = threadResponse.thread.id;
    }

    const input = [];
    if (String(options.text || '').trim()) input.push({ type: 'text', text: String(options.text), text_elements: [] });
    for (const imagePath of options.imagePaths || []) input.push({ type: 'localImage', path: imagePath });
    if (!input.length) throw new Error('请输入文字或添加图片。');

    const runtime = this.threadRuntime.get(threadId) || {};
    const activeTurnId = String(runtime.activeTurnId || '');
    const clientUserMessageId = options.clientUserMessageId || crypto.randomUUID();
    let result;
    let steered = false;
    if (runtime.status === 'running' && activeTurnId) {
      result = await this.call('turn/steer', {
        threadId,
        expectedTurnId: activeTurnId,
        clientUserMessageId,
        input,
      });
      steered = true;
    } else {
      const params = { threadId, clientUserMessageId, input };
      if (options.model) params.model = options.model;
      if (options.effort) params.effort = options.effort;
      result = await this.call('turn/start', params, 45000);
      const turnId = String(result?.turn?.id || '');
      this.threadRuntime.set(threadId, {
        threadId,
        activeTurnId: turnId,
        status: 'running',
        fresh: false,
        startedAt: result?.turn?.startedAt ? new Date(result.turn.startedAt * 1000).toISOString() : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return { threadId, result, steered, thread: threadResponse?.thread || null };
  }

  async interrupt(threadId, turnId = '') {
    const runtime = this.threadRuntime.get(threadId) || {};
    let targetTurnId = String(turnId || runtime.activeTurnId || '');
    if (!targetTurnId) {
      const thread = await this.readThread(threadId, true);
      const active = [...(thread?.turns || [])].reverse().find(turn => turn.status === 'inProgress');
      targetTurnId = String(active?.id || '');
    }
    if (!targetTurnId) throw new Error('这个任务当前没有可停止的回复。');
    const result = await this.call('turn/interrupt', { threadId, turnId: targetTurnId });
    this.threadRuntime.set(threadId, {
      threadId,
      activeTurnId: '',
      status: 'idle',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return result;
  }

  async setThreadName(threadId, name) {
    return this.call('thread/name/set', { threadId, name });
  }

  async archiveThread(threadId) {
    return this.call('thread/archive', { threadId });
  }

  async setThreadPinned(threadId, pinned) {
    return this.call('thread/metadata/update', {
      threadId,
      thread: { isPinned: Boolean(pinned) },
    });
  }

  async compactThread(threadId) {
    return this.call('thread/compact/start', { threadId }, 45000);
  }

  async startReview(threadId, options = {}) {
    const delivery = options.delivery === 'detached' ? 'detached' : 'inline';
    const target = options.target && typeof options.target === 'object'
      ? options.target
      : { type: 'uncommittedChanges' };
    const result = await this.call('review/start', { threadId, delivery, target }, 45000);
    const reviewThreadId = String(result?.reviewThreadId || threadId || '');
    const turn = result?.turn || {};
    if (reviewThreadId && turn?.id) {
      this.threadRuntime.set(reviewThreadId, {
        threadId: reviewThreadId,
        activeTurnId: String(turn.id),
        status: 'running',
        fresh: false,
        startedAt: turn.startedAt ? new Date(turn.startedAt * 1000).toISOString() : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return result;
  }

  async listModels() {
    const response = await this.call('model/list', { limit: 100, includeHidden: false });
    return Array.isArray(response?.data) ? response.data : [];
  }

  async listPlugins() {
    return this.call('plugin/list', {}, 60000);
  }

  async listSkills(cwds = [], options = {}) {
    const normalizedCwds = [...new Set((Array.isArray(cwds) ? cwds : [])
      .map(value => String(value || '').trim())
      .filter(Boolean))];
    if (!normalizedCwds.length) return [];
    const response = await this.call('skills/list', {
      cwds: normalizedCwds,
      forceReload: options.forceReload === true,
    }, 60000);
    return Array.isArray(response?.data) ? response.data : [];
  }

  async listApps(options = {}) {
    const response = await this.call('app/list', {
      cursor: null,
      limit: Math.max(1, Math.min(100, Number(options.limit) || 50)),
      forceRefetch: options.forceRefetch === true,
    }, 60000);
    return Array.isArray(response?.data) ? response.data : [];
  }

  close() {
    this.initialized = false;
    this.pendingServerRequests.clear();
    if (this._staleTimer) {
      clearInterval(this._staleTimer);
      this._staleTimer = null;
    }
    if (this.reader) {
      try { this.reader.close(); } catch {}
      this.reader = null;
    }
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
  }
}

module.exports = {
  CodexAppServer,
  findCodexExecutable,
};
