'use strict';

const { isCodexThreadId } = require('./core');
const { get } = require('./context');

const json = (...args) => get().json(...args);
const readBody = (...args) => get().readBody(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const readCodexMiniState = () => get().readCodexMiniState();
const writeCodexMiniState = (state) => get().writeCodexMiniState(state);

const MAX_PROMPT_LIBRARY_ITEMS = 200;

function normalizePromptLibrary(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.title || '').trim().slice(0, 60);
    const text = String(item.text || '').trim().slice(0, 4000);
    if (!title || !text) continue;
    const now = Date.now();
    out.push({
      id: String(item.id || '').slice(0, 64) || `p_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      text,
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || now,
    });
    if (out.length >= MAX_PROMPT_LIBRARY_ITEMS) break;
  }
  return out;
}

async function handlePromptLibrary(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const state = readCodexMiniState();
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, prompts: state.promptLibrary });
  }
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }
  const action = String(payload.action || '').trim();
  const id = String(payload.id || '').trim();
  let prompts = state.promptLibrary;
  try {
    if (action === 'create') {
      const title = String(payload.title || '').trim().slice(0, 60);
      const text = String(payload.text || '').trim().slice(0, 4000);
      if (!title || !text) {
        return json(res, 400, { ok: false, code: 'BAD_PROMPT', message: '提示词标题和内容不能为空。' });
      }
      const now = Date.now();
      prompts = [...prompts, {
        id: `p_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        text,
        createdAt: now,
        updatedAt: now,
      }].slice(-MAX_PROMPT_LIBRARY_ITEMS);
      writeCodexMiniState({ ...state, promptLibrary: prompts });
      return json(res, 200, { ok: true, prompts, message: '已保存提示词。' });
    }
    if (action === 'update') {
      const existing = prompts.find(item => item.id === id);
      if (!existing) {
        return json(res, 404, { ok: false, code: 'PROMPT_NOT_FOUND', message: '没有找到这条提示词。' });
      }
      const title = String(payload.title !== undefined ? payload.title : existing.title).trim().slice(0, 60);
      const text = String(payload.text !== undefined ? payload.text : existing.text).trim().slice(0, 4000);
      if (!title || !text) {
        return json(res, 400, { ok: false, code: 'BAD_PROMPT', message: '提示词标题和内容不能为空。' });
      }
      prompts = prompts.map(item => item.id === id ? { ...item, title, text, updatedAt: Date.now() } : item);
      writeCodexMiniState({ ...state, promptLibrary: prompts });
      return json(res, 200, { ok: true, prompts, message: '已更新提示词。' });
    }
    if (action === 'delete') {
      prompts = prompts.filter(item => item.id !== id);
      writeCodexMiniState({ ...state, promptLibrary: prompts });
      return json(res, 200, { ok: true, prompts, message: '已删除提示词。' });
    }
    return json(res, 400, { ok: false, code: 'BAD_PROMPT_ACTION', message: '不支持的提示词库操作。' });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      code: 'PROMPT_LIBRARY_FAILED',
      message: '提示词库操作失败。',
      detail: String(error && error.message || error),
    });
  }
}

module.exports = {
  MAX_PROMPT_LIBRARY_ITEMS,
  normalizePromptLibrary,
  handlePromptLibrary,
};
