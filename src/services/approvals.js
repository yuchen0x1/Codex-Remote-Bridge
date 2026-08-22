'use strict';

const { isCodexThreadId } = require('./core');
const { get } = require('./context');

const json = (...args) => get().json(...args);
const readBody = (...args) => get().readBody(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const codexAppServer = () => get().codexAppServer;

function handleCodexApprovals(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const threadId = String(url.searchParams.get('thread') || '').trim();
  if (threadId && !isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
  }

  return json(res, 200, {
    ok: true,
    available: codexAppServer().isAvailable(),
    approvals: codexAppServer().listPendingApprovals({ threadId }),
  });
}

async function handleCodexApproval(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const requestId = String(payload.requestId || '').trim();
  const decision = String(payload.decision || '').trim();
  if (!requestId || requestId.length > 200 || !decision) {
    return json(res, 400, { ok: false, code: 'BAD_APPROVAL_REQUEST', message: '授权请求或操作不正确。' });
  }

  try {
    const result = codexAppServer().resolvePendingApproval(requestId, decision);
    return json(res, 200, { ok: true, ...result, message: '已将授权决定发送给 Codex。' });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return json(res, status, {
      ok: false,
      code: error?.code || 'APPROVAL_FAILED',
      message: error?.message || '处理 Codex 授权失败。',
    });
  }
}

module.exports = {
  handleCodexApprovals,
  handleCodexApproval,
};
