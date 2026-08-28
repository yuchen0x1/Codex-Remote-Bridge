'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexAppServer } = require('../src/codex-app-server');

function createServer() {
  const server = new CodexAppServer({ enabled: false });
  const responses = [];
  server.sendResponse = (id, result) => responses.push({ id, result });
  return { server, responses };
}

test('command approval is normalized and sent back with the selected decision', () => {
  const { server, responses } = createServer();
  server.pendingServerRequests.set('command-1', {
    id: 'command-1',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      reason: 'Install the requested package.',
      command: 'npm install example',
      cwd: 'C:\\work',
      networkApprovalContext: { protocol: 'https', host: 'registry.npmjs.org', port: 443 },
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
    },
    receivedAt: '2026-07-31T00:00:00.000Z',
  });

  const [approval] = server.listPendingApprovals();
  assert.equal(approval.kind, 'network');
  assert.equal(approval.networkTarget, 'https://registry.npmjs.org:443');
  assert.deepEqual(approval.decisions, ['accept', 'acceptForSession', 'decline']);

  const result = server.resolvePendingApproval('command-1', 'acceptForSession');
  assert.equal(result.decision, 'acceptForSession');
  assert.deepEqual(responses, [{ id: 'command-1', result: { decision: 'acceptForSession' } }]);
  assert.equal(server.listPendingApprovals().length, 0);
});

test('permission approval grants only the requested permission object and supports decline', () => {
  const { server, responses } = createServer();
  const requested = { network: { hosts: ['api.example.com'] }, filesystem: { read: ['C:\\work'] } };
  server.pendingServerRequests.set('permission-1', {
    id: 'permission-1',
    method: 'item/permissions/requestApproval',
    params: { threadId: 'thread-1', permissions: requested },
    receivedAt: '2026-07-31T00:00:00.000Z',
  });
  server.resolvePendingApproval('permission-1', 'acceptForSession');
  assert.deepEqual(responses.pop(), {
    id: 'permission-1',
    result: { permissions: requested, scope: 'session' },
  });

  server.pendingServerRequests.set('permission-2', {
    id: 'permission-2',
    method: 'item/permissions/requestApproval',
    params: { threadId: 'thread-1', permissions: requested },
    receivedAt: '2026-07-31T00:01:00.000Z',
  });
  server.resolvePendingApproval('permission-2', 'decline');
  assert.deepEqual(responses.pop(), {
    id: 'permission-2',
    result: { permissions: {}, scope: 'turn' },
  });
});

test('MCP elicitation only allows decline or cancel without form content', () => {
  const { server, responses } = createServer();
  server.pendingServerRequests.set('mcp-1', {
    id: 'mcp-1',
    method: 'mcpServer/elicitation/request',
    params: { threadId: 'thread-1', serverName: 'example-mcp', mode: 'form', message: 'Continue?' },
    receivedAt: '2026-07-31T00:00:00.000Z',
  });

  assert.throws(() => server.resolvePendingApproval('mcp-1', 'accept'), error => error.code === 'APPROVAL_DECISION_NOT_ALLOWED');
  server.resolvePendingApproval('mcp-1', 'cancel');
  assert.deepEqual(responses, [{ id: 'mcp-1', result: { action: 'cancel', content: null } }]);
});

test('resolved server notifications clear stale pending approvals', () => {
  const { server } = createServer();
  server.pendingServerRequests.set('stale-1', {
    id: 'stale-1',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-1' },
    receivedAt: '2026-07-31T00:00:00.000Z',
  });
  server.handleNotification('serverRequest/resolved', { threadId: 'thread-1', requestId: 'stale-1' });
  assert.equal(server.listPendingApprovals().length, 0);
});

test('workspace catalog wrappers use the App Server list methods and normalize data arrays', async () => {
  const { server } = createServer();
  const calls = [];
  server.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'plugin/list') return { marketplaces: [] };
    if (method === 'skills/list') return { data: [{ cwd: 'C:\\work', skills: [] }] };
    if (method === 'app/list') return { data: [{ id: 'demo-app' }] };
    return {};
  };

  const plugins = await server.listPlugins();
  const skills = await server.listSkills(['C:\\work', 'C:\\work'], { forceReload: true });
  const apps = await server.listApps({ limit: 500, forceRefetch: true });

  assert.deepEqual(plugins, { marketplaces: [] });
  assert.deepEqual(skills, [{ cwd: 'C:\\work', skills: [] }]);
  assert.deepEqual(apps, [{ id: 'demo-app' }]);
  assert.deepEqual(calls, [
    { method: 'plugin/list', params: {} },
    { method: 'skills/list', params: { cwds: ['C:\\work'], forceReload: true } },
    { method: 'app/list', params: { cursor: null, limit: 100, forceRefetch: true } },
  ]);
});

test('thread management wrappers use documented App Server actions', async () => {
  const { server } = createServer();
  const calls = [];
  server.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'review/start') {
      return { reviewThreadId: 'thread-1', turn: { id: 'turn-review' } };
    }
    return {};
  };

  await server.setThreadPinned('thread-1', true);
  await server.compactThread('thread-1');
  const review = await server.startReview('thread-1');

  assert.equal(review.reviewThreadId, 'thread-1');
  assert.equal(server.runtimeForThread('thread-1').activeTurnId, 'turn-review');
  assert.deepEqual(calls, [
    {
      method: 'thread/metadata/update',
      params: { threadId: 'thread-1', thread: { isPinned: true } },
    },
    {
      method: 'thread/compact/start',
      params: { threadId: 'thread-1' },
    },
    {
      method: 'review/start',
      params: { threadId: 'thread-1', delivery: 'inline', target: { type: 'uncommittedChanges' } },
    },
  ]);
});

test('stale approvals and thread runtimes are pruned by TTL', () => {
  const { server } = createServer();
  const now = Date.now();
  server.pendingServerRequests.set('stale-approval', {
    id: 'stale-approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1' },
    receivedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
  });
  server.pendingServerRequests.set('fresh-approval', {
    id: 'fresh-approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1' },
    receivedAt: new Date(now - 1000).toISOString(),
  });
  server.threadRuntime.set('stale-thread', {
    threadId: 'stale-thread',
    activeTurnId: '',
    status: 'idle',
    updatedAt: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
  });
  server.threadRuntime.set('fresh-thread', {
    threadId: 'fresh-thread',
    activeTurnId: '',
    status: 'idle',
    updatedAt: new Date(now - 1000).toISOString(),
  });

  server._pruneStaleState();

  assert.equal(server.pendingServerRequests.has('stale-approval'), false);
  assert.equal(server.pendingServerRequests.has('fresh-approval'), true);
  assert.equal(server.threadRuntime.has('stale-thread'), false);
  assert.equal(server.threadRuntime.has('fresh-thread'), true);
  server.close();
});
