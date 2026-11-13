'use strict';

/**
 * 安全模块 - 鉴权、token 管理、限流
 */

const crypto = require('crypto');

class Security {
  constructor(options = {}) {
    this.token = options.initialToken || '';
    this.appName = options.appName || 'Codex Remote Bridge';
    this.store = options.store || null;
    this.sessionManager = options.sessionManager || null;

    // ---- 限流：分档连续补充令牌桶 ----
    // 历史问题：整分钟重置（20 次用完后必须等满 60 秒）叠加默认 120 rpm，
    // 而前端自身轮询约 111 rpm，正常使用 20 秒即开始 429。
    // 现在按类别分档，各自独立补充；静态资源不参与限流。
    this.RATE_LIMIT_RPM = Math.max(10, Math.min(6000, Number(process.env.CODEX_MAX_RATE_LIMIT_RPM) || 600));
    this.RATE_LIMIT_WRITE_RPM = Math.max(6, Math.min(600, Number(process.env.CODEX_MAX_RATE_LIMIT_WRITE_RPM) || 90));
    this.RATE_LIMIT_ANON_RPM = Math.max(6, Math.min(600, Number(process.env.CODEX_MAX_RATE_LIMIT_ANON_RPM) || 60));
    this.RATE_LIMIT_BURST = Math.max(1, Math.min(200, Math.floor(this.RATE_LIMIT_RPM / 6) || 100));
    this.rateLimitBuckets = new Map();
    this.RATE_LIMIT_CLEANUP_INTERVAL = 60000;

    this._cleanupTimer = setInterval(() => this._cleanupRateLimit(), this.RATE_LIMIT_CLEANUP_INTERVAL);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  // ---- Token ----

  /**
   * 按请求特征归类限流档位。
   * static: 静态资源（页面/图标/manifest/Service Worker）不参与限流
   * write : 非 GET/HEAD/OPTIONS 的写操作
   * anon  : 未携带任何凭据的请求（防未授权探测）
   * api   : 其余已鉴权读操作
   */
  rateLimitClass(req, pathname = '', authorized = false) {
    const method = String(req?.method || 'GET').toUpperCase();
    const ext = String(pathname || '').toLowerCase();
    const isStaticAsset = !(
      ext.startsWith('/codex') ||
      ext === '/send' ||
      ext.startsWith('/send/') ||
      ext.startsWith('/upload')
    );
    if (ext !== '/' && ext !== '/index.html' && isStaticAsset && (method === 'GET' || method === 'HEAD')) return 'static';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return 'write';
    if (!authorized) return 'anon';
    return 'api';
  }

  getToken() {
    return this.token;
  }

  rotateToken() {
    this.token = crypto.randomBytes(12).toString('base64url');
    this.sessionManager?.revokeAll();
    if (this.store) {
      this.store.persistToken(this.token);
      this.store.syncLauncherToken(this.token);
    }
    return this.token;
  }

  /** Domain-separated HMAC: a shared read credential must never contain the master token. */
  readOnlyToken() {
    return this.token ? `ro_${crypto.createHmac('sha256', this.token).update('codex-remote-bridge:read-only:v1').digest('base64url')}` : '';
  }

  _tokenEquals(presented, expected) {
    if (!presented || !expected) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _presentedToken(req) {
    const fromHeader = req.headers['x-mobile-typer-token'];
    const fromCookie = this._parseCookies(req.headers.cookie || '').codexMiniToken;
    let fromQuery = '';
    try {
      const { URL } = require('url');
      fromQuery = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('token') || '';
    } catch {}
    return String(fromHeader || fromQuery || fromCookie || '');
  }

  /** 请求携带凭据的读写 scope：'read-only' | 'read-write'。会话优先，其次主/只读 token。 */
  tokenScopeFromRequest(req) {
    const session = this.sessionFromRequest(req);
    if (session) return session.scope === 'read-only' ? 'read-only' : 'read-write';
    return this._presentedToken(req) === this.readOnlyToken() ? 'read-only' : 'read-write';
  }

  // ---- Auth ----

  sessionTokenFromRequest(req) {
    if (!this.sessionManager) return '';
    const fromCookie = this._parseCookies(req.headers.cookie || '').codexMiniSession;
    const fromHeader = req.headers['x-codex-session'];
    return fromCookie || fromHeader || '';
  }

  sessionFromRequest(req) {
    return this.sessionManager ? this.sessionManager.validateSession(this.sessionTokenFromRequest(req)) : null;
  }

  isAuthorized(req) {
    if (this.sessionFromRequest(req)) return true;
    const presented = this._presentedToken(req);
    return this._tokenEquals(presented, this.token) || this._tokenEquals(presented, this.readOnlyToken());
  }

  _parseCookies(header) {
    const cookies = {};
    for (const part of String(header || '').split(';')) {
      const index = part.indexOf('=');
      if (index === -1) continue;
      const key = part.slice(0, index).trim();
      if (!key) continue;
      const value = part.slice(index + 1).trim();
      try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
    }
    return cookies;
  }

  // ---- Rate Limiting ----

  /** 各档位的每分钟配额与突发容量。 */
  _rateLimitPolicy(kind) {
    if (kind === 'static') return null; // 静态资源不限流
    const rpm = kind === 'write'
      ? this.RATE_LIMIT_WRITE_RPM
      : kind === 'anon'
        ? this.RATE_LIMIT_ANON_RPM
        : this.RATE_LIMIT_RPM;
    // 突发容量：约 1/6 分钟的额度，但不超过总配额
    const burst = Math.max(1, Math.min(rpm, kind === 'write' ? Math.max(10, Math.floor(rpm / 3)) : Math.floor(rpm / 6) || 10));
    return { rpm, burst, refillPerMs: rpm / 60000 };
  }

  /**
   * 连续补充令牌桶（不是整分钟重置）。
   * 每个 (档位 + IP) 与 (档位 + token) 各一个桶，任一维度耗尽即拒绝。
   *
   * @param {string} ip 客户端 IP
   * @param {string} [token] 鉴权 token（可选，命中则额外按 token 维度计数）
   * @param {string} [kind] 限流档位：'api' | 'write' | 'anon' | 'static'
   * @returns {{allowed: boolean, kind: string, limit: number, remaining: number, retryAfterSeconds: number}}
   */
  rateLimitCheck(ip, token = '', kind = 'api') {
    const policy = this._rateLimitPolicy(kind);
    if (!policy) {
      return { allowed: true, kind: 'static', limit: 0, remaining: 0, retryAfterSeconds: 0 };
    }
    // 无法确定来源的请求直接拒绝（保持历史行为）
    if (!ip) {
      return { allowed: false, kind, limit: policy.rpm, remaining: 0, retryAfterSeconds: 60 };
    }

    const keys = [`${kind}:${ip}`];
    if (token) keys.push(`${kind}:token:${token}`);
    const now = Date.now();

    // 先算出本次是否全部通过，避免部分扣减造成额度泄漏
    const snapshots = [];
    for (const key of keys) {
      let bucket = this.rateLimitBuckets.get(key);
      if (!bucket) {
        bucket = { tokens: policy.burst, updatedAt: now, limit: policy.burst, rpm: policy.rpm };
        this.rateLimitBuckets.set(key, bucket);
      } else {
        // 连续补充：按经过时间补齐，上限为突发容量
        const elapsed = Math.max(0, now - bucket.updatedAt);
        if (elapsed > 0) {
          bucket.tokens = Math.min(policy.burst, bucket.tokens + elapsed * policy.refillPerMs);
          bucket.updatedAt = now;
          bucket.limit = policy.burst;
          bucket.rpm = policy.rpm;
        }
      }
      snapshots.push(bucket);
    }

    const blocked = snapshots.find(bucket => bucket.tokens < 1);
    if (blocked) {
      const deficit = 1 - blocked.tokens;
      const retryAfterSeconds = Math.max(1, Math.ceil(deficit / policy.refillPerMs / 1000));
      const remaining = snapshots.reduce((min, bucket) => Math.min(min, Math.floor(bucket.tokens)), policy.burst);
      return { allowed: false, kind, limit: policy.rpm, remaining: Math.max(0, remaining), retryAfterSeconds };
    }

    for (const bucket of snapshots) bucket.tokens -= 1;
    const remaining = snapshots.reduce((min, bucket) => Math.min(min, Math.floor(bucket.tokens)), policy.burst);
    return { allowed: true, kind, limit: policy.rpm, remaining: Math.max(0, remaining), retryAfterSeconds: 0 };
  }

  _cleanupRateLimit() {
    const now = Date.now();
    // 连续补充桶：空闲超过 5 分钟且已补满的条目可安全淘汰
    for (const [key, bucket] of this.rateLimitBuckets) {
      if (now - bucket.updatedAt >= 5 * 60 * 1000) this.rateLimitBuckets.delete(key);
    }
  }

  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    if (this.sessionManager?.destroy) this.sessionManager.destroy();
    this.rateLimitBuckets.clear();
  }
}

module.exports = { Security };
