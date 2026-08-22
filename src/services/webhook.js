'use strict';

const { get } = require('./context');

const json = (...args) => get().json(...args);
const readBody = (...args) => get().readBody(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const store = () => get().store;
const logger = () => get().logger;
const APP_NAME = process.env.CODEX_MAX_APP_NAME || process.env.CODEX_MINI_APP_NAME || 'Codex Remote Bridge';

async function handleWebhook(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (req.method === 'GET') {
    const state = store().readState();
    return json(res, 200, { ok: true, webhook: state.webhook || '', enabled: Boolean(state.webhook) });
  }
  if (req.method === 'POST') {
    let payload = {};
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch (error) {
      return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
    }
    const url = String(payload.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
      return json(res, 400, { ok: false, code: 'BAD_WEBHOOK_URL', message: 'Webhook 地址必须以 http(s):// 开头。' });
    }
    const state = store().readState();
    state.webhook = url;
    store().writeState(state);
    logger().info('webhook_updated', { enabled: Boolean(url) });
    return json(res, 200, { ok: true, webhook: url, enabled: Boolean(url), message: url ? '已启用 Webhook 通知。' : '已关闭 Webhook 通知。' });
  }
  return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
}

function fireWebhook(event, payload = {}) {
  const webhook = store().readState().webhook;
  if (!webhook) return;
  const httpModule = webhook.startsWith('https:') ? require('https') : require('http');
  const body = JSON.stringify({ event, ...payload, ts: new Date().toISOString() });
  const request = httpModule.request(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': `${APP_NAME}/4.0` },
    timeout: 5000,
  }, response => {
    response.resume();
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => {});
  request.end(body);
}

module.exports = {
  handleWebhook,
  fireWebhook,
};
