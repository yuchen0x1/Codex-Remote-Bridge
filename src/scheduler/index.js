'use strict';

/**
 * 定时任务引擎 - 管理计划任务的创建、调度、执行和持久化
 * 支持间隔模式和 cron 表达式，支持失败重试
 */

const crypto = require('crypto');
const { isCodexThreadId, truncateText } = require('../store');
const { CronParser, isValidTimeZone, getRetryDelay, shouldRetry, RETRY_STRATEGIES } = require('./cron');

const SCHEDULED_TASK_LIMIT = 64;
const SCHEDULED_TASK_MIN_INTERVAL_MINUTES = 5;
const SCHEDULED_TASK_MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const SCHEDULED_TASK_POLL_MS = 30000;

function normalizeScheduleInterval(value) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return 60;
  return Math.max(SCHEDULED_TASK_MIN_INTERVAL_MINUTES, Math.min(SCHEDULED_TASK_MAX_INTERVAL_MINUTES, minutes));
}

function normalizeIsoTimestamp(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
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

  // cron 表达式支持
  const cronExpression = String(row.cronExpression || '').trim();
  let cronParser = null;
  let scheduleMode = 'interval'; // 'interval' 或 'cron'
  if (cronExpression) {
    try {
      cronParser = new CronParser(cronExpression, { timeZone: row.timezone || undefined });
      if (cronParser.isValid()) scheduleMode = 'cron';
      else cronParser = null;
    } catch { cronParser = null; }
  }
  const timezone = isValidTimeZone(row.timezone) ? String(row.timezone).trim() : '';

  // 重试策略
  const retryStrategy = ['none', 'fixed', 'exponential'].includes(row.retryStrategy) ? row.retryStrategy : 'none';

  const now = new Date();
  // 计算下次运行时间
  let nextRunAt = normalizeIsoTimestamp(row.nextRunAt);
  if (!nextRunAt) {
    if (scheduleMode === 'cron' && cronParser) {
      const next = cronParser.nextRun(now);
      nextRunAt = next ? next.toISOString() : new Date(now.getTime() + 3600000).toISOString();
    } else {
      nextRunAt = new Date(now.getTime() + intervalMinutes * 60000).toISOString();
    }
  }

  return {
    id,
    prompt: prompt.slice(0, 8000),
    cwd: String(row.cwd || '').trim().slice(0, 2000),
    threadId: runMode === 'thread' ? threadId : '',
    runMode,
    scheduleMode,
    intervalMinutes,
    cronExpression: cronParser ? cronExpression : '',
    cronDescription: cronParser ? (timezone ? `${cronParser.describe()}（${timezone}）` : cronParser.describe()) : '',
    timezone,
    retryStrategy,
    retryCount: Math.max(0, Number(row.retryCount) || 0),
    enabled: row.enabled !== false,
    createdAt: normalizeIsoTimestamp(row.createdAt) || now.toISOString(),
    updatedAt: normalizeIsoTimestamp(row.updatedAt) || now.toISOString(),
    nextRunAt,
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

function createScheduledTaskRecord(payload = {}, existing = null) {
  const now = new Date();
  const id = existing?.id || `task-${crypto.randomBytes(6).toString('hex')}`;
  const intervalMinutes = normalizeScheduleInterval(payload.intervalMinutes ?? existing?.intervalMinutes ?? 60);
  const cronExpression = String(payload.cronExpression ?? existing?.cronExpression ?? '').trim();
  const timezone = isValidTimeZone(payload.timezone) ? String(payload.timezone).trim() : (existing?.timezone || '');
  const retryStrategy = payload.retryStrategy ?? existing?.retryStrategy ?? 'none';
  const base = existing || {};
  return normalizeScheduledTask({
    id,
    prompt: payload.prompt ?? base.prompt ?? '',
    cwd: payload.cwd ?? base.cwd ?? '',
    threadId: payload.threadId ?? base.threadId ?? '',
    runMode: payload.runMode ?? base.runMode ?? 'standalone',
    intervalMinutes,
    cronExpression,
    timezone,
    retryStrategy,
    retryCount: base.retryCount || 0,
    enabled: payload.enabled !== undefined ? payload.enabled : (base.enabled !== false),
    createdAt: base.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: base.nextRunAt || '',
    lastRunAt: base.lastRunAt,
    lastStatus: base.lastStatus || 'idle',
    lastMessage: base.lastMessage,
    lastThreadId: base.lastThreadId,
  });
}

function nextScheduledRunAt(task, nowMs = Date.now()) {
  // cron 模式：使用 cron 解析器计算下次运行时间
  if (task.scheduleMode === 'cron' && task.cronExpression) {
    try {
      const parser = new CronParser(task.cronExpression, { timeZone: task.timezone || undefined });
      const next = parser.nextRun(new Date(nowMs));
      return next ? next.toISOString() : new Date(nowMs + 3600000).toISOString();
    } catch {}
  }

  // 间隔模式
  const intervalMs = normalizeScheduleInterval(task.intervalMinutes) * 60000;
  const previous = Date.parse(task.nextRunAt || '');
  const base = Number.isFinite(previous) ? previous : nowMs;
  return new Date(Math.max(nowMs + intervalMs, base + intervalMs)).toISOString();
}

function getRetryDelayForTask(task, attempt) {
  return getRetryDelay(task.retryStrategy || 'none', attempt);
}

function shouldRetryTask(task, attempt) {
  return shouldRetry(task.retryStrategy || 'none', attempt);
}

class Scheduler {
  constructor(options = {}) {
    this.store = options.store;
    this.codexAppServer = options.codexAppServer;
    this.logger = options.logger || console;
    this.pollMs = options.pollMs || SCHEDULED_TASK_POLL_MS;
    this._timer = null;
    this._runningTasks = new Set();
    // 可选的执行日志回调（例如接入 SQLite 持久化队列的 logExecution）
    this.logExecution = typeof options.logExecution === 'function' ? options.logExecution : null;
  }

  // ---- State access ----

  _readState() {
    return this.store.readState();
  }

  _writeState(state) {
    return this.store.writeState(state);
  }

  getTasks() {
    return normalizeScheduledTasks(this._readState().scheduledTasks);
  }

  // ---- CRUD ----

  createTask(payload) {
    const state = this._readState();
    const task = createScheduledTaskRecord(payload);
    if (!task) throw Object.assign(new Error('计划参数无效。'), { status: 400, code: 'BAD_SCHEDULE' });
    state.scheduledTasks = [...state.scheduledTasks, task];
    if (state.scheduledTasks.length > SCHEDULED_TASK_LIMIT) {
      throw Object.assign(new Error(`最多可保留 ${SCHEDULED_TASK_LIMIT} 个计划。`), { status: 400, code: 'SCHEDULE_LIMIT_REACHED' });
    }
    this._writeState(state);
    return task;
  }

  updateTask(id, payload) {
    const state = this._readState();
    const index = state.scheduledTasks.findIndex(t => t.id === id);
    if (index === -1) throw Object.assign(new Error('这个计划不存在或已被删除。'), { status: 404, code: 'SCHEDULE_NOT_FOUND' });
    const task = createScheduledTaskRecord(payload, state.scheduledTasks[index]);
    state.scheduledTasks[index] = task;
    this._writeState(state);
    return task;
  }

  toggleTask(id, enabled) {
    const state = this._readState();
    const index = state.scheduledTasks.findIndex(t => t.id === id);
    if (index === -1) throw Object.assign(new Error('这个计划不存在或已被删除。'), { status: 404, code: 'SCHEDULE_NOT_FOUND' });
    state.scheduledTasks[index] = normalizeScheduledTask({
      ...state.scheduledTasks[index],
      enabled,
      updatedAt: new Date().toISOString(),
      nextRunAt: enabled
        ? nextScheduledRunAt({ ...state.scheduledTasks[index], nextRunAt: '' })
        : state.scheduledTasks[index].nextRunAt,
    });
    this._writeState(state);
    return state.scheduledTasks[index];
  }

  deleteTask(id) {
    const state = this._readState();
    const index = state.scheduledTasks.findIndex(t => t.id === id);
    if (index === -1) throw Object.assign(new Error('这个计划不存在或已被删除。'), { status: 404, code: 'SCHEDULE_NOT_FOUND' });
    state.scheduledTasks.splice(index, 1);
    this._writeState(state);
  }

  // ---- Execution ----

  _updateTaskState(taskId, updater) {
    const state = this._readState();
    const index = state.scheduledTasks.findIndex(t => t.id === taskId);
    if (index === -1) return null;
    const next = updater({ ...state.scheduledTasks[index] });
    if (!next) return null;
    state.scheduledTasks[index] = normalizeScheduledTask(next);
    this._writeState(state);
    return state.scheduledTasks[index];
  }

  async runTask(taskId, options = {}) {
    const id = String(taskId || '').trim();
    if (!id || this._runningTasks.has(id)) return null;
    this._runningTasks.add(id);
    const taskStartedAt = Date.now();
    const logRun = (status, errorText = '', detail = {}) => {
      if (!this.logExecution) return;
      try {
        this.logExecution('', 'schedule_execute', status, Date.now() - taskStartedAt, errorText, detail);
      } catch {}
    };
    try {
      const state = this._readState();
      const task = state.scheduledTasks.find(t => t.id === id);
      if (!task || !task.enabled) return null;
      const now = Date.now();
      if (!options.force && Date.parse(task.nextRunAt) > now) return null;

      // Check if thread is still running
      if (task.runMode === 'thread') {
        const runtime = this.codexAppServer.runtimeForThread(task.threadId);
        const loadedThread = runtime?.status === 'running' ? null : await this.codexAppServer.readThread(task.threadId, false);
        if (runtime?.status === 'running' || loadedThread?.status?.type === 'active') {
          logRun('skipped', '当前任务仍在运行，已跳过本次计划。', { taskId: id });
          return this._updateTaskState(id, current => ({
            ...current,
            updatedAt: new Date().toISOString(),
            nextRunAt: nextScheduledRunAt(current),
            lastStatus: 'skipped',
            lastMessage: '当前任务仍在运行，已跳过本次计划。',
          }));
        }
      }

      this._updateTaskState(id, current => ({
        ...current,
        updatedAt: new Date().toISOString(),
        lastStatus: 'running',
        lastMessage: '',
      }));

      const result = await this.codexAppServer.sendTurn({
        threadId: task.runMode === 'thread' ? task.threadId : '',
        cwd: task.cwd,
        text: task.prompt,
        clientUserMessageId: `schedule-${task.id}-${Date.now()}`,
      });

      logRun('completed', '', { taskId: id, threadId: result.threadId || '' });
      return this._updateTaskState(id, current => ({
        ...current,
        updatedAt: new Date().toISOString(),
        nextRunAt: nextScheduledRunAt(current),
        lastRunAt: new Date().toISOString(),
        lastStatus: 'started',
        lastMessage: '已提交给本机 Codex。',
        lastThreadId: result.threadId || current.lastThreadId || '',
        retryCount: 0,
      }));
    } catch (error) {
      const errorMsg = truncateText(error?.message || String(error), 500);
      const currentTask = this.getTasks().find(t => t.id === id);
      // The user can delete/disable a schedule while its asynchronous request is in flight.
      if (!currentTask || !currentTask.enabled) return null;
      const retryAttempt = (currentTask?.retryCount || 0);
      logRun('failed', errorMsg, { taskId: id, retryAttempt });

      // 检查是否应该重试
      if (shouldRetryTask(currentTask, retryAttempt)) {
        const delayMs = getRetryDelayForTask(currentTask, retryAttempt);
        const retryAt = new Date(Date.now() + delayMs).toISOString();
        this.logger?.warn?.('schedule_retry', { id, attempt: retryAttempt + 1, delayMs, error: errorMsg });
        return this._updateTaskState(id, current => ({
          ...current,
          updatedAt: new Date().toISOString(),
          nextRunAt: retryAt, // 重试时间
          lastRunAt: new Date().toISOString(),
          lastStatus: 'error',
          lastMessage: `第 ${retryAttempt + 1} 次失败：${errorMsg}，将在 ${Math.round(delayMs / 1000)}s 后重试。`,
          retryCount: retryAttempt + 1,
        }));
      }

      // 不再重试，标记为最终失败
      const isFinalRetry = retryAttempt > 0;
      return this._updateTaskState(id, current => ({
        ...current,
        updatedAt: new Date().toISOString(),
        nextRunAt: nextScheduledRunAt(current),
        lastRunAt: new Date().toISOString(),
        lastStatus: 'error',
        lastMessage: isFinalRetry ? `重试 ${retryAttempt} 次后仍失败：${errorMsg}` : errorMsg,
        retryCount: 0,
      }));
    } finally {
      this._runningTasks.delete(id);
    }
  }

  async runDueTasks() {
    const now = Date.now();
    const due = this.getTasks().filter(task => task.enabled && Date.parse(task.nextRunAt) <= now);
    for (const task of due) await this.runTask(task.id);
  }

  // ---- Lifecycle ----

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.runDueTasks().catch(error => this.logger.warn('[scheduler] 计划任务执行失败:', error.message || error));
    }, this.pollMs);
    if (this._timer.unref) this._timer.unref();
    this.runDueTasks().catch(error => this.logger.warn('[scheduler] 初始计划任务执行失败:', error.message || error));
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { Scheduler, normalizeScheduledTask, normalizeScheduledTasks, createScheduledTaskRecord, nextScheduledRunAt, getRetryDelayForTask, shouldRetryTask, SCHEDULED_TASK_LIMIT, RETRY_STRATEGIES };
