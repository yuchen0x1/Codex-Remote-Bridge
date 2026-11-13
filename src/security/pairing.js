'use strict';

/**
 * 动态配对码管理器
 *
 * 目标：新设备连接时不再让长期访问令牌出现在 URL / 二维码里。
 * - 电脑端生成 6 位一次性配对码（默认 90 秒有效）
 * - 新设备用 ?pair=<code> 访问，服务端校验通过后签发 HttpOnly 会话 Cookie
 * - 配对码兑换成功即作废（one-time），失败尝试受独立 IP 限流保护，防爆破
 */

const crypto = require('crypto');

const DEFAULT_PAIRING_TTL_MS = 90 * 1000;
const DEFAULT_MAX_PENDING_CODES = 8;
const DEFAULT_MAX_ATTEMPTS_PER_MINUTE = 10;
const ATTEMPT_WINDOW_MS = 60 * 1000;

function hashPairingCode(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

class PairingManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.ttlMs = Number(options.ttlMs) || DEFAULT_PAIRING_TTL_MS;
    this.maxPendingCodes = Number(options.maxPendingCodes) || DEFAULT_MAX_PENDING_CODES;
    this.maxAttemptsPerMinute = Number(options.maxAttemptsPerMinute) || DEFAULT_MAX_ATTEMPTS_PER_MINUTE;
    this.codes = new Map();      // codeHash -> { scope, expiresAt, createdAt }
    this.attempts = new Map();   // ip -> { count, resetAt }

    this.cleanupTimer = setInterval(() => this.cleanup(), 30 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** 生成 6 位一次性配对码，scope 继承发起方（只读会话不能签发读写配对码）。 */
  createPairingCode(scope = 'read-write') {
    const now = Date.now();
    while (this.codes.size >= this.maxPendingCodes) {
      let oldestKey = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, record] of this.codes) {
        const createdAt = Date.parse(record.createdAt) || 0;
        if (createdAt < oldestAt) {
          oldestAt = createdAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.codes.delete(oldestKey);
    }

    // 生成不与现存待兑换码冲突的 6 位数字码
    let code = '';
    let codeHash = '';
    do {
      code = String(100000 + crypto.randomBytes(4).readUInt32BE(0) % 900000);
      codeHash = hashPairingCode(code);
    } while (this.codes.has(codeHash));

    const record = {
      scope: scope === 'read-only' ? 'read-only' : 'read-write',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    this.codes.set(codeHash, record);
    return { code, expiresAt: record.expiresAt, scope: record.scope };
  }

  /** 兑换配对码：成功返回 scope 并立即作废；无效/过期返回 null。 */
  redeemPairingCode(code) {
    const normalized = String(code || '').trim();
    if (!/^\d{6}$/.test(normalized)) return null;
    const codeHash = hashPairingCode(normalized);
    const record = this.codes.get(codeHash);
    if (!record) return null;
    this.codes.delete(codeHash);
    if (Date.parse(record.expiresAt) <= Date.now()) return null;
    return record.scope;
  }

  /** 配对接口的独立 IP 限流（比全局限流更严格，防 6 位码爆破）。 */
  attemptAllowed(ip) {
    if (!ip) return false;
    const now = Date.now();
    let bucket = this.attempts.get(ip);
    if (!bucket || now - bucket.resetAt >= ATTEMPT_WINDOW_MS) {
      bucket = { count: 0, resetAt: now };
      this.attempts.set(ip, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.maxAttemptsPerMinute;
  }

  pendingCount() {
    return this.codes.size;
  }

  revokeAll() {
    this.codes.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, record] of this.codes) {
      if (Date.parse(record.expiresAt) <= now) this.codes.delete(key);
    }
    for (const [ip, bucket] of this.attempts) {
      if (now - bucket.resetAt >= ATTEMPT_WINDOW_MS * 2) this.attempts.delete(ip);
    }
  }

  destroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.codes.clear();
    this.attempts.clear();
  }
}

module.exports = { PairingManager };
