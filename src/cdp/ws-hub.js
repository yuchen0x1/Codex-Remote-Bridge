'use strict';

/**
 * CDP 实时状态 WebSocket 端点
 * 为手机端提供 WebSocket 长连接，实时推送 CDP 状态变化和 Codex 会话事件
 */

const { getCdpConnection } = require('./connection');

// 简易 WebSocket 帧编解码（用于服务端→客户端推送，服务端不需要掩码）
function encodeWsFrameServer(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  payload.copy(frame, headerLength);
  return frame;
}

function decodeWsFrameClient(buffer) {
  if (buffer.length < 2) return null;
  const second = buffer[1];
  const masked = Boolean(second & 0x80);
  const opcode = buffer[0] & 0x0f;
  if (!masked || !(buffer[0] & 0x80) || (buffer[0] & 0x70) || ![1, 8, 9, 10].includes(opcode)) throw new Error('Invalid WebSocket frame');
  let length = second & 0x7f;
  let headerLength = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    headerLength = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    headerLength = 10;
  }
  if (!Number.isSafeInteger(length) || length > MAX_CLIENT_FRAME_BYTES || (opcode >= 8 && length > 125)) throw new Error('WebSocket frame too large');
  const maskOffset = headerLength;
  const payloadOffset = maskOffset + (masked ? 4 : 0);
  const frameEnd = payloadOffset + length;
  if (buffer.length < frameEnd) return null;
  let payload = buffer.subarray(payloadOffset, frameEnd);
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
    payload = unmasked;
  }
  return { text: payload.toString('utf8'), payload, opcode, consumed: frameEnd };
}

// 慢客户端背压阈值：写入缓冲超过该值时断开，防止内存无限增长（状态推送可容忍丢失，客户端会重连）
const MAX_BACKPRESSURE_BYTES = 512 * 1024;
const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

class CdpWebSocketHub {
  constructor(options = {}) {
    this.security = options.security;
    this.logger = options.logger || console;
    this.clients = new Set(); // Set<net.Socket>
    this.clientRequests = new Map();
    this.cdpConnection = null;
    this.lastStatus = null;
    this._lastStatusText = null;
    this._statusPollTimer = null;
    this._statusPollInterval = options.statusPollInterval || 5000;
  }

  // ---- 客户端管理 ----

  start() {
    // 连接到 CDP 并订阅状态变化
    this.cdpConnection = getCdpConnection();
    this.cdpConnection.onStatusChange(status => {
      this.lastStatus = status;
      if (this.clients.size) this.broadcast({ type: 'cdp_status', data: status });
    });
    // 只有存在客户端时才轮询，空闲时不产生后台开销
    this._ensurePolling();
  }

  stop() {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.clientRequests.clear();
    this._stopPollingIfIdle();
  }

  disconnectUnauthorized() {
    for (const socket of this.clients) {
      if (!this.security?.isAuthorized(this.clientRequests.get(socket))) {
        socket.destroy();
        this.clients.delete(socket);
        this.clientRequests.delete(socket);
      }
    }
    this._stopPollingIfIdle();
  }

  _ensurePolling() {
    if (this.clients.size === 0 || this._statusPollTimer) return;
    this._statusPollTimer = setInterval(() => {
      this._pollAndBroadcast().catch(() => {});
    }, this._statusPollInterval);
    if (this._statusPollTimer.unref) this._statusPollTimer.unref();
  }

  _stopPollingIfIdle() {
    if (this.clients.size === 0 && this._statusPollTimer) {
      clearInterval(this._statusPollTimer);
      this._statusPollTimer = null;
    }
  }

  async _pollAndBroadcast() {
    this.disconnectUnauthorized();
    if (!this.cdpConnection) return;
    const probe = await this.cdpConnection.probe();
    const status = { ...probe, polledAt: new Date().toISOString() };
    // 只在状态变化时广播（单次 stringify 比较，避免重复序列化）
    const statusText = JSON.stringify(status);
    if (statusText !== this._lastStatusText) {
      this._lastStatusText = statusText;
      this.lastStatus = status;
      this.broadcast({ type: 'cdp_status', data: status });
    }
  }

  // ---- 处理 WebSocket 升级 ----

  async handleUpgrade(req, socket, head) {
    // 鉴权
    if (!this.security?.isAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Browser cookies are accepted only from this exact origin. Native clients may omit Origin.
    const expectedOrigin = `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== expectedOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (this.clients.size >= 64) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }

    // WebSocket 握手
    const key = req.headers['sec-websocket-key'];
    if (!/^[A-Za-z0-9+/]{22}==$/.test(key || '') || req.headers['sec-websocket-version'] !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = require('crypto').createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n'));

    this._addClient(socket, req, head);

    // 发送当前状态
    if (this.lastStatus) {
      this._sendToClient(socket, { type: 'cdp_status', data: this.lastStatus });
    } else {
      // 立即拉取一次状态
      if (this.cdpConnection) {
        const probe = await this.cdpConnection.probe().catch(() => null);
        if (probe) {
          this.lastStatus = probe;
          this._sendToClient(socket, { type: 'cdp_status', data: probe });
        }
      }
    }
  }

  _addClient(socket, req, head) {
    this.clients.add(socket);
    this.clientRequests.set(socket, req);
    this._ensurePolling();
    let buffer = Buffer.alloc(0);

    socket.on('data', chunk => {
      if (!this.security.isAuthorized(req) || buffer.length + chunk.length > MAX_CLIENT_FRAME_BYTES + 14) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let frame;
        try { frame = decodeWsFrameClient(buffer); } catch { socket.destroy(); return; }
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (frame.opcode === 9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]));
          continue;
        }
        // 处理客户端消息（心跳 ping 等）
        try {
          const msg = JSON.parse(frame.text);
          if (msg.type === 'ping') {
            this._sendToClient(socket, { type: 'pong', timestamp: Date.now() });
          }
        } catch {}
      }
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      this.clientRequests.delete(socket);
      this._stopPollingIfIdle();
      this.logger.debug('ws_client_disconnected', { clients: this.clients.size });
    });

    socket.on('error', () => {
      this.clients.delete(socket);
      this.clientRequests.delete(socket);
      this._stopPollingIfIdle();
    });

    this.logger.debug('ws_client_connected', { clients: this.clients.size });
    if (head?.length) socket.emit('data', head);
  }

  _sendToClient(socket, message) {
    this.disconnectUnauthorized();
    if (socket.destroyed || !socket.writable) return;
    if (socket.writableLength > MAX_BACKPRESSURE_BYTES) {
      socket.destroy();
      this.clients.delete(socket);
      this.clientRequests.delete(socket);
      this._stopPollingIfIdle();
      return;
    }
    try {
      socket.write(encodeWsFrameServer(JSON.stringify(message)));
    } catch (error) {
      this.logger.debug('ws_send_failed', { error: error.message });
    }
  }

  broadcast(message) {
    this.disconnectUnauthorized();
    const frame = encodeWsFrameServer(JSON.stringify(message));
    for (const socket of this.clients) {
      if (socket.destroyed || !socket.writable) {
        this.clients.delete(socket);
        this.clientRequests.delete(socket);
        continue;
      }
      // 慢客户端背压保护：写入缓冲过大时断开，防止内存无限增长
      if (socket.writableLength > MAX_BACKPRESSURE_BYTES) {
        socket.destroy();
        this.clients.delete(socket);
        this.clientRequests.delete(socket);
        continue;
      }
      try { socket.write(frame); } catch { socket.destroy(); this.clients.delete(socket); this.clientRequests.delete(socket); }
    }
    this._stopPollingIfIdle();
  }

  getClientCount() {
    return this.clients.size;
  }
}

module.exports = { CdpWebSocketHub };
