'use strict';

/**
 * 真实行为测试 - 对核心模块做行为级验证（不再只是字符串断言）
 * 覆盖：Router 分发、PersistentQueue 队列、Security 鉴权/限流、CronParser 解析
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const { Router } = require('../src/routes');
const { PersistentQueue } = require('../src/store/queue');
const { Security } = require('../src/security');
const { SessionManager } = require('../src/security/sessions');
const { CertificateManager } = require('../src/security/certs');
const { Store } = require('../src/store');
const { CronParser, isValidTimeZone } = require('../src/scheduler/cron');
const { getTokenFromRequest, corsHeaders } = require('../src/routes');

// ---- Mock HTTP 工具 ----

function mockReq({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress },
    on(event, cb) {
      if (event === 'error') return this;
      return this;
    },
    destroy() {},
  };
}

function mockRes() {
  const res = {
    headersSent: false,
    statusCode: 0,
    _headers: null,
    _body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res._headers = headers;
      res.headersSent = true;
      return res;
    },
    end(body) {
      res._body = body || '';
      return res;
    },
  };
  return res;
}

async function dispatchJson(router, req) {
  const res = mockRes();
  await router.dispatch(req, res);
  let parsed = null;
  try { parsed = JSON.parse(res._body); } catch {}
  return { status: res.statusCode, body: parsed, headers: res._headers };
}

function makeTestRouter(security) {
  const router = new Router({ security, logger: { warn() {}, error() {}, logRequest() {} } });
  router.prefix('GET', '/api/exact', (req, res) => json200(res, { ok: true, from: 'prefix' }));
  router.prefix('POST', '/api/post', (req, res) => json200(res, { ok: true, from: 'post' }));
  return router;
}

function json200(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

// ---- Router 行为 ----

test('Router: 前缀路由精确匹配并返回 JSON', async () => {
  const router = makeTestRouter(null);
  const { status, body } = await dispatchJson(router, mockReq({ url: '/api/exact?x=1' }));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.from, 'prefix');
});

test('Router: 未注册路径在 GET 下委托静态文件 / 否则返回 405', async () => {
  // POST 未注册路径 → 405
  const router = makeTestRouter(null);
  const { status } = await dispatchJson(router, mockReq({ method: 'POST', url: '/no-such-route' }));
  assert.equal(status, 405);
  // GET 未注册路径 → 委托 staticHandler（由 server.js 提供）
  let delegated = false;
  const router2 = makeTestRouter(null);
  router2.staticHandler = (req, res) => {
    delegated = true;
    json200(res, { ok: true, from: 'static' });
  };
  const getRes = await dispatchJson(router2, mockReq({ method: 'GET', url: '/no-such-route' }));
  assert.equal(getRes.status, 200);
  assert.equal(delegated, true, 'GET 应委托给 staticHandler');
});

test('Router: 限流命中返回 429，health 豁免', async () => {
  let remaining = 3;
  const fakeSecurity = {
    rateLimitCheck(ip) {
      if (remaining > 0) { remaining -= 1; return true; }
      return false;
    },
  };
  const router = makeTestRouter(fakeSecurity);
  // 前 3 次放行
  for (let i = 0; i < 3; i++) {
    const { status } = await dispatchJson(router, mockReq({ url: '/api/exact' }));
    assert.equal(status, 200);
  }
  // 第 4 次被限流
  const limited = await dispatchJson(router, mockReq({ url: '/api/exact' }));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  // health 豁免：即使无配额也放行
  let exhausted = false;
  const healthRouter = makeTestRouter({
    rateLimitCheck() { exhausted = true; return false; },
  });
  healthRouter.prefix('GET', '/codex/health', (req, res) => json200(res, { ok: true }));
  const health = await dispatchJson(healthRouter, mockReq({ url: '/codex/health' }));
  assert.equal(health.status, 200);
  assert.equal(exhausted, false, 'health 不应触发限流检查');
});

test('Router: 分发异常被捕获并返回 500 JSON', async () => {
  const router = makeTestRouter(null);
  router.prefix('GET', '/boom', () => { throw Object.assign(new Error('爆炸'), { status: 500 }); });
  const { status, body } = await dispatchJson(router, mockReq({ url: '/boom' }));
  assert.equal(status, 500);
  assert.equal(body.ok, false);
});

test('Router: 畸形 Host 返回 400 而不是抛异常', async () => {
  const router = makeTestRouter(null);
  const { status, body } = await dispatchJson(router, mockReq({ url: '/', headers: { host: '[' } }));
  assert.equal(status, 400);
  assert.equal(body.code, 'BAD_URL');
});

// ---- Security 行为 ----

test('Security: token 可从 header/query/cookie 三种渠道校验', () => {
  const security = new Security({ initialToken: 'secret-token' });
  assert.equal(security.isAuthorized(mockReq({ url: '/', headers: { 'x-mobile-typer-token': 'secret-token' } })), true);
  assert.equal(security.isAuthorized(mockReq({ url: '/?token=secret-token' })), true);
  assert.equal(security.isAuthorized(mockReq({ url: '/', headers: { cookie: 'codexMiniToken=secret-token' } })), true);
  assert.equal(security.isAuthorized(mockReq({ url: '/' })), false);
  assert.equal(security.isAuthorized(mockReq({ url: '/', headers: { 'x-mobile-typer-token': 'wrong' } })), false);
  security.destroy();
});

test('SessionManager: 创建短时会话、校验、撤销并输出 HttpOnly Cookie', () => {
  const manager = new SessionManager({ sessionTtlMs: 60 * 60 * 1000, cookieSecure: true });
  try {
    const created = manager.createSession(' 手机 ');
    assert.equal(created.session.deviceName, '手机');
    assert.ok(created.token.length >= 24);
    assert.equal(manager.validateSession(created.token).deviceName, '手机');
    assert.equal(manager.validateSession('wrong-token'), null);
    const cookie = manager.sessionCookie(created.token);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=\d+/);
    manager.revokeSession(created.token);
    assert.equal(manager.validateSession(created.token), null);
  } finally {
    manager.destroy();
  }
});

test('SessionManager: 过期会话被拒绝且超过上限时淘汰最旧会话', async () => {
  const manager = new SessionManager({ sessionTtlMs: 10, maxSessions: 2 });
  try {
    const expired = manager.createSession('过期');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(manager.validateSession(expired.token), null, '过期会话应失效');

    const first = manager.createSession('first');
    const second = manager.createSession('second');
    const third = manager.createSession('third');
    assert.equal(manager.validateSession(first.token), null, '超过上限应淘汰最旧会话');
    assert.ok(manager.validateSession(second.token), '较新会话应保留');
    assert.ok(manager.validateSession(third.token), '最新会话应保留');
  } finally {
    manager.destroy();
  }
});

test('Security: 短时会话可通过 Cookie 或 Header 鉴权', () => {
  const sessionManager = new SessionManager();
  const security = new Security({ initialToken: 'secret-token', sessionManager });
  try {
    const created = sessionManager.createSession('phone');
    const encoded = encodeURIComponent(created.token);
    assert.equal(security.isAuthorized(mockReq({ url: '/', headers: { cookie: `codexMiniSession=${encoded}` } })), true);
    assert.equal(security.isAuthorized(mockReq({ url: '/', headers: { 'x-codex-session': created.token } })), true);
    assert.equal(security.isAuthorized(mockReq({ url: '/', headers: { cookie: 'codexMiniSession=stale' } })), false);
    assert.equal(security.sessionFromRequest(mockReq({ url: '/', headers: { cookie: `codexMiniSession=${encoded}` } })).deviceName, 'phone');
  } finally {
    security.destroy();
  }
});

test('Security: 令牌桶限流按 IP 计数', () => {
  const security = new Security({ initialToken: 't' });
  try {
    // 默认 burst >= 10，连续打爆后必须限流
    const burst = security.RATE_LIMIT_BURST;
    for (let i = 0; i < burst; i++) {
      assert.equal(security.rateLimitCheck('1.2.3.4'), true, `第 ${i + 1} 次应放行`);
    }
    assert.equal(security.rateLimitCheck('1.2.3.4'), false, '超出 burst 后应限流');
    // 其他 IP 不受影响
    assert.equal(security.rateLimitCheck('5.6.7.8'), true);
  } finally {
    security.destroy();
  }
});

test('Security: rotateToken 生成新 token', () => {
  const security = new Security({ initialToken: 'old-token' });
  try {
    const next = security.rotateToken();
    assert.ok(next && next !== 'old-token' && next.length >= 16);
    assert.equal(security.getToken(), next);
  } finally {
    security.destroy();
  }
});

test('Security: 双维度限流 - token 维度独立计数', () => {
  const security = new Security({ initialToken: 't' });
  try {
    const burst = security.RATE_LIMIT_BURST;
    // 同一 IP 不同 token 各自独立计数
    for (let i = 0; i < burst; i++) {
      assert.equal(security.rateLimitCheck('1.1.1.1', 'token-a'), true);
    }
    // IP 维度已耗尽，即使换 token 也被拒绝（IP 维度优先）
    assert.equal(security.rateLimitCheck('1.1.1.1', 'token-b'), false);
    // 不同 IP + 同 token：IP 维度放行但 token 维度会累积
    const secondIp = new Security({ initialToken: 't' });
    try {
      for (let i = 0; i < burst; i++) {
        assert.equal(secondIp.rateLimitCheck('2.2.2.2', 'token-a'), true);
      }
      // token-a 维度已耗尽
      assert.equal(secondIp.rateLimitCheck('3.3.3.3', 'token-a'), false);
      // 不同 token 不受影响
      assert.equal(secondIp.rateLimitCheck('3.3.3.3', 'token-c'), true);
    } finally {
      secondIp.destroy();
    }
  } finally {
    security.destroy();
  }
});

test('Security: 无 IP 时拒绝限流', () => {
  const security = new Security({ initialToken: 't' });
  try {
    assert.equal(security.rateLimitCheck(''), false);
  } finally {
    security.destroy();
  }
});

test('Router: token 从 header / query 提取', () => {
  assert.equal(getTokenFromRequest(mockReq({ url: '/', headers: { 'x-mobile-typer-token': 'abc' } })), 'abc');
  assert.equal(getTokenFromRequest(mockReq({ url: '/?token=xyz' })), 'xyz');
  assert.equal(getTokenFromRequest(mockReq({ url: '/' })), '');
});

test('CORS: 同源 Origin 回显，跨站 Origin 不放行', () => {
  // 同源（Host 与 Origin 一致）：回显 Origin
  const sameOrigin = corsHeaders(mockReq({ url: '/codex/threads', headers: { host: '192.168.1.5:6280', origin: 'http://192.168.1.5:6280' } }));
  assert.equal(sameOrigin['access-control-allow-origin'], 'http://192.168.1.5:6280');
  // 回环地址放行
  const loopback = corsHeaders(mockReq({ url: '/', headers: { host: '192.168.1.5:6280', origin: 'http://localhost:6280' } }));
  assert.equal(loopback['access-control-allow-origin'], 'http://localhost:6280');
  // 恶意跨站 Origin 不放行
  const evil = corsHeaders(mockReq({ url: '/', headers: { host: '192.168.1.5:6280', origin: 'https://evil.example.com' } }));
  assert.equal(evil['access-control-allow-origin'], undefined);
  // 无 Origin（curl / 服务端）：保持 * 兼容
  const noOrigin = corsHeaders(mockReq({ url: '/' }));
  assert.equal(noOrigin['access-control-allow-origin'], '*');
  // 安全头始终存在
  assert.equal(sameOrigin['x-content-type-options'], 'nosniff');
  assert.equal(sameOrigin['referrer-policy'], 'no-referrer');
});

// ---- PersistentQueue 行为 ----

function makeTempQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-queue-'));
  const queue = new PersistentQueue({
    dbDir: dir,
    queueFile: path.join(dir, 'queue.json'),
    logFile: path.join(dir, 'log.json'),
    logger: { info() {}, warn() {} },
  });
  return { queue, dir };
}

test('PersistentQueue: enqueue/dequeue/complete 全流程', () => {
  const { queue, dir } = makeTempQueue();
  try {
    const entry = queue.enqueue('send', { text: '你好' }, 'thread-1');
    assert.ok(entry.id >= 1);
    assert.equal(entry.status, 'pending');

    const dequeued = queue.dequeue();
    assert.ok(dequeued);
    assert.equal(dequeued.id, entry.id);
    assert.equal(dequeued.status, 'running');
    assert.deepEqual(dequeued.payload, { text: '你好' });

    // 同一时间只有一条 running，再次 dequeue 应为 null（无其他 pending）
    assert.equal(queue.dequeue(), null);

    queue.complete(entry.id, { ok: true });
    const status = queue.getQueueStatus();
    assert.equal(status.completed, 1);
    assert.equal(status.total, 1);
  } finally {
    queue.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PersistentQueue: fail 会重试，超过 maxRetries 标记失败', () => {
  const { queue, dir } = makeTempQueue();
  try {
    const entry = queue.enqueue('git_push', {}, '');
    // 2 次失败后（retry_count 1 -> pending），第 3 次达到 maxRetries=3 → failed
    queue.fail(entry.id, '第一次失败', 3);
    assert.equal(queue.getQueueStatus().pending, 1);
    queue.dequeue();
    queue.fail(entry.id, '第二次失败', 3);
    assert.equal(queue.getQueueStatus().pending, 1);
    queue.dequeue();
    queue.fail(entry.id, '第三次失败', 3);
    assert.equal(queue.getQueueStatus().failed, 1);
    assert.equal(queue.getQueueStatus().pending, 0);
  } finally {
    queue.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PersistentQueue: logExecution 写入执行日志', () => {
  const { queue, dir } = makeTempQueue();
  try {
    queue.logExecution('thread-1', 'send', 'completed', 123, '', { transport: 'app-server' });
    queue.logExecution('thread-1', 'send', 'failed', 5, '超时', {});
    const logs = queue.getLogs(10);
    assert.equal(logs.length, 2);
    // 按时间倒序：最新一条在前；字段兼容 SQLite(snake_case) 与 JSON(camelCase) 两种模式
    const dur = log => log.duration_ms ?? log.durationMs;
    assert.equal(logs[0].status, 'failed');
    assert.equal(logs[0].action, 'send');
    assert.equal(dur(logs[0]), 5);
    assert.equal(logs[1].status, 'completed');
    assert.equal(dur(logs[1]), 123);

    const filtered = queue.getLogs(10, 'thread-1');
    assert.equal(filtered.length, 2);
    const other = queue.getLogs(10, 'thread-2');
    assert.equal(other.length, 0);
  } finally {
    queue.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PersistentQueue: JSON 回退模式可持久化（重启后数据仍在）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-queue-persist-'));
  const file = path.join(dir, 'queue.json');
  const logFile = path.join(dir, 'log.json');
  const logger = { info() {}, warn() {} };
  try {
    const q1 = new PersistentQueue({ dbDir: dir, queueFile: file, logFile, logger });
    q1.enqueue('send', { text: '持久化' }, 't1');
    q1.close();

    const q2 = new PersistentQueue({ dbDir: dir, queueFile: file, logFile, logger });
    const status = q2.getQueueStatus();
    assert.equal(status.total, 1);
    const item = q2.dequeue();
    assert.ok(item);
    assert.equal(item.payload.text, '持久化');
    q2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- CertificateManager 行为 ----

test('CertificateManager: 纯 Node 生成自签名证书并通过 TLS 握手', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-cert-'));
  const cm = new CertificateManager({
    certDir: dir,
    certFile: path.join(dir, 'cert.pem'),
    keyFile: path.join(dir, 'key.pem'),
  });
  try {
    const result = cm.generateSelfSigned('127.0.0.1');
    assert.equal(result.ok, true, result.error || '');
    const certPem = fs.readFileSync(result.certFile, 'utf8');
    assert.ok(certPem.includes('BEGIN CERTIFICATE'));

    // X509 解析验证：有效期与 SAN
    const x509 = new crypto.X509Certificate(certPem);
    const validTo = x509.validToDate instanceof Date ? x509.validToDate : new Date(x509.validTo);
    assert.ok(validTo.getTime() > Date.now(), '证书未过期');
    assert.ok(x509.checkHost('127.0.0.1'), 'SAN 应匹配 127.0.0.1');
    assert.ok(!x509.checkHost('evil.example.com'), '不应匹配未知域名');

    // 用该证书真实启动 HTTPS 服务器并完成受信任握手
    const server = https.createServer({ cert: certPem, key: fs.readFileSync(result.keyFile, 'utf8') }, (req, res) => res.end('ok'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const body = await new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port, ca: certPem, rejectUnauthorized: true }, res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(body, 'ok', '受信任 TLS 请求应成功');
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CertificateManager: 指纹生成与有效期校验', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-cert2-'));
  const cm = new CertificateManager({
    certDir: dir,
    certFile: path.join(dir, 'cert.pem'),
    keyFile: path.join(dir, 'key.pem'),
  });
  try {
    cm.generateSelfSigned('localhost');
    const fingerprint = cm.getCertFingerprint();
    assert.match(fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'SHA-256 指纹格式');
    assert.equal(cm.hasValidCert(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Store 行为（P5: webhook 配置持久化）----

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-store-'));
  const store = new Store({
    stateDir: dir,
    stateFile: path.join(dir, 'state.json'),
    tokenFile: path.join(dir, 'token.txt'),
  });
  return { store, dir };
}

test('Store: webhook 配置持久化（合法 URL 保存，非法拒绝）', () => {
  const { store, dir } = makeTempStore();
  try {
    // 默认空
    assert.equal(store.readState().webhook, '');
    // 保存合法 webhook
    const state = store.readState();
    state.webhook = 'https://example.com/hook?token=abc';
    store.writeState(state);
    assert.equal(store.readState().webhook, 'https://example.com/hook?token=abc');
    // 写入非法值（非 http）应被清空
    const bad = store.readState();
    bad.webhook = 'ftp://bad.com';
    store.writeState(bad);
    assert.equal(store.readState().webhook, '');
  } finally {
    store.invalidateCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Store: 持久化往返 - 重启后 webhook 与 scheduledTasks 仍在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-store2-'));
  const opts = { stateDir: dir, stateFile: path.join(dir, 'state.json'), tokenFile: path.join(dir, 'token.txt') };
  try {
    const s1 = new Store(opts);
    const state = s1.readState();
    state.webhook = 'http://192.168.1.5:9000/notify';
    s1.writeState(state);
    s1.invalidateCache();

    const s2 = new Store(opts);
    assert.equal(s2.readState().webhook, 'http://192.168.1.5:9000/notify');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Store: webhook SSRF 防护 - 环回/元数据/内网域名地址被拒绝', () => {
  const { store, dir } = makeTempStore();
  try {
    const forbidden = [
      'http://127.0.0.1:9000/hook',
      'http://localhost:9000/hook',
      'http://[::1]:9000/hook',
      'http://0.0.0.0/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.internal/hook',
    ];
    for (const url of forbidden) {
      const state = store.readState();
      state.webhook = url;
      store.writeState(state);
      assert.equal(store.readState().webhook, '', `环回/元数据地址应被清空: ${url}`);
    }
    // 局域网地址默认仍允许（测试用例沿用 192.168 段）
    const lanState = store.readState();
    lanState.webhook = 'http://192.168.1.5:9000/notify';
    store.writeState(lanState);
    assert.equal(store.readState().webhook, 'http://192.168.1.5:9000/notify');
  } finally {
    store.invalidateCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Store: 原子写入 - writeState 产生完整 JSON 且不留临时文件', () => {
  const { store, dir } = makeTempStore();
  try {
    const state = store.readState();
    state.webhook = 'https://example.com/hook';
    store.writeState(state);
    const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    assert.equal(JSON.parse(raw).webhook, 'https://example.com/hook');
    const leftovers = fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
    assert.equal(leftovers.length, 0, '临时文件应被清理');
  } finally {
    store.invalidateCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- CronParser 行为 ----

test('CronParser: 解析 5 字段表达式', () => {
  const parser = new CronParser('*/15 9-17 * * mon-fri');
  assert.ok(parser.isValid());
  assert.deepEqual([...parser.fields.minute], [0, 15, 30, 45]);
  assert.deepEqual([...parser.fields.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...parser.fields.dayOfWeek], [1, 2, 3, 4, 5]);
});

test('CronParser: 无效表达式抛出错误', () => {
  assert.throws(() => new CronParser('60 * * * *'), /超出范围/);
  assert.throws(() => new CronParser('* * * *'), /5 个字段/);
});

test('CronParser: nextRun 计算下一次触发时间', () => {
  const parser = new CronParser('0 9 * * *');
  const base = new Date('2026-08-02T08:00:00');
  const next = parser.nextRun(base);
  assert.ok(next, '应返回下一次触发时间');
  assert.equal(next.getHours(), 9);
  assert.ok(next.getTime() > base.getTime());
});

test('CronParser: describe 生成中文描述', () => {
  const parser = new CronParser('0 9 * * *');
  const desc = parser.describe();
  assert.ok(typeof desc === 'string' && desc.length > 0);
});

test('CronParser: timezone 参数按指定时区计算 nextRun', () => {
  // Asia/Shanghai = UTC+8（无夏令时）：上海 9:00 = UTC 01:00
  const shanghai = new CronParser('0 9 * * *', { timeZone: 'Asia/Shanghai' });
  const base = new Date('2026-08-02T00:00:00.000Z');
  const next = shanghai.nextRun(base);
  assert.ok(next, '应返回下一次触发时间');
  assert.equal(next.toISOString(), '2026-08-02T01:00:00.000Z');
});

test('CronParser: timezone 处理夏令时偏移时区', () => {
  // America/New_York 8 月为 EDT（UTC-4）：纽约 9:00 = UTC 13:00
  const newYork = new CronParser('0 9 * * *', { timeZone: 'America/New_York' });
  const base = new Date('2026-08-02T00:00:00.000Z');
  const next = newYork.nextRun(base);
  assert.ok(next, '应返回下一次触发时间');
  assert.equal(next.toISOString(), '2026-08-02T13:00:00.000Z');
});

test('CronParser: 非法时区被忽略而不是抛错', () => {
  const parser = new CronParser('0 9 * * *', { timeZone: 'Not/AZone' });
  assert.ok(parser.isValid());
  assert.equal(parser.timeZone, '');
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
});

test('Scheduler: normalizeScheduledTask 透传并校验 timezone', () => {
  const { normalizeScheduledTask } = require('../src/scheduler');
  const valid = normalizeScheduledTask({
    id: 'task-timezone-001',
    prompt: '每天 9 点汇报',
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    intervalMinutes: 60,
  });
  assert.equal(valid.scheduleMode, 'cron');
  assert.equal(valid.timezone, 'Asia/Shanghai');
  assert.ok(valid.cronDescription.includes('Asia/Shanghai'), 'cron 描述应包含时区');

  const invalid = normalizeScheduledTask({
    id: 'task-timezone-002',
    prompt: '每天 9 点汇报',
    cronExpression: '0 9 * * *',
    timezone: 'Not/AZone',
    intervalMinutes: 60,
  });
  assert.equal(invalid.timezone, '', '非法时区应被清空');
  assert.ok(!invalid.cronDescription.includes('Not/AZone'));
});

