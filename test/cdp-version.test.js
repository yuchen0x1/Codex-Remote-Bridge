'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { CdpConnection } = require('../src/cdp/connection');

function startFakeCdpServer(targets) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(targets));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function target(title, url = 'app://-/index.html') {
  return { type: 'page', title, url, webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/1' };
}

test('probe extracts Codex version and reports compatible hint', async (t) => {
  const { server, port } = await startFakeCdpServer([target('Codex 3.10.2')]);
  t.after(() => server.close());
  const conn = new CdpConnection({ host: '127.0.0.1', port });
  const result = await conn.probe();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, '3.10.2');
  assert.strictEqual(result.compatHint, 'ok');
});

test('probe flags unsupported major version with downgrade hint', async (t) => {
  const { server, port } = await startFakeCdpServer([target('Codex 4.0.0')]);
  t.after(() => server.close());
  const conn = new CdpConnection({ host: '127.0.0.1', port });
  const result = await conn.probe();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, '4.0.0');
  assert.strictEqual(result.compatHint, 'unsupported-major');
});

test('probe returns unavailable when CDP endpoint is down', async () => {
  const conn = new CdpConnection({ host: '127.0.0.1', port: 9, timeoutMs: 500 });
  const result = await conn.probe();
  assert.strictEqual(result.available, false);
  assert.ok(result.code);
});
