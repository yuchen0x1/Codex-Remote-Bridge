'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function isCodexThreadId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value);
}

function validLocalDirectory(value) {
  const normalized = value ? path.normalize(value) : '';
  if (!normalized || !path.isAbsolute(normalized)) return '';
  try {
    return fs.statSync(normalized).isDirectory() ? normalized : '';
  } catch {
    return '';
  }
}

function truncateText(value, max = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeHistoryText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => item && (item.text || item.message || '')).filter(Boolean).join('\n');
}

function boundedSet(map, key, value, limit = 300) {
  if (map.size >= limit && !map.has(key)) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
  return value;
}

function fileCacheSignature(stat) {
  return stat ? `${stat.size}:${stat.mtimeMs}` : '';
}

function walkFiles(rootDir, predicate, out = []) {
  const root = path.resolve(rootDir || '');
  if (!root) return out;

  const visit = (dir) => {
    const resolvedDir = path.resolve(dir);
    const relativeDir = path.relative(root, resolvedDir);
    if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) return;

    let entries;
    try {
      entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = path.resolve(resolvedDir, entry.name);
      const relative = path.relative(root, full);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && predicate(full)) out.push(full);
    }
  };

  visit(root);
  return out;
}

function extractPlainTextDeep(value, seen = new Set()) {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const out = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...extractPlainTextDeep(item, seen));
    return out;
  }

  for (const key of ['message', 'detail', 'details', 'error', 'reason', 'description', 'status', 'code', 'title', 'text']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out.push(...extractPlainTextDeep(value[key], seen));
  }
  return out;
}

function isFailureLikePayload(payload = {}) {
  const type = String(payload.type || '').toLowerCase();
  const status = String(payload.status || '').toLowerCase();
  const code = String(payload.code || '').toLowerCase();
  return (
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(type) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(status) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(code) ||
    payload.error != null ||
    payload.detail != null ||
    payload.details != null ||
    payload.reason != null
  );
}

function isTerminalFailurePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const type = String(payload.type || '').toLowerCase();
  return (
    type === 'turn_aborted' ||
    /(?:^|_)(?:failed|failure|error|timeout|cancelled|canceled|aborted|interrupted)$/.test(type) ||
    (
      isFailureLikePayload(payload) &&
      /(?:abort|cancel|interrupt|fail|error|timeout|unavailable|overload)/.test(type)
    )
  );
}

function extractFailureTextFromPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !isFailureLikePayload(payload)) return '';
  const text = extractPlainTextDeep(payload)
    .map(value => normalizeHistoryText(value))
    .filter(Boolean)
    .filter(value => !/^(true|false|null|undefined)$/i.test(value))
    .join('\n');
  return truncateText(text, 1600);
}

function emptyCodexFailureText() {
  return 'Codex GUI 这次没有返回可显示回复。会话日志也没有写入可读取的失败提示原文；请在电脑 Codex GUI 查看原始失败提示。';
}

function cleanUserHistoryText(value) {
  const text = normalizeHistoryText(value);
  const marker = '## My request for Codex:';
  const index = text.indexOf(marker);
  if (index >= 0) return normalizeHistoryText(text.slice(index + marker.length));
  return text;
}

function isPlaceholderThreadName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  return [
    '未命名线程', '未命名任务', '未命名', 'untitled', 'untitled thread', 'new thread',
  ].includes(text);
}

function summarizeThreadTitle(value, maxLength = 34) {
  let text = cleanUserHistoryText(value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[key]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[token]')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/[#>*_[\]()~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}…`;
}

function normalizeComparableMessage(value) {
  return cleanUserHistoryText(value).replace(/\s+/g, ' ').trim();
}

function displayPathName(cwd) {
  if (!cwd) return '对话';
  const normalized = path.normalize(cwd);
  if (normalized === os.homedir()) return '~';
  if (normalized === path.parse(normalized).root) return normalized;
  return path.basename(normalized) || normalized;
}

function classifyThreadProject(cwd) {
  const normalized = cwd ? path.normalize(cwd) : '';
  const codexScratchRoot = path.join(os.homedir(), 'Documents', 'Codex');
  const relativeToScratch = normalized ? path.relative(codexScratchRoot, normalized) : '';
  const isGeneratedProjectless = Boolean(
    normalized &&
    relativeToScratch &&
    !relativeToScratch.startsWith('..') &&
    !path.isAbsolute(relativeToScratch) &&
    /^\d{4}-\d{2}-\d{2}(?:$|[\\/])/.test(relativeToScratch)
  );

  if (!normalized || isGeneratedProjectless) {
    return { isProjectThread: false, projectKey: 'conversation', projectName: '对话', projectPath: '' };
  }
  return { isProjectThread: true, projectKey: normalized, projectName: displayPathName(normalized), projectPath: normalized };
}

function codexThreadDeepLink(threadId) {
  if (!isCodexThreadId(threadId)) return null;
  return `codex://threads/${threadId}`;
}

function codexNewThreadDeepLink(cwd = '') {
  const { URL } = require('url');
  const url = new URL('codex://threads/new');
  if (cwd) url.searchParams.set('path', cwd);
  return url.toString();
}

function setThreadSetMembership(list, threadId, enabled) {
  const set = new Set((Array.isArray(list) ? list : []).filter(isCodexThreadId));
  if (enabled) set.add(threadId);
  else set.delete(threadId);
  return [...set];
}

function normalizeIsoTimestamp(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

module.exports = {
  isCodexThreadId,
  validLocalDirectory,
  truncateText,
  normalizeHistoryText,
  extractMessageText,
  boundedSet,
  fileCacheSignature,
  walkFiles,
  extractPlainTextDeep,
  isFailureLikePayload,
  isTerminalFailurePayload,
  extractFailureTextFromPayload,
  emptyCodexFailureText,
  cleanUserHistoryText,
  isPlaceholderThreadName,
  summarizeThreadTitle,
  normalizeComparableMessage,
  displayPathName,
  classifyThreadProject,
  codexThreadDeepLink,
  codexNewThreadDeepLink,
  setThreadSetMembership,
  normalizeIsoTimestamp,
  formatBytes,
};
