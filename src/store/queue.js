'use strict';

/**
 * SQLite 持久化队列 - 操作队列、执行日志、任务历史的持久化存储
 * 零依赖实现（使用 Node.js 内置的文件系统模拟 SQLite 行为，避免原生编译）
 * 如果安装了 better-sqlite3 则自动使用，否则回退到 JSON 文件存储
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_DIR = path.join(os.homedir(), '.codex-max', 'db');
const MAX_LOG_ENTRIES = 5000;
const MAX_QUEUE_SIZE = 1000;

// 尝试加载 better-sqlite3（可选依赖）
let Database = null;
try { Database = require('better-sqlite3'); } catch {}

class PersistentQueue {
  constructor(options = {}) {
    this.dbDir = options.dbDir || DB_DIR;
    this.queueFile = options.queueFile || path.join(this.dbDir, 'operation-queue.json');
    this.logFile = options.logFile || path.join(this.dbDir, 'execution-log.json');
    this.logger = options.logger || console;

    this._queue = [];
    this._logs = [];
    this._nextId = 1; // JSON 回退模式下自增 ID 游标（避免每次 enqueue 全量扫描取最大值）
    this._useSqlite = false;

    if (Database) {
      this._initSqlite();
    } else {
      this._initJsonStore();
    }
  }

  // ---- 初始化 ----

  _initSqlite() {
    try {
      const dbPath = path.join(this.dbDir, 'codex-max.db');
      fs.mkdirSync(this.dbDir, { recursive: true });
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS operation_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          error TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_queue_status ON operation_queue(status);
        CREATE INDEX IF NOT EXISTS idx_queue_thread ON operation_queue(thread_id);

        CREATE TABLE IF NOT EXISTS execution_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          duration_ms INTEGER,
          error TEXT,
          detail TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_log_thread ON execution_log(thread_id);
        CREATE INDEX IF NOT EXISTS idx_log_created ON execution_log(created_at);
      `);

      this._useSqlite = true;
      this.logger.info('sqlite_initialized', { path: dbPath });
    } catch (error) {
      this.logger.warn('sqlite_init_failed', { error: error.message });
      this._initJsonStore();
    }
  }

  _initJsonStore() {
    fs.mkdirSync(this.dbDir, { recursive: true });
    // 加载队列
    try {
      this._queue = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
      if (!Array.isArray(this._queue)) this._queue = [];
    } catch { this._queue = []; }
    for (const entry of this._queue) {
      const id = Number(entry?.id);
      if (Number.isFinite(id) && id >= this._nextId) this._nextId = id + 1;
    }
    // 加载日志
    try {
      this._logs = JSON.parse(fs.readFileSync(this.logFile, 'utf8'));
      if (!Array.isArray(this._logs)) this._logs = [];
    } catch { this._logs = []; }
    this.logger.info('json_store_initialized', { queueSize: this._queue.length, logSize: this._logs.length });
  }

  _persistJson() {
    try {
      fs.writeFileSync(this.queueFile, JSON.stringify(this._queue.slice(-MAX_QUEUE_SIZE)), 'utf8');
      fs.writeFileSync(this.logFile, JSON.stringify(this._logs.slice(-MAX_LOG_ENTRIES)), 'utf8');
    } catch (error) {
      this.logger.warn('json_persist_failed', { error: error.message });
    }
  }

  // ---- 队列操作 ----

  enqueue(action, payload = {}, threadId = '') {
    const now = new Date().toISOString();
    const item = { threadId, action, payload, status: 'pending', createdAt: now, retryCount: 0 };

    if (this._useSqlite) {
      const stmt = this.db.prepare('INSERT INTO operation_queue (thread_id, action, payload, status, created_at) VALUES (?, ?, ?, ?, ?)');
      const result = stmt.run(threadId, action, JSON.stringify(payload), 'pending', now);
      return { id: result.lastInsertRowid, ...item };
    }

    const id = this._nextId++;
    const entry = { id, ...item };
    this._queue.push(entry);
    if (this._queue.length > MAX_QUEUE_SIZE) {
      this._queue = this._queue.slice(-MAX_QUEUE_SIZE);
      // 游标无需回退：ID 只要求单调递增、不要求紧凑
    }
    this._persistJson();
    return entry;
  }

  dequeue() {
    if (this._useSqlite) {
      const getStmt = this.db.prepare("SELECT * FROM operation_queue WHERE status = 'pending' ORDER BY id LIMIT 1");
      const updateStmt = this.db.prepare("UPDATE operation_queue SET status = 'running', started_at = ? WHERE id = ?");
      const row = getStmt.get();
      if (!row) return null;
      updateStmt.run(new Date().toISOString(), row.id);
      return { id: row.id, threadId: row.thread_id, action: row.action, payload: JSON.parse(row.payload), status: 'running', createdAt: row.created_at, startedAt: row.started_at, retryCount: row.retry_count };
    }

    const item = this._queue.find(q => q.status === 'pending');
    if (!item) return null;
    item.status = 'running';
    item.startedAt = new Date().toISOString();
    this._persistJson();
    return item;
  }

  complete(id, result = {}) {
    const now = new Date().toISOString();
    if (this._useSqlite) {
      this.db.prepare("UPDATE operation_queue SET status = 'completed', completed_at = ?, error = ? WHERE id = ?")
        .run(now, result.error || '', id);
    } else {
      const item = this._queue.find(q => q.id === id);
      if (item) { item.status = 'completed'; item.completedAt = now; item.error = result.error || ''; }
      this._persistJson();
    }
    this.logExecution('', 'queue_item', 'completed', 0, result.error || '', result);
  }

  fail(id, error, maxRetries = 3) {
    const now = new Date().toISOString();
    if (this._useSqlite) {
      const item = this.db.prepare('SELECT * FROM operation_queue WHERE id = ?').get(id);
      if (!item) return;
      const retryCount = (item.retry_count || 0) + 1;
      if (retryCount < maxRetries) {
        this.db.prepare("UPDATE operation_queue SET status = 'pending', retry_count = ?, error = ? WHERE id = ?")
          .run(retryCount, error, id);
      } else {
        this.db.prepare("UPDATE operation_queue SET status = 'failed', completed_at = ?, error = ? WHERE id = ?")
          .run(now, error, id);
      }
    } else {
      const item = this._queue.find(q => q.id === id);
      if (!item) return;
      item.retryCount = (item.retryCount || 0) + 1;
      item.error = error;
      if (item.retryCount < maxRetries) {
        item.status = 'pending';
      } else {
        item.status = 'failed';
        item.completedAt = now;
      }
      this._persistJson();
    }
    this.logExecution('', 'queue_item', 'failed', 0, error, { id });
  }

  getQueueStatus() {
    if (this._useSqlite) {
      const counts = this.db.prepare(`
        SELECT status, COUNT(*) as count FROM operation_queue GROUP BY status
      `).all();
      const result = { pending: 0, running: 0, completed: 0, failed: 0, total: 0 };
      for (const row of counts) {
        result[row.status] = row.count;
        result.total += row.count;
      }
      return result;
    }
    const result = { pending: 0, running: 0, completed: 0, failed: 0, total: this._queue.length };
    for (const item of this._queue) {
      if (result[item.status] !== undefined) result[item.status]++;
    }
    return result;
  }

  clearCompleted() {
    if (this._useSqlite) {
      this.db.prepare("DELETE FROM operation_queue WHERE status IN ('completed', 'failed')").run();
    } else {
      this._queue = this._queue.filter(q => q.status === 'pending' || q.status === 'running');
      this._persistJson();
    }
  }

  // ---- 执行日志 ----

  logExecution(threadId, action, status, durationMs = 0, error = '', detail = {}) {
    const now = new Date().toISOString();
    if (this._useSqlite) {
      this.db.prepare(`
        INSERT INTO execution_log (thread_id, action, status, duration_ms, error, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(threadId, action, status, durationMs, error, JSON.stringify(detail), now);
      // 清理旧日志
      this.db.prepare('DELETE FROM execution_log WHERE id NOT IN (SELECT id FROM execution_log ORDER BY id DESC LIMIT ?)').run(MAX_LOG_ENTRIES);
    } else {
      this._logs.push({ threadId, action, status, durationMs, error, detail, createdAt: now });
      if (this._logs.length > MAX_LOG_ENTRIES) this._logs = this._logs.slice(-MAX_LOG_ENTRIES);
      this._persistJson();
    }
  }

  getLogs(limit = 100, threadId = '') {
    if (this._useSqlite) {
      if (threadId) {
        return this.db.prepare('SELECT * FROM execution_log WHERE thread_id = ? ORDER BY id DESC LIMIT ?').all(threadId, limit);
      }
      return this.db.prepare('SELECT * FROM execution_log ORDER BY id DESC LIMIT ?').all(limit);
    }
    let logs = threadId ? this._logs.filter(l => l.threadId === threadId) : this._logs;
    return logs.slice(-limit).reverse();
  }

  // ---- 清理 ----

  close() {
    if (this._useSqlite && this.db) {
      try { this.db.close(); } catch {}
    }
  }
}

module.exports = { PersistentQueue };
