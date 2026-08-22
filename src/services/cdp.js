'use strict';

const { get } = require('./context');

const json = (...args) => get().json(...args);
const readBody = (...args) => get().readBody(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const platform = () => get().platform;

async function handleCdpLaunch(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (!platform().launchCodexCdp) {
    return json(res, 400, {
      ok: false,
      code: 'CDP_LAUNCH_UNSUPPORTED',
      message: '当前平台不支持从 Codex Remote Bridge 启动 CDP 受控版 ChatGPT。',
    });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const result = await platform().runExclusive(() => platform().launchCodexCdp({
      forceRestart: payload.forceRestart !== false,
      waitMs: payload.waitMs,
    }));
    return json(res, 200, result);
  } catch (error) {
    return json(res, 503, {
      ok: false,
      code: error.code || 'CDP_LAUNCH_FAILED',
      message: error.message || '启动 Codex CDP 受控版本失败。',
      launch: error.launch,
      cdp: error.cdp,
    });
  }
}

module.exports = {
  handleCdpLaunch,
};
