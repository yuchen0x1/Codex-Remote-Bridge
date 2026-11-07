'use strict';

/**
 * P2-2：受控文件下载回归测试
 * 通过隔离 HOME + 临时项目目录 + 真实 HTTP 调用验证：
 *  - 白名单目录内文件 200 且内容一致（repo 根目录 + 会话 projectPath 目录）
 *  - 路径穿越（../、绝对路径）403
 *  - 非白名单目录 403、缺失文件 404、超大文件 413、缺参数 400、未授权 401
 *  - 环境接口暴露 canDownload 能力
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const TOKEN = 'download-test-token';
const DOWNLOAD_LIMIT = 4096; // 测试用小上限，避免写大文件

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

test('P2-2: /codex/download 白名单、穿越防护、大小上限与鉴权', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-win-download-'));
  const sessionsDir = path.join(tmpRoot, '.codex', 'sessions');
  const projectDir = path.join(tmpRoot, 'projects', 'demo');
  const subDir = path.join(projectDir, 'src');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });

  const threadId = '123e4567-e89b-42d3-a456-426614174111';
  const appJsContent = 'console.log("hello download");\n';
  fs.writeFileSync(path.join(subDir, 'app.js'), appJsContent, 'utf8');
  const bigFile = path.join(projectDir, 'big.bin');
  fs.writeFileSync(bigFile, Buffer.alloc(DOWNLOAD_LIMIT * 2, 0x61)); // 超出测试上限 → 413

  // session_meta.cwd 让该目录进入 existingProjectCwds 白名单
  fs.writeFileSync(
    path.join(sessionsDir, `codex-${threadId}.jsonl`),
    `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd: path.normalize(projectDir) } })}\n`,
    'utf8'
  );

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
      CODEX_MAX_MAX_DOWNLOAD_BYTES: String(DOWNLOAD_LIMIT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderrRef = { value: '' };
  child.stderr.on('data', chunk => { stderrRef.value += String(chunk); });

  const repoRoot = path.resolve(__dirname, '..');
  const packageJsonContent = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');

  try {
    await waitForHealth(port, stderrRef);
    const headers = { 'x-mobile-typer-token': TOKEN };
    const baseUrl = `http://127.0.0.1:${port}`;
    const enc = encodeURIComponent;

    // 1) 未授权 401
    let res = await fetch(`${baseUrl}/codex/download?cwd=${enc(repoRoot)}&file=package.json`);
    assert.equal(res.status, 401, stderrRef.value.slice(-400));

    // 2) 缺参数 400
    res = await fetch(`${baseUrl}/codex/download?cwd=${enc(repoRoot)}`, { headers });
    assert.equal(res.status, 400);

    // 3) 白名单内（repo 根目录）200 且内容一致
    res = await fetch(`${baseUrl}/codex/download?cwd=${enc(repoRoot)}&file=package.json`, { headers });
    assert.equal(res.status, 200, stderrRef.value.slice(-400));
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="package\.json"/);
    assert.equal(await res.text(), packageJsonContent);

    // 4) 会话 projectPath 目录也在白名单内
    res = await fetch(`${baseUrl}/codex/download?cwd=${enc(path.normalize(projectDir))}&file=src/app.js`, { headers });
    assert.equal(res.status, 200, stderrRef.value.slice(-400));
    assert.equal(await res.text(), appJsContent);

    // 5) 路径穿越 ../ → 403
    res = await fetch(`${baseUrl}/codex/download?cwd=${enc(repoRoot)}&file=../server.js`, { headers });
    assert.equal(res.status, 403);

    // 6) 绝对路径 → 403
    res = await fetch(`${baseUrl}/codex/download?cwd=${enc(repoRoot)}&file=${enc(path.join(repoRoot, 'server.js'))}`, { headers });
    assert.equal(res.status, 403);

    // 7) 非白名单目录 → 403
    const outsideDir = path.join(tmpRoot, 'projects', 'other');
    fs.mkdirSync(outsideDir, { recursive: true });
    res = await fetch(`${baseUrl}/codex/download?cwd=${enc(outsideDir)}&file=readme.txt`, { headers });
    assert.equal(res.status, 403);

    // 8) 文件不存在 → 404
    res = await fetch(`${baseUrl}/codex/download?cwd=${enc(repoRoot)}&file=no-such-file.txt`, { headers });
    assert.equal(res.status, 404);

    // 9) 超大文件 → 413
    res = await fetch(`${baseUrl}/codex/download?cwd=${enc(path.normalize(projectDir))}&file=big.bin`, { headers });
    assert.equal(res.status, 413);

    // 10) 环境接口暴露 canDownload 与 downloadLimit
    res = await fetch(`${baseUrl}/codex/environment?cwd=${enc(repoRoot)}`, { headers });
    assert.equal(res.status, 200, stderrRef.value.slice(-400));
    const envBody = await res.json();
    assert.equal(envBody.ok, true);
    assert.equal(envBody.capabilities.canDownload, true);
    assert.equal(envBody.capabilities.downloadLimit, DOWNLOAD_LIMIT);
  } finally {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('P2-2: 源码层面存在受控下载实现', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('function handleFileDownload'), '受控下载处理器已定义');
  assert.ok(src.includes('function downloadSafeName'), '文件名清洗已定义');
  assert.ok(src.includes('MAX_DOWNLOAD_BYTES'), '大小上限常量已定义');
  assert.ok(src.includes('canDownload: Boolean(projects.length)'), '环境能力暴露 canDownload');
  assert.ok(src.includes('DOWNLOAD_FORBIDDEN'), '穿越/越权返回 403 语义');
  assert.ok(src.includes('DOWNLOAD_TOO_LARGE'), '超大文件返回 413 语义');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('data-env-action="download"'), '前端提供下载入口');
  assert.ok(html.includes('function downloadWorkspaceFile'), '前端下载处理函数已定义');
});
