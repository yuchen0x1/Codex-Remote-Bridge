'use strict';

/**
 * CDP 持久 WebSocket 连接管理器
 * 替代每次操作创建/关闭连接的模式，保持长连接并自动重连
 * 支持事件订阅，实时推送 CDP 状态变化
 */

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// ---- WebSocket 帧编解码 (从 win32.js 提取，共用) ----

function encodeWsFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const headerLength = payload.length < 126 ? 6 : payload.length <= 0xffff ? 8 : 14;
  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
    crypto.randomBytes(4).copy(frame, 2);
    for (let i = 0; i < payload.length; i += 1) frame[6 + i] = payload[i] ^ frame[2 + (i % 4)];
  } else if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
    crypto.randomBytes(4).copy(frame, 4);
    for (let i = 0; i < payload.length; i += 1) frame[8 + i] = payload[i] ^ frame[4 + (i % 4)];
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
    crypto.randomBytes(4).copy(frame, 10);
    for (let i = 0; i < payload.length; i += 1) frame[14 + i] = payload[i] ^ frame[10 + (i % 4)];
  }
  return frame;
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CDP WebSocket frame too large');
      length = Number(bigLength);
      headerLength = 10;
    }
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + (masked ? 4 : 0);
    const frameEnd = payloadOffset + length;
    if (buffer.length < frameEnd) break;
    let payload = buffer.subarray(payloadOffset, frameEnd);
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
      payload = unmasked;
    }
    frames.push({ opcode, text: payload.toString('utf8') });
    offset = frameEnd;
  }
  return { frames, rest: buffer.subarray(offset) };
}

// ---- HTTP helper ----

function httpJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`CDP HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body || 'null')); } catch { reject(new Error('CDP returned invalid JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('CDP HTTP timed out')));
    request.on('error', reject);
  });
}

// ---- CDP 持久连接管理器 ----

const DEFAULT_PORT = Number(process.env.CODEX_MAX_CDP_PORT || process.env.CODEX_MINI_CDP_PORT || 9222);
const DEFAULT_HOST = process.env.CODEX_MAX_CDP_HOST || process.env.CODEX_MINI_CDP_HOST || '127.0.0.1';
const DEFAULT_TIMEOUT = Number(process.env.CODEX_MAX_CDP_TIMEOUT_MS || process.env.CODEX_MINI_CDP_TIMEOUT_MS || 4500);
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;
const IDLE_PING_INTERVAL_MS = 25000;

// ---- Codex 客户端版本探测 ----

/** 从 CDP 页面标题/URL 中提取 Codex 客户端版本（如 "Codex 3.10.2"）；找不到返回 null */
function extractCodexVersion(identity) {
  if (!identity) return null;
  const match = identity.match(/Codex[^0-9]*v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** 与本仓库自动化所适配的已知大版本比较，不匹配时给出降级提示 */
const KNOWN_COMPAT_MAJOR = 3;

function versionCompatHint(version) {
  const major = Number(String(version).split('.')[0]);
  if (!Number.isFinite(major)) return null;
  if (major !== KNOWN_COMPAT_MAJOR) {
    console.warn(`[CDP] Codex 客户端版本 ${version} 与自动化适配的主版本 ${KNOWN_COMPAT_MAJOR} 不匹配，界面自动化可能降级或失效。`);
    return 'unsupported-major';
  }
  return 'ok';
}

class CdpConnection {
  constructor(options = {}) {
    this.host = options.host || DEFAULT_HOST;
    this.port = options.port || DEFAULT_PORT;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT;
    this.baseUrl = `http://${this.host}:${this.port}`;

    // 连接状态
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.targetWsUrl = null;

    // 命令追踪
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);

    // 事件监听
    this.eventListeners = new Map(); // method -> Set<callback>
    this.statusListeners = new Set();

    // 重连
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.shouldReconnect = false;

    // 心跳
    this.pingTimer = null;
  }

  // ---- 事件订阅 ----

  on(method, callback) {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, new Set());
    this.eventListeners.get(method).add(callback);
    return () => this.eventListeners.get(method)?.delete(callback);
  }

  onStatusChange(callback) {
    this.statusListeners.add(callback);
    callback(this.getStatus());
    return () => this.statusListeners.delete(callback);
  }

  _emitStatusChange() {
    const status = this.getStatus();
    for (const cb of this.statusListeners) {
      try { cb(status); } catch {}
    }
  }

  // ---- 状态查询 ----

  getStatus() {
    return {
      connected: this.connected,
      host: this.host,
      port: this.port,
      targetWsUrl: this.targetWsUrl,
      reconnectAttempts: this.reconnectAttempts,
      pendingCommands: this.pending.size,
    };
  }

  async probe() {
    try {
      const targets = await httpJson(`${this.baseUrl}/json/list`, Math.min(this.timeoutMs, 2500));
      const rows = Array.isArray(targets) ? targets : [];
      const target = rows.find(item => item.type === 'page' && /^app:\/\/-\/index\.html/.test(String(item.url || ''))) ||
        rows.find(item => item.type === 'page' && String(item.title || '').toLowerCase().includes('codex')) ||
        rows.find(item => item.type === 'page');
      const version = extractCodexVersion(target ? String(target.title || '') + ' ' + String(target.url || '') : '');
      return {
        available: Boolean(target && target.webSocketDebuggerUrl),
        port: this.port,
        version,
        compatHint: version ? versionCompatHint(version) : null,
        target: target ? { url: target.url, title: target.title, wsUrl: target.webSocketDebuggerUrl } : null,
      };
    } catch (error) {
      return { available: false, port: this.port, code: error.code || 'CDP_UNAVAILABLE', message: error.message };
    }
  }

  // ---- 连接管理 ----

  async connect() {
    if (this.connected) return this;
    if (this.connecting) {
      // 等待正在进行的连接
      while (this.connecting) await new Promise(resolve => setTimeout(resolve, 50));
      return this;
    }

    this.connecting = true;
    this.shouldReconnect = true;

    try {
      const probe = await this.probe();
      if (!probe.available) {
        throw new Error('CDP 不可用，请确保 Codex Desktop 以 --remote-debugging-port 启动');
      }
      this.targetWsUrl = probe.target.wsUrl;
      await this._wsConnect(this.targetWsUrl);
      this.reconnectAttempts = 0;
      this.connected = true;
      this._startPing();
      this._emitStatusChange();
      return this;
    } catch (error) {
      this.connecting = false;
      this._scheduleReconnect();
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  _wsConnect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const port = Number(url.port || 80);
      this.socket = net.createConnection({ host: url.hostname, port });
      this.socket.setNoDelay(true);

      const key = crypto.randomBytes(16).toString('base64');
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('CDP WebSocket handshake timed out'));
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('error', onError);
        this.socket.off('data', onData);
      };

      const onError = error => {
        cleanup();
        reject(error);
      };

      const onData = chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = this.buffer.subarray(0, headerEnd).toString('utf8');
        if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
          cleanup();
          reject(new Error(`CDP WebSocket handshake failed: ${header.split('\r\n')[0]}`));
          return;
        }
        this.buffer = this.buffer.subarray(headerEnd + 4);
        cleanup();
        resolve();
      };

      this.socket.on('error', onError);
      this.socket.on('data', onData);
      this.socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });

    // 注册持久 data/close/error 处理器（在 resolve 之后）
  }

  _attachSocketHandlers() {
    this.socket.on('data', chunk => this._handleData(chunk));
    this.socket.on('error', error => this._handleError(error));
    this.socket.on('close', () => this._handleClose());

    // 处理握手后剩余的缓冲区
    if (this.buffer.length) {
      const existing = this.buffer;
      this.buffer = Buffer.alloc(0);
      this._handleData(existing);
    }
  }

  _handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let decoded;
    try {
      decoded = decodeWsFrames(this.buffer);
    } catch (error) {
      this._failAll(error);
      this.disconnect();
      return;
    }
    this.buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) { this.disconnect(); return; }
      if (frame.opcode !== 0x1) continue;
      let message;
      try { message = JSON.parse(frame.text); } catch { continue; }

      // 命令响应
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(message.error.message || 'CDP command failed'));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }

      // 事件推送
      if (message.method) {
        const listeners = this.eventListeners.get(message.method);
        if (listeners) {
          for (const cb of listeners) {
            try { cb(message.params, message.method); } catch {}
          }
        }
        // 通配符监听
        const wildcardListeners = this.eventListeners.get('*');
        if (wildcardListeners) {
          for (const cb of wildcardListeners) {
            try { cb(message.params, message.method); } catch {}
          }
        }
      }
    }
  }

  _handleError(error) {
    this._failAll(error);
  }

  _handleClose() {
    this._failAll(new Error('CDP WebSocket closed'));
    this.connected = false;
    this._stopPing();
    this._emitStatusChange();
    if (this.shouldReconnect) this._scheduleReconnect();
  }

  _failAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(1.5, this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      try {
        await this.connect();
      } catch {
        // 连接失败，会在 connect 内部调度下一次重连
      }
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      // 发送一个轻量级命令作为心跳
      this.send('Runtime.evaluate', { expression: '1' }, 5000).catch(() => {});
    }, IDLE_PING_INTERVAL_MS);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  _stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  // ---- 命令发送 ----

  send(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('CDP WebSocket is not connected'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeWsFrame(payload), error => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  // ---- 便捷方法 ----

  async evaluate(expression, timeout = this.timeoutMs) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeout);
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'CDP JS evaluation failed';
      throw new Error(text);
    }
    return result.result ? result.result.value : undefined;
  }

  async dispatchMouseClick(rect) {
    const x = Number(rect?.x) + (Number(rect?.w) / 2);
    const y = Number(rect?.y) + (Number(rect?.h) / 2);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('CDP 鼠标点击坐标无效');
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  // ---- 断开 ----

  disconnect() {
    this.shouldReconnect = false;
    this._stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._failAll(new Error('CDP connection closed by client'));
    this.connected = false;
    if (this.socket) {
      try { this.socket.end(); } catch {}
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }
    this._emitStatusChange();
  }

  // 确保 connect 完成后注册持久处理器
  async ensureConnected() {
    if (this.connected) return this;
    await this.connect();
    // 连接成功后注册持久 data/close/error 处理器
    if (this.socket && this.connected) {
      this._attachSocketHandlers();
    }
    return this;
  }
}

// 修改 _wsConnect 在 resolve 前注册持久处理器
// 覆盖原型方法以正确注册处理器
const originalConnect = CdpConnection.prototype.connect;
CdpConnection.prototype.connect = async function() {
  const result = await originalConnect.call(this);
  if (this.socket && this.connected) {
    // 移除握手阶段的临时监听器
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    // 注册持久处理器
    this._attachSocketHandlers();
  }
  return result;
};

// ---- 单例管理 ----

let _connection = null;

function getCdpConnection(options = {}) {
  if (!_connection) {
    _connection = new CdpConnection(options);
  }
  return _connection;
}

module.exports = { CdpConnection, getCdpConnection };
