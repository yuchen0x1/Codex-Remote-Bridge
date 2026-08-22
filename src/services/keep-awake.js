'use strict';

const { get } = require('./context');

const json = (...args) => get().json(...args);
const readBody = (...args) => get().readBody(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const keepAwakeStatus = () => get().platform.keepAwakeStatus();
const startKeepAwake = () => get().platform.startKeepAwake();
const stopKeepAwake = () => get().platform.stopKeepAwake();

async function handleKeepAwake(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, ...keepAwakeStatus() });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const enabled = payload.enabled === true;
    const status = await (enabled ? startKeepAwake() : stopKeepAwake());
    return json(res, 200, {
      ok: true,
      ...status,
      message: status.enabled ? '已开启保持亮屏，电脑不会自动休眠' : '已关闭保持亮屏',
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      code: error.code || 'KEEP_AWAKE_FAILED',
      message: error.message || '切换保持亮屏失败。',
    });
  }
}

module.exports = {
  handleKeepAwake,
};
