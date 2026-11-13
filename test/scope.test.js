'use strict';

/**
 * P2-3：token 只读/读写 scope 回归测试
 *  - 单元：Security 派生只读 token、鉴权兼容、scope 判定、会话 scope 透传
 *  - HTTP：只读 token 可读（GET）不可写（POST 一律 403 TOKEN_READ_ONLY）
 *  - 会话：用只读 token 加载页面得到的短时会话同样为只读（防升级）
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Security } = require('../src/security');
const { SessionManager } = require('../src/security/sessions');

const TOKEN = 'scope-test-token-0123456789';

function mockReq(url = '/', headers = {}) {
  return { url, headers };
}

test('P2-3: Security 派生只读 token 并正确判定 scope', () => {
  const security = new Security({ initialToken: TOKEN });
  try {
    assert.ok(!security.readOnlyToken().includes(TOKEN), '只读凭据不得包含主令牌');
    assert.equal(security.isAuthorized(mockReq('/x', { 'x-mobile-typer-token': `${TOKEN}:ro` })), false, '拒绝旧的不安全格式');
    const ro = security.readOnlyToken();

    // 三种携带渠道下主 token 与只读 token 都能鉴权
    assert.equal(security.isAuthorized(mockReq('/x', { 'x-mobile-typer-token': TOKEN })), true);
    assert.equal(security.isAuthorized(mockReq('/x', { 'x-mobile-typer-token': ro })), true);
    assert.equal(security.isAuthorized(mockReq(`/x?token=${encodeURIComponent(ro)}`)), true);
    assert.equal(security.isAuthorized(mockReq('/x', { cookie: `codexMiniToken=${encodeURIComponent(ro)}` })), true);
    assert.equal(security.isAuthorized(mockReq('/x', { 'x-mobile-typer-token': 'wrong' })), false);

    // scope 判定
    assert.equal(security.tokenScopeFromRequest(mockReq('/x', { 'x-mobile-typer-token': TOKEN })), 'read-write');
    assert.equal(security.tokenScopeFromRequest(mockReq('/x', { 'x-mobile-typer-token': ro })), 'read-only');
    assert.equal(security.tokenScopeFromRequest(mockReq('/x')), 'read-write'); // 未鉴权不误伤
  } finally {
    security.destroy();
  }
});

test('P2-3: 会话 scope 透传（只读会话不升级）', () => {
  const logger = { info() {}, warn() {}, error() {}, logRequest() {} };
  const sessionManager = new SessionManager({ logger, sessionTtlMs: 60000 });
  const security = new Security({ initialToken: TOKEN, sessionManager });
  try {
    const roCreated = sessionManager.createSession('ro-device', { scope: 'read-only' });
    const rwCreated = sessionManager.createSession('rw-device');
    assert.equal(roCreated.session.scope, 'read-only');
    assert.equal(rwCreated.session.scope, 'read-write');

    const roCookie = `codexMiniSession=${encodeURIComponent(roCreated.token)}`;
    const rwCookie = `codexMiniSession=${encodeURIComponent(rwCreated.token)}`;
    assert.equal(security.tokenScopeFromRequest(mockReq('/x', { cookie: roCookie })), 'read-only');
    assert.equal(security.tokenScopeFromRequest(mockReq('/x', { cookie: rwCookie })), 'read-write');
  } finally {
    security.destroy();
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function waitForHealth(port, stderrRef) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/codex/health`);
      if (res.ok) return;
    } catch { /* server not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become healthy; stderr: ${String(stderrRef.value || '').slice(-500)}`);
}

test('P2-3: HTTP 集成 - 只读 token 可读不可写，会话同规则', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-win-scope-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      USERPROFILE: tmpRoot,
      HOME: tmpRoot,
      PORT: String(port),
      HOST: '127.0.0.1',
      CODEX_MAX_HTTP_ONLY: '1',
      MOBILE_TYPER_TOKEN: TOKEN,
      CODEX_MAX_STATE_DIR: path.join(tmpRoot, '.codex-max'),
      CODEX_MAX_APP_SERVER: '0',
      CODEX_MAX_RATE_LIMIT_RPM: '6000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderrRef = { value: '' };
  child.stderr.on('data', chunk => { stderrRef.value += String(chunk); });

  const tokenIssuer = new Security({ initialToken: TOKEN });
  const ro = tokenIssuer.readOnlyToken();
  tokenIssuer.destroy();
  const roHeaders = { 'x-mobile-typer-token': ro };
  const rwHeaders = { 'x-mobile-typer-token': TOKEN };

  try {
    await waitForHealth(port, stderrRef);
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1) 读接口对只读 token 放行
    let res = await fetch(`${baseUrl}/codex/threads`, { headers: roHeaders });
    assert.equal(res.status, 200, stderrRef.value.slice(-400));
    res = await fetch(`${baseUrl}/codex/environment`, { headers: roHeaders });
    assert.equal(res.status, 200);

    // 2) 写接口对只读 token 一律 403
    for (const [method, url, body] of [
      ['POST', '/send', JSON.stringify({ text: 'hi' })],
      ['POST', '/codex/approval', JSON.stringify({ decision: 'allow', id: 'x' })],
      ['POST', '/codex/select', JSON.stringify({ threadId: 'x' })],
      ['POST', '/codex/new-thread', JSON.stringify({})],
      ['POST', '/codex/thread-action', JSON.stringify({})],
      ['POST', '/codex/stop', null],
      ['POST', '/codex/model-switch', JSON.stringify({ model: 'x' })],
      ['POST', '/codex/reasoning-mode', JSON.stringify({})],
      ['POST', '/codex/git-action', JSON.stringify({ action: 'status' })],
      ['POST', '/codex/rotate-token', null],
      ['POST', '/codex/keep-awake', null],
      ['POST', '/codex/webhook', JSON.stringify({ url: 'https://example.com/hook' })],
    ]) {
      res = await fetch(`${baseUrl}${url}`, { method, headers: { ...roHeaders, 'content-type': 'application/json' }, body });
      assert.equal(res.status, 403, `${method} ${url} 应对只读 token 返回 403`);
      const bodyJson = await res.json().catch(() => ({}));
      assert.equal(bodyJson.code, 'TOKEN_READ_ONLY', `${method} ${url} 应返回 TOKEN_READ_ONLY`);
    }

    // 3) 主 token 写接口不受影响（未授权 401 而非 403）
    res = await fetch(`${baseUrl}/codex/stop`, { method: 'POST', headers: rwHeaders });
    assert.notEqual(res.status, 403, '主 token 写接口不应被只读拦截');

    // 4) /codex/config 暴露 scope
    res = await fetch(`${baseUrl}/codex/config`, { headers: roHeaders });
    assert.equal(res.status, 200);
    let config = await res.json();
    assert.equal(config.scope, 'read-only');
    res = await fetch(`${baseUrl}/codex/config`, { headers: rwHeaders });
    config = await res.json();
    assert.equal(config.scope, 'read-write');

    // 5) 只读 token 加载页面得到的会话也是只读（不能借会话升级）
    res = await fetch(`${baseUrl}/`, { headers: roHeaders });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/codexMiniSession=([^;]+)/);
    assert.ok(match, '页面加载应下发会话 cookie');
    const sessionToken = decodeURIComponent(match[1]);
    const sessionHeaders = { cookie: `codexMiniSession=${encodeURIComponent(sessionToken)}` };
    res = await fetch(`${baseUrl}/codex/threads`, { headers: sessionHeaders });
    assert.equal(res.status, 200, '只读会话可读');
    res = await fetch(`${baseUrl}/send`, { method: 'POST', headers: { ...sessionHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    assert.equal(res.status, 403, '只读会话写操作应被拒绝');

    // Cookie-only polling must receive authenticated quotas (not the 60 rpm anonymous quota).
    for (let i = 0; i < 15; i++) {
      res = await fetch(`${baseUrl}/codex/prompts`, { headers: sessionHeaders });
      assert.equal(res.status, 200, '正常会话轮询不应触发匿名限流');
    }
    res = await fetch(`${baseUrl}/codex/sessions`, { headers: sessionHeaders });
    assert.equal(res.status, 403, '只读设备不得列举其他设备');

    res = await fetch(`${baseUrl}/codex/pairing-code?scope=read-write`, { headers: sessionHeaders });
    assert.equal((await res.json()).scope, 'read-only', '只读设备不能签发读写权限');
    res = await fetch(`${baseUrl}/codex/pairing-code?scope=read-only`, { headers: rwHeaders });
    const pair = await res.json();
    assert.equal(pair.scope, 'read-only');
    res = await fetch(`${baseUrl}/codex/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code }) });
    assert.equal((await res.json()).scope, 'read-only');

    res = await fetch(`${baseUrl}/codex/sessions`, { headers: rwHeaders });
    const devices = await res.json();
    assert.ok(devices.sessions.length > 0);
    assert.ok(!JSON.stringify(devices).includes(sessionToken), '设备列表不泄露凭据');
    assert.ok(devices.sessions.every(item => !item.tokenHash && item.id));
    const device = devices.sessions.find(item => item.scope === 'read-only');
    res = await fetch(`${baseUrl}/codex/sessions`, { method: 'POST', headers: { ...rwHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ id: device.id }) });
    assert.equal((await res.json()).revoked, true);
    res = await fetch(`${baseUrl}/codex/sessions`, { headers: rwHeaders });
    assert.ok(!(await res.json()).sessions.some(item => item.id === device.id));

    res = await fetch(`${baseUrl}/`, { headers: rwHeaders });
    const adminCookie = res.headers.get('set-cookie').match(/codexMiniSession=([^;]+)/)[1];
    res = await fetch(`${baseUrl}/codex/pairing-code`, { headers: rwHeaders });
    const pendingPair = await res.json();
    res = await fetch(`${baseUrl}/codex/rotate-token`, { method: 'POST', headers: rwHeaders });
    const rotated = await res.json();
    assert.equal(rotated.ok, true);
    for (const headers of [rwHeaders, roHeaders, sessionHeaders, { cookie: `codexMiniSession=${adminCookie}` }]) {
      res = await fetch(`${baseUrl}/codex/prompts`, { headers });
      assert.equal(res.status, 401, '轮换必须撤销所有旧凭据');
    }
    res = await fetch(`${baseUrl}/codex/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pendingPair.code }) });
    assert.equal(res.status, 401, '轮换作废尚未兑换的配对码');
    res = await fetch(`${baseUrl}/codex/prompts`, { headers: { 'x-mobile-typer-token': rotated.token } });
    assert.equal(res.status, 200);
  } finally {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('P2-3: 源码层面写操作统一拦截', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'index.js'), 'utf8');
  assert.ok(routes.includes('tokenScopeFromRequest'), 'Router 调用 scope 判定');
  assert.ok(routes.includes('TOKEN_READ_ONLY'), 'Router 返回只读拒绝码');
  const securitySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'security', 'index.js'), 'utf8');
  assert.ok(securitySrc.includes('readOnlyToken()'), 'Security 派生只读 token');
  assert.ok(securitySrc.includes('tokenScopeFromRequest(req)'), 'Security 提供 scope 判定');
  const sessionsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'security', 'sessions.js'), 'utf8');
  assert.ok(sessionsSrc.includes("scope: record.scope || 'read-write'"), '会话携带 scope');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSrc.includes('scope: security.tokenScopeFromRequest(req)'), '会话创建继承请求 scope');
  assert.ok(serverSrc.includes('scope: security.tokenScopeFromRequest(req),'), '/codex/config 暴露 scope');
});
