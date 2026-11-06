'use strict';

const { get } = require('./context');

const json = (...args) => get().json(...args);
const readBody = (...args) => get().readBody(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const store = () => get().store;
const logger = () => get().logger;
const APP_NAME = process.env.CODEX_MAX_APP_NAME || process.env.CODEX_MINI_APP_NAME || 'Codex Remote Bridge';

function isForbiddenWebhookHost(hostname) {
  if (process.env.CODEX_ALLOW_PRIVATE_WEBHOOK === '1') return false;
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    /^127(?:\.\d+){1,3}$/.test(host) ||
    /^169\.254(?:\.\d+){1,3}$/.test(host) ||
    host.endsWith('.internal')
  );
}

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
    if (url) {
      if (!/^https?:\/\//i.test(url)) {
        return json(res, 400, { ok: false, code: 'BAD_WEBHOOK_URL', message: 'Webhook 地址必须以 http(s):// 开头。' });
      }
      try {
        const parsed = new URL(url);
        if (isForbiddenWebhookHost(parsed.hostname)) {
          return json(res, 400, { ok: false, code: 'FORBIDDEN_WEBHOOK_HOST', message: '禁止使用环回或元数据私有网络地址作为 Webhook。' });
        }
      } catch {
        return json(res, 400, { ok: false, code: 'BAD_WEBHOOK_URL', message: 'Webhook 地址格式不正确。' });
      }
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
  let parsed;
  try {
    parsed = new URL(webhook);
  } catch {
    return;
  }
  if (isForbiddenWebhookHost(parsed.hostname)) return;
  const httpModule = parsed.protocol === 'https:' ? require('https') : require('http');
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
