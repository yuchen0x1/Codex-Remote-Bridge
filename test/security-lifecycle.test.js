'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { SessionManager } = require('../src/security/sessions');
const { Security } = require('../src/security');
const { CdpWebSocketHub } = require('../src/cdp/ws-hub');
const { PersistentQueue } = require('../src/store/queue');
const { CertificateManager } = require('../src/security/certs');
const logger = { info() {}, warn() {}, debug() {} };

test('offline cache bypasses credential URLs and API reads', () => {
  const listeners = {};
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'), {
    self: { location: { origin: 'https://bridge.test' }, addEventListener: (name, fn) => { listeners[name] = fn; } }, URL,
  });
  for (const suffix of ['/?token=secret', '/?pair=123456', '/codex/config']) {
    let intercepted = false;
    listeners.fetch({ request: { method: 'GET', url: `https://bridge.test${suffix}` }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});

test('session identities are not credentials, revocation is selective and rotation is global', () => {
  const sessions = new SessionManager();
  const security = new Security({ initialToken: 'a-long-test-master-token', sessionManager: sessions });
  try {
    const a = sessions.createSession('phone', { scope: 'read-only' });
    const b = sessions.createSession('tablet');
    const list = sessions.listSessions(b.token);
    assert.equal(list.find(item => item.id === b.session.id).current, true);
    assert.equal(sessions.validateSession(a.session.id), null);
    assert.equal(sessions.revokeById(a.session.id), true);
    assert.equal(sessions.validateSession(a.token), null);
    assert.ok(sessions.validateSession(b.token));
    const oldReadToken = security.readOnlyToken();
    security.rotateToken();
    assert.equal(sessions.validateSession(b.token), null);
    assert.notEqual(oldReadToken, security.readOnlyToken());
    const empty = new Security();
    try { assert.equal(empty.isAuthorized({ url: '/', headers: {} }), false); } finally { empty.destroy(); }
  } finally { security.destroy(); }
});

test('custom data directories contain queue, logs and TLS material across reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-isolation-'));
  const queueDir = path.join(dir, 'db');
  const queue = new PersistentQueue({ dbDir: queueDir, logger });
  try {
    queue.enqueue('fixture', { value: 42 });
    queue.logExecution('fixture', 'read', 'completed');
    queue.close();
    const reopened = new PersistentQueue({ dbDir: queueDir, logger });
    assert.equal(reopened.dequeue().payload.value, 42);
    assert.equal(reopened.getLogs()[0].action, 'read');
    reopened.close();
    const certs = new CertificateManager({ certDir: path.join(dir, 'certs') });
    assert.equal(certs.certFile, path.join(dir, 'certs', 'cert.pem'));
    assert.equal(certs.keyFile, path.join(dir, 'certs', 'key.pem'));
  } finally { queue.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('WebSocket supports scoped cookies, rejects foreign origins and disconnects revoked or oversized clients', { timeout: 10000 }, async () => {
  const sessions = new SessionManager();
  const security = new Security({ initialToken: 'websocket-test-master', sessionManager: sessions });
  const hub = new CdpWebSocketHub({ security, logger });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const sockets = [];
  async function connect(cookie, origin = `http://127.0.0.1:${port}`) {
    const socket = net.connect(port, '127.0.0.1');
    sockets.push(socket);
    await once(socket, 'connect');
    const response = once(socket, 'data');
    socket.write(`GET /codex/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\nCookie: codexMiniSession=${cookie}\r\n\r\n`);
    return { socket, response: (await response)[0].toString() };
  }
  try {
    const session = sessions.createSession('readonly phone', { scope: 'read-only' });
    assert.match((await connect('invalid')).response, /401/);
    assert.match((await connect(session.token, 'https://foreign.example')).response, /403/);
    const a = await connect(session.token);
    assert.match(a.response, /101/);
    const disconnected = once(a.socket, 'close');
    sessions.revokeById(session.session.id);
    hub.disconnectUnauthorized();
    await disconnected;
    assert.equal(hub.getClientCount(), 0);
    assert.equal(hub._statusPollTimer, null);
    const b = await connect(sessions.createSession('phone').token);
    assert.match(b.response, /101/);
    const oversizedClosed = once(b.socket, 'close');
    const oversized = Buffer.alloc(14);
    oversized[0] = 0x81;
    oversized[1] = 0xff;
    oversized.writeBigUInt64BE(1000000n, 2);
    b.socket.write(oversized);
    await oversizedClosed;
  } finally {
    hub.stop();
    sockets.forEach(socket => socket.destroy());
    await new Promise(resolve => server.close(resolve));
    security.destroy();
  }
});
