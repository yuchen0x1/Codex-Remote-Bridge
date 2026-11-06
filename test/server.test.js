'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('Rate limiting is handled by the Security module and Router', () => {
  const security = require('fs').readFileSync('./src/security/index.js', 'utf8');
  assert.ok(security.includes('rateLimitCheck'), 'Security rateLimitCheck method defined');
  assert.ok(security.includes('RATE_LIMIT'), 'Rate limit constants defined in Security');
  const routes = require('fs').readFileSync('./src/routes/index.js', 'utf8');
  assert.ok(routes.includes('json(res, 429'), 'Router returns 429 status code for rate limiting');
  assert.ok(routes.includes('/codex/health'), 'Router excludes health endpoint from rate limit');
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('/codex/health'), 'Health endpoint defined in server');
});

test('Static file serving uses safe path resolution', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('PUBLIC_DIR'), 'PUBLIC_DIR constant defined');
});

test('Authorization checks token from header, query, and cookie', () => {
  const security = require('fs').readFileSync('./src/security/index.js', 'utf8');
  assert.ok(security.includes('x-mobile-typer-token'), 'Header-based token auth');
  assert.ok(security.includes('searchParams.get'), 'Query parameter token auth');
  assert.ok(security.includes('codexMiniToken'), 'Cookie-based token auth');
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('security.isAuthorized(req)'), 'Server delegates auth to Security module');
});

test('Cross-origin API requests retain token header compatibility', () => {
  const html = require('fs').readFileSync('./public/index.html', 'utf8');
  assert.ok(html.includes("headers['x-mobile-typer-token'] = token"), 'cross-origin fetches send the legacy auth header');
  assert.ok(html.includes("delete headers['x-mobile-typer-token']"), 'same-origin fetches prefer the HttpOnly session');
});

test('All required route handlers are defined', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  const routes = [
    '/codex/health', '/codex/threads', '/codex/archived',
    '/codex/history', '/codex/status', '/codex/config',
    '/codex/approvals', '/codex/select', '/codex/new-thread',
    '/codex/stop', '/codex/model-switch', '/codex/reasoning-mode',
    '/codex/keep-awake', '/codex/environment', '/codex/git-action',
    '/codex/cdp-launch', '/codex/pull-requests', '/codex/plugins',
    '/codex/schedules', '/codex/thread-action',
    '/send', '/codex/attachment',
    '/codex/download', '/codex/rotate-token',
    '/codex/export', '/codex/prompts', '/codex/search',
  ];
  for (const route of routes) {
    assert.ok(src.includes(route), 'Route ' + route + ' is defined');
  }
});

test('Phase 1: Markdown export and prompt library handlers are defined', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('function buildMarkdownExport'), 'buildMarkdownExport defined');
  assert.ok(src.includes('function handleExport'), 'handleExport defined');
  assert.ok(src.includes('function handlePromptLibrary'), 'handlePromptLibrary defined');
  assert.ok(src.includes('function normalizePromptLibrary'), 'normalizePromptLibrary defined');
  assert.ok(src.includes('MAX_PROMPT_LIBRARY_ITEMS'), 'prompt library capacity constant defined');
  assert.ok(src.includes('Content-Disposition'), 'export response uses attachment disposition');
  assert.ok(src.includes('text/markdown'), 'export response uses markdown content type');
  assert.ok(src.includes("action === 'create'"), 'prompt library supports create');
  assert.ok(src.includes("action === 'delete'"), 'prompt library supports delete');
});

test('Phase 1: Mobile UI includes voice input, TTS, export, and prompt library', () => {
  const html = require('fs').readFileSync('./public/index.html', 'utf8');
  assert.ok(html.includes('id="voice-input"'), 'voice input button');
  assert.ok(html.includes('startVoiceDictation'), 'voice dictation logic');
  assert.ok(html.includes('speakText'), 'TTS speak helper');
  assert.ok(html.includes('voiceReadEnabled'), 'auto-read reply toggle');
  assert.ok(html.includes('thread-action-export'), 'export thread action button');
  assert.ok(html.includes('exportCurrentThread'), 'export thread logic');
  assert.ok(html.includes('id="prompt-badge"'), 'prompt library badge');
  assert.ok(html.includes('id="prompt-library-panel"'), 'prompt library panel');
  assert.ok(html.includes('loadPromptLibrary'), 'prompt library loader');
  assert.ok(html.includes('promptLibraryCreated') === false, 'notice key mismatch guard');
});

test('Phase A1: full-text search endpoint, helpers, and mobile UI wiring are defined', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('function handleSearch'), 'handleSearch defined');
  assert.ok(src.includes('function searchCodexSessions'), 'searchCodexSessions defined');
  assert.ok(src.includes('function searchableTextFromItem'), 'searchable text extractor defined');
  assert.ok(src.includes('CODEX_SEARCH_TAIL_BYTES'), 'search tail byte budget constant defined');
  assert.ok(src.includes('CODEX_SEARCH_MAX_FILES'), 'search max files constant defined');
  assert.ok(src.includes('CODEX_SEARCH_MAX_RESULTS'), 'search result cap constant defined');
  assert.ok(src.includes("code: 'BAD_QUERY'"), 'short query rejected with 400');
  assert.ok(src.includes("code: 'CODEX_SEARCH_FAILED'"), 'search failure mapped to 500');
  const html = require('fs').readFileSync('./public/index.html', 'utf8');
  assert.ok(html.includes('id="thread-search"'), 'thread search input exists');
  assert.ok(html.includes('runThreadContentSearch'), 'frontend content search logic defined');
  assert.ok(html.includes('scheduleThreadSearch'), 'frontend search debounce scheduling defined');
  assert.ok(html.includes('appendSearchResultOption'), 'frontend search result renderer defined');
  assert.ok(html.includes("label.textContent = '对话内容'"), 'frontend content search section label');
});

test('Rate limit cleanup prevents memory leak', () => {
  const security = require('fs').readFileSync('./src/security/index.js', 'utf8');
  assert.ok(security.includes('RATE_LIMIT_CLEANUP_INTERVAL'), 'Cleanup interval defined');
  assert.ok(security.includes('rateLimitBuckets.delete'), 'Stale bucket cleanup');
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('router.dispatch'), 'Server delegates routing to Router');
});

test('Platform module handles win32 and darwin', () => {
  const idx = require('fs').readFileSync('./src/platform/index.js', 'utf8');
  assert.ok(idx.includes('win32'), 'win32 platform supported');
  assert.ok(idx.includes('darwin'), 'darwin platform supported');
  assert.ok(idx.includes('UNSUPPORTED_PLATFORM'), 'Other platforms raise error');
});

test('Attachment abuse prevention constants exist', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('MAX_ATTACHMENTS'), 'Max attachments');
  assert.ok(src.includes('MAX_ATTACHMENT_BYTES'), 'Max attachment bytes');
  assert.ok(src.includes('HISTORY_ATTACHMENT_TTL_MS'), 'Attachment TTL');
});

test('CORS headers set on OPTIONS preflight', () => {
  const routes = require('fs').readFileSync('./src/routes/index.js', 'utf8');
  assert.ok(routes.includes('access-control-allow-origin'), 'CORS header');
  assert.ok(routes.includes('access-control-allow-private-network'), 'Private network allowed');
  assert.ok(routes.includes('x-content-type-options'), 'nosniff header');
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('OPTIONS'), 'OPTIONS handled');
  assert.ok(src.includes('corsHeaders(req)'), 'CORS computed per-request');
});

test('Process exit handlers clean up resources', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('SIGINT'), 'SIGINT handled');
  assert.ok(src.includes('SIGTERM'), 'SIGTERM handled');
  assert.ok(src.includes('cleanupKeepAwake'), 'Keep awake cleanup');
});

test('Feature: System overview, control, git diff, and mdns broadcaster are registered', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('/codex/system/overview'), 'System overview endpoint registered');
  assert.ok(src.includes('/codex/system/control'), 'System control endpoint registered');
  assert.ok(src.includes('/codex/git/diff'), 'Git diff endpoint registered');
  assert.ok(src.includes('MdnsBroadcaster'), 'mDNS broadcaster integrated');

  const html = require('fs').readFileSync('./public/index.html', 'utf8');
  assert.ok(html.includes('quick-chips-bar'), 'Quick chips prompt bar exists');
  assert.ok(html.includes('tool-call-card'), 'Tool call accordion component exists');
  assert.ok(html.includes('code-block-wrapper'), 'Code block copy and diff wrapper exists');
  assert.ok(html.includes('system-health'), 'System health workspace tab exists');
  assert.ok(html.includes('workspace-diff'), 'Workspace diff tab exists');
});

test('Security: one-time pairing code flow replaces token-in-URL for new devices', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('/codex/pairing-code'), 'Pairing code endpoint registered');
  assert.ok(src.includes('/codex/pair'), 'Pair redeem endpoint registered');
  assert.ok(src.includes('PairingManager'), 'PairingManager integrated');

  const pairing = require('fs').readFileSync('./src/security/pairing.js', 'utf8');
  assert.ok(pairing.includes('attemptAllowed'), 'Per-IP brute force guard exists');
  assert.ok(pairing.includes("replace(/^\\\\d{6}$/") || pairing.includes("test(normalized)"), '6-digit code validation exists');

  const html = require('fs').readFileSync('./public/index.html', 'utf8');
  assert.ok(html.includes(".get('pair')"), 'Front-end detects ?pair= param');
  assert.ok(html.includes('/codex/pair'), 'Front-end redeems pairing code');
  assert.ok(html.includes('pairing-code'), 'Front-end requests pairing code for QR');
});

test('Phase 3: /codex/status uses incremental tail parsing', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes("require('./src/store/tail-reader')"), 'TailReader required');
  assert.ok(src.includes('new TailReader('), 'TailReader instantiated');
  assert.ok(src.includes('statusTailReader.read(file)'), 'status parse reads via incremental tail cache');
  assert.ok(src.includes('tailRead.items'), 'status parse reuses cached parsed items');
  const tail = require('fs').readFileSync('./src/store/tail-reader.js', 'utf8');
  assert.ok(tail.includes('class TailReader'), 'TailReader class defined');
  assert.ok(tail.includes('_canAppend'), 'append detection guard exists');
  assert.ok(tail.includes('edgeBytes'), 'seam integrity check exists');
});

test('Phase 3: thread list TTL raised to 3s', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('CODEX_SESSION_FILE_CACHE_MS = 3000'), 'thread list TTL 3s');
});

test('Phase 3: request latency P50/P95 exposed in /codex/stats', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('const LATENCY_SAMPLE_LIMIT = 512'), 'latency sample window defined');
  assert.ok(src.includes('function recordLatency'), 'latency recorder defined');
  assert.ok(src.includes('function latencySummary'), 'latency summary defined');
  assert.ok(src.includes("res.on('finish'"), 'per-request timing hook attached');
  assert.ok(src.includes('latency: latencySummary()'), 'stats response includes latency summary');
  assert.ok(src.includes('p50Ms'), 'P50 computed');
  assert.ok(src.includes('p95Ms'), 'P95 computed');
});

test('Phase 3: /codex/status parses a real session file with since (functional regression)', async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const net = require('node:net');

  // 隔离的 HOME：CODEX_SESSIONS_DIR = ~/.codex/sessions 指向临时目录，绝不触碰真实会话
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-win-status-'));
  const sessionsDir = path.join(tmpRoot, '.codex', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const base = Date.parse('2026-08-04T10:00:00.000Z');
  const sessionLines = [
    JSON.stringify({ timestamp: new Date(base).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-regression-1', cwd: tmpRoot } }),
    JSON.stringify({ timestamp: new Date(base + 1000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '你好，回归测试' }] } }),
    JSON.stringify({ timestamp: new Date(base + 2000).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
  ];
  fs.writeFileSync(path.join(sessionsDir, 'regression-session.jsonl'), sessionLines.join('\n') + '\n');

  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    probe.on('error', reject);
  });

  const env = {
    ...process.env,
    USERPROFILE: tmpRoot,
    HOME: tmpRoot,
    PORT: String(port),
    HOST: '127.0.0.1',
    MOBILE_TYPER_TOKEN: 'regression-token',
    CODEX_MAX_STATE_DIR: path.join(tmpRoot, '.codex-max'),
  };
  const child = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  try {
    let healthy = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/codex/health`);
        if (res.ok) { healthy = true; break; }
      } catch { /* server not up yet */ }
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(healthy, `server should start within 15s; stderr: ${stderr.slice(-500)}`);

    const headers = { 'x-mobile-typer-token': 'regression-token' };
    const since = encodeURIComponent(new Date(base - 1000).toISOString());
    const url = `http://127.0.0.1:${port}/codex/status?session=regression-session.jsonl&since=${since}`;

    const res = await fetch(url, { headers });
    assert.equal(res.status, 200, `status should not 500 (ReferenceError regression); stderr: ${stderr.slice(-500)}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.available, true);
    assert.equal(body.status, 'complete', 'task_complete marker should yield complete status');
    assert.ok(String(body.final || '').includes('你好'), 'assistant final message should surface');

    // 第二次请求走增量缓存，仍返回一致结果（无 ReferenceError、无 500）
    const res2 = await fetch(url, { headers });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.status, 'complete');
    assert.equal(body2.final, body.final);
  } finally {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Front-end persists query token for reload recovery', () => {
  const html = require('fs').readFileSync('./public/index.html', 'utf8');
  assert.ok(html.includes("localStorage.setItem('codexMini.token', queryToken)"), 'query token should be persisted');
  assert.equal(html.includes("localStorage.removeItem('codexMini.token')"), false, 'query token should not be deleted');
});

test('Request body limit covers the max attachment payload', () => {
  const src = require('fs').readFileSync('./server.js', 'utf8');
  assert.ok(src.includes('DEFAULT_MAX_BODY_BYTES'), 'default body limit is derived from attachment limits');
});

test('Malformed percent path and Host do not crash the server', async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const net = require('node:net');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-win-robust-'));
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    probe.on('error', reject);
  });
  const env = {
    ...process.env,
    USERPROFILE: tmpRoot,
    HOME: tmpRoot,
    PORT: String(port),
    HOST: '127.0.0.1',
    MOBILE_TYPER_TOKEN: 'robust-token',
    CODEX_MAX_STATE_DIR: path.join(tmpRoot, '.codex-max'),
  };
  const child = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  try {
    let healthy = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/codex/health`);
        if (res.ok) { healthy = true; break; }
      } catch { /* server not up yet */ }
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(healthy, `server should start within 15s; stderr: ${stderr.slice(-500)}`);

    const badPath = await fetch(`http://127.0.0.1:${port}/%ZZ`);
    assert.equal(badPath.status, 400, `malformed percent path should return 400; stderr: ${stderr.slice(-500)}`);

    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', chunk => { data += String(chunk); });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
      setTimeout(() => { try { socket.destroy(); } catch {} resolve(data); }, 3000);
    });
    assert.match(raw, /^HTTP\/1\.1 400/, 'malformed Host should return 400 instead of crashing');

    assert.equal(child.exitCode, null, 'server process should stay alive');
    const health = await fetch(`http://127.0.0.1:${port}/codex/health`);
    assert.equal(health.status, 200, 'server should still answer health after malformed requests');
  } finally {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
