'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

test('config exposes the public update manifest metadata', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codex-update-info-'));
  const port = await freePort();
  const token = 'update-info-test-token';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      HOME: tmpRoot,
      USERPROFILE: tmpRoot,
      PORT: String(port),
      HOST: '127.0.0.1',
      CODEX_MAX_HTTP_ONLY: '1',
      CODEX_MAX_STATE_DIR: path.join(tmpRoot, '.codex-max'),
      MOBILE_TYPER_TOKEN: token,
      CODEX_MAX_UPDATE_MANIFEST_URL: 'https://updates.example.invalid/manifest.json',
      CODEX_MAX_UPDATE_REPOSITORY: 'example/project',
      CODEX_MAX_UPDATE_CHANNEL: 'beta',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  try {
    let ready = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/codex/health`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const response = await fetch(`http://127.0.0.1:${port}/codex/config`, {
      headers: { 'x-mobile-typer-token': token },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.update.currentVersion, require('../package.json').version);
    assert.equal(body.update.channel, 'beta');
    assert.equal(body.update.repository, 'example/project');
    assert.equal(body.update.manifestUrl, 'https://updates.example.invalid/manifest.json');
    assert.equal(body.update.releaseUrl, 'https://github.com/example/project/releases/latest');
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
