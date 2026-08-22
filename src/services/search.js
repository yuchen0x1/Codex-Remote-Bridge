'use strict';

const fs = require('fs');
const path = require('path');
const { cleanUserHistoryText, normalizeHistoryText, extractMessageText } = require('./core');
const { readJsonlTailObjects, readSessionMeta, threadIdFromSessionFile, listCodexSessionFiles } = require('./session');
const { get } = require('./context');

const json = (...args) => get().json(...args);
const isAuthorized = (req) => get().isAuthorized(req);

const CODEX_SEARCH_TAIL_BYTES = 2 * 1024 * 1024;
const CODEX_SEARCH_MAX_FILES = 200;
const CODEX_SEARCH_MAX_RESULTS = 100;
const CODEX_SEARCH_MIN_QUERY_LENGTH = 2;

function searchSnippet(text, index, needleLength, radius = 60) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needleLength + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

function searchableTextFromItem(item) {
  const payload = item && item.payload || {};
  if (item.type === 'event_msg' && payload.type === 'user_message') {
    return cleanUserHistoryText(payload.message);
  }
  if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer') {
    return normalizeHistoryText(extractMessageText(payload.content));
  }
  return '';
}

function searchCodexSessions(query, options = {}) {
  const rawQuery = String(query || '').trim();
  const needle = rawQuery.toLocaleLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit) || 50, CODEX_SEARCH_MAX_RESULTS));
  const startedAt = Date.now();
  if (needle.length < CODEX_SEARCH_MIN_QUERY_LENGTH) {
    return { ok: true, query: rawQuery, limit, tookMs: 0, results: [] };
  }
  const files = listCodexSessionFiles({ force: true });
  const candidates = [];
  for (const file of files) {
    try {
      candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // ignore disappearing files
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanned = candidates.slice(0, CODEX_SEARCH_MAX_FILES);
  const hits = [];
  for (const { file, mtimeMs } of scanned) {
    const items = readJsonlTailObjects(file, CODEX_SEARCH_TAIL_BYTES);
    let best = null;
    for (const item of items) {
      const text = searchableTextFromItem(item);
      if (!text) continue;
      const lower = text.toLocaleLowerCase();
      const index = lower.indexOf(needle);
      if (index < 0) continue;
      const snippet = searchSnippet(text, index, needle.length);
      const updatedAt = item.timestamp || new Date(mtimeMs).toISOString();
      if (!best || (Date.parse(updatedAt) || 0) > (Date.parse(best.updatedAt) || 0)) {
        best = { snippet, updatedAt };
      }
    }
    if (best) {
      const meta = readSessionMeta(file);
      hits.push({
        threadId: threadIdFromSessionFile(file),
        title: String(meta.title || '').trim().slice(0, 60),
        snippet: best.snippet,
        updatedAt: best.updatedAt,
        sessionFile: path.basename(file),
      });
    }
  }
  hits.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return {
    ok: true,
    query: rawQuery,
    limit,
    tookMs: Date.now() - startedAt,
    results: hits.slice(0, limit),
  };
}

async function handleSearch(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = String(url.searchParams.get('q') || '').trim();
    if (query.length < CODEX_SEARCH_MIN_QUERY_LENGTH) {
      return json(res, 400, { ok: false, code: 'BAD_QUERY', message: '搜索词至少需要 2 个字符。' });
    }
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, CODEX_SEARCH_MAX_RESULTS));
    return json(res, 200, searchCodexSessions(query, { limit }));
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_SEARCH_FAILED', message: '搜索对话内容失败。', detail: String(error && error.message || error) });
  }
}

module.exports = {
  CODEX_SEARCH_TAIL_BYTES,
  CODEX_SEARCH_MAX_FILES,
  CODEX_SEARCH_MAX_RESULTS,
  searchSnippet,
  searchableTextFromItem,
  searchCodexSessions,
  handleSearch,
};
