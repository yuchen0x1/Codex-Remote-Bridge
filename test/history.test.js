'use strict';

/**
 * P2-1：历史读取单遍扫描回归测试
 * 通过隔离 HOME + 临时会话文件 + 真实 HTTP 调用验证：
 *  - 会话文件消息解析（用户/助手、label、timestamp）
 *  - limit 截断语义（只返回最近 N 条）
 *  - 损坏行跳过
 *  - 源码层面：旧的 count 预扫描（双重 JSON.parse）已移除
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const TOKEN = 'history-test-token';

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

function buildTurn(index, base) {
  const lines = [];
  lines.push(JSON.stringify({
    timestamp: new Date(base + index * 4000).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: `turn-${index}` },
  }));
  lines.push(JSON.stringify({
    timestamp: new Date(base + index * 4000 + 500).toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message: `请求 ${index}` },
  }));
  lines.push(JSON.stringify({
    timestamp: new Date(base + index * 4000 + 1000).toISOString(),
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `回复 ${index}` }] },
  }));
  lines.push(JSON.stringify({
    timestamp: new Date(base + index * 4000 + 2000).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_complete' },
  }));
  return lines;
}

test('P2-1: /codex/history 单遍扫描回归（解析、limit、损坏行）', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-win-history-'));
  const sessionsDir = path.join(tmpRoot, '.codex', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const threadId = '123e4567-e89b-42d3-a456-426614174000';
  const base = Date.parse('2026-08-05T08:00:00.000Z');

  const sessionLines = [
    'this is not json',
    '{"broken":',
    ...buildTurn(1, base),
    ...buildTurn(2, base),
  ];
  fs.writeFileSync(path.join(sessionsDir, `codex-${threadId}.jsonl`), sessionLines.join('\n') + '\n');

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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderrRef = { value: '' };
  child.stderr.on('data', chunk => { stderrRef.value += String(chunk); });

  try {
    await waitForHealth(port, stderrRef);
    const headers = { 'x-mobile-typer-token': TOKEN };
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1) 基本解析：损坏行被跳过，按序返回用户/助手消息，label 带处理耗时
    let res = await fetch(`${baseUrl}/codex/history?thread=${threadId}&limit=120`, { headers });
    assert.equal(res.status, 200, stderrRef.value.slice(-400));
    let body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.available, true);
    assert.equal(body.transport, 'session-files');
    assert.equal(body.messages.length, 4);
    assert.deepEqual(body.messages.map(row => row.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(body.messages[0].text, '请求 1');
    assert.equal(body.messages[1].text, '回复 1');
    assert.match(body.messages[1].label, /^Codex · 已处理/);
    assert.equal(body.messages[3].text, '回复 2');

    // 2) limit 截断：只返回最近 N 条（滚动窗口语义 = 旧实现的 slice(-N)）
    res = await fetch(`${baseUrl}/codex/history?thread=${threadId}&limit=2`, { headers });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages.map(row => row.role), ['user', 'assistant']);
    assert.equal(body.messages[0].text, '请求 2');
    assert.equal(body.messages[1].text, '回复 2');

    // 3) 非法 threadId 与未授权
    res = await fetch(`${baseUrl}/codex/history?thread=not-a-thread&limit=10`, { headers });
    assert.equal(res.status, 400);
    res = await fetch(`${baseUrl}/codex/history?thread=${threadId}&limit=10`);
    assert.equal(res.status, 401);
  } finally {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('P2-1: 源码层面消除双重 JSON.parse（count 预扫描已移除）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('function scanCodexThreadHistoryLines'), '单遍扫描器已定义');
  assert.ok(src.includes('function readHistoryTailLines'), '自适应读取已定义');
  assert.ok(src.includes('scanCodexThreadHistoryLines(historyTail.lines'), 'parse 直接复用扫描结果');
  assert.ok(!src.includes('function countCodexHistoryMessages'), '旧的 count 预扫描已删除');
  assert.ok(!src.includes('function readHistoryLinesAdaptive'), '旧的 adaptive 读取已删除');
  assert.ok(!src.includes('readHistoryLinesAdaptive('), 'parse 不再调用旧 adaptive 读取');
});
