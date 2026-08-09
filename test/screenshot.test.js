'use strict';

/**
 * P2-4：CDP 屏幕截图预览回归测试
 * 通过隔离 HOME + 临时目录 + 真实 HTTP 调用验证：
 *  - 未授权 401
 *  - CDP 不可用（测试环境固定不可用端口）返回 503 且 available:false / CDP_UNAVAILABLE
 *  - 环境接口暴露 browser.screenshot 能力（available:false + maxAgeMs）
 *  - 源码层面存在截图处理器、路由、缓存与前端入口/降级文案
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const TOKEN = 'screenshot-test-token';

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

test('P2-4: /codex/screenshot 鉴权与 CDP 不可用降级', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-win-screenshot-'));
  const httpPort = await freePort();
  const unusedCdpPort = await freePort(); // 固定不可用端口，确保 CDP 降级路径

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      USERPROFILE: tmpRoot,
      HOME: tmpRoot,
      PORT: String(httpPort),
      HOST: '127.0.0.1',
      MOBILE_TYPER_TOKEN: TOKEN,
      CODEX_MAX_STATE_DIR: path.join(tmpRoot, '.codex-max'),
      CODEX_MAX_APP_SERVER: '0',
      CODEX_MAX_RATE_LIMIT_RPM: '6000',
      CODEX_MAX_CDP_PORT: String(unusedCdpPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderrRef = { value: '' };
  child.stderr.on('data', chunk => { stderrRef.value += String(chunk); });

  try {
    await waitForHealth(httpPort, stderrRef);
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    const headers = { 'x-mobile-typer-token': TOKEN };

    // 1) 未授权 401
    let res = await fetch(`${baseUrl}/codex/screenshot`);
    assert.equal(res.status, 401, stderrRef.value.slice(-400));

    // 2) CDP 不可用 → 503 降级
    res = await fetch(`${baseUrl}/codex/screenshot`, { headers });
    assert.equal(res.status, 503, stderrRef.value.slice(-400));
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.available, false);
    assert.equal(body.code, 'CDP_UNAVAILABLE');
    assert.ok(body.message, '降级文案存在');

    // 3) 环境接口暴露截图能力（不可用 + 缓存 TTL）
    res = await fetch(`${baseUrl}/codex/environment`, { headers });
    assert.equal(res.status, 200, stderrRef.value.slice(-400));
    const envBody = await res.json();
    assert.equal(envBody.ok, true);
    assert.equal(envBody.browser.screenshot.available, false);
    assert.ok(envBody.browser.screenshot.maxAgeMs >= 500, '截图缓存 TTL 已暴露');

    // 4) POST 方法不允许（只读接口）
    res = await fetch(`${baseUrl}/codex/screenshot`, { method: 'POST', headers });
    assert.equal(res.status, 405);
  } finally {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('P2-4: 源码层面存在截图预览实现与前端降级入口', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(src.includes('async function handleScreenshot'), '截图处理器已定义');
  assert.ok(src.includes("prefix: '/codex/screenshot'"), '截图路由已注册');
  assert.ok(src.includes('CDP_UNAVAILABLE'), 'CDP 不可用语义存在');
  assert.ok(src.includes('SCREENSHOT_CACHE_TTL_MS'), '截图缓存 TTL 常量存在');
  assert.ok(src.includes('X-Screenshot-Cache'), '缓存命中头存在');
  assert.ok(src.includes('screenshot: {' + '\n' + '        available: Boolean'), '环境能力暴露截图可用性');

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="environment-screenshot-refresh"'), '前端刷新截图按钮存在');
  assert.ok(html.includes('function refreshScreenshotPreview'), '前端截图处理函数已定义');
  assert.ok(html.includes('CDP 不可用，无法预览截图'), 'CDP 不可用降级文案存在');
  assert.ok(html.includes('.environment-screenshot-state.is-degraded'), '降级状态样式类存在');
});
