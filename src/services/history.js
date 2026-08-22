'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isCodexThreadId, truncateText, normalizeHistoryText, extractMessageText, cleanUserHistoryText, extractPlainTextDeep, isFailureLikePayload, isTerminalFailurePayload, extractFailureTextFromPayload, emptyCodexFailureText, fileCacheSignature, boundedSet, displayPathName, classifyThreadProject, isPlaceholderThreadName } = require('./core');
const { CODEX_TITLE_SCAN_BYTES, CODEX_SESSION_TAIL_BYTES, CODEX_HISTORY_TAIL_BYTES, CODEX_HISTORY_INITIAL_TAIL_BYTES, CODEX_ACTIVITY_TAIL_BYTES, CODEX_ACTIVITY_LOOKBACK_BYTES, readJsonlTailObjects, readTailLinesWithLimit, readTailLines, readSessionMeta, findCodexSessionFileByThreadId, findCodexSessionFileByName, findLatestCodexSessionFile, findCodexSessionFileForNewSend, waitForCodexSessionFileForNewSend, sessionHasUserMessage, waitForUserMessageInSession, threadIdFromSessionFile, quickCodexRuntimeFromFile, listCodexSessionFiles } = require('./session');
const { formatToolCall } = require('./tool-utils');
const { currentModelFromItems, currentReasoningModeFromItems, contextUsageFromItems, stepFromEvent } = require('./status');
const { json } = require('../routes');
const { shortPath, uniqueList } = require('./tool-utils');
const { get } = require('./context');

const MAX_HISTORY_MESSAGES = 120;
const MAX_ATTACHMENT_BYTES = Number(process.env.CODEX_MAX_MAX_ATTACHMENT_BYTES || process.env.CODEX_MINI_MAX_ATTACHMENT_BYTES || 8 * 1024 * 1024);
const HISTORY_ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const HISTORY_ATTACHMENT_LIMIT = 600;
const historyAttachmentCache = new Map();
const historyAttachmentIdByPath = new Map();

const isAuthorized = (req) => get().isAuthorized(req);
const resolveFailureTextForTurn = (...args) => get().resolveFailureTextForTurn(...args);
const codexAppServer = () => get().codexAppServer;

function extractUserAttachments(payload) {
  const paths = [];
  for (const key of ['local_images', 'images']) {
    if (!Array.isArray(payload[key])) continue;
    for (const item of payload[key]) {
      if (typeof item === 'string') paths.push(item);
      else if (item && typeof item.path === 'string') paths.push(item.path);
      else if (item && typeof item.filePath === 'string') paths.push(item.filePath);
    }
  }
  return paths;
}

function historyAttachmentDescriptor(filePath) {
  const absolutePath = path.resolve(String(filePath || ''));
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(absolutePath).toLowerCase()];
  if (!mime) return null;
  try {
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) return null;
  } catch { return null; }
  const now = Date.now();
  const existingId = historyAttachmentIdByPath.get(absolutePath);
  if (existingId) {
    const item = historyAttachmentCache.get(existingId);
    if (item && item.expiresAt > now && item.filePath === absolutePath) {
      return { name: path.basename(absolutePath), url: `/codex/attachment?id=${encodeURIComponent(existingId)}` };
    }
    historyAttachmentIdByPath.delete(absolutePath);
  }
  while (historyAttachmentCache.size >= HISTORY_ATTACHMENT_LIMIT) {
    const oldestId = historyAttachmentCache.keys().next().value;
    const oldest = historyAttachmentCache.get(oldestId);
    historyAttachmentCache.delete(oldestId);
    if (oldest) historyAttachmentIdByPath.delete(oldest.filePath);
  }
  const id = crypto.randomBytes(18).toString('base64url');
  historyAttachmentCache.set(id, { filePath: absolutePath, mime, expiresAt: now + HISTORY_ATTACHMENT_TTL_MS });
  historyAttachmentIdByPath.set(absolutePath, id);
  return { name: path.basename(absolutePath), url: `/codex/attachment?id=${encodeURIComponent(id)}` };
}

function scanCodexThreadHistoryLines(lines, limit = MAX_HISTORY_MESSAGES, threadId = '') {
  // 单遍扫描：每行只 JSON.parse 一次；滚动窗口只保留最近 limit 条消息（等价于旧实现的 slice(-limit)）
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  const messages = [];
  let currentTurn = null;
  let count = 0;

  function historyDurationText(startedAt = '', completedAt = '') {
    const startMs = Date.parse(startedAt || '');
    const endMs = Date.parse(completedAt || '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '';
    const total = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  function historyCompleteLabel(startedAt = '', completedAt = '') {
    const duration = historyDurationText(startedAt, completedAt);
    return duration ? `Codex · 已处理 ${duration}` : 'Codex';
  }

  function historyFailureLabel(startedAt = '', completedAt = '') {
    const duration = historyDurationText(startedAt, completedAt);
    return duration ? `Codex · 失败 ${duration}` : 'Codex';
  }

  function pushMessage(message) {
    messages.push(message);
    count += 1;
    if (messages.length <= normalizedLimit) return;
    messages.shift();
    if (currentTurn) {
      currentTurn.assistantIndex = currentTurn.assistantIndex > 0 ? currentTurn.assistantIndex - 1 : -1;
    }
  }

  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item.payload || {};

    if (item.type === 'event_msg' && payload.type === 'task_started') {
      currentTurn = { hasAssistant: false, assistantIndex: -1, failureText: '', startedAt: item.timestamp || '', turnId: payload.turn_id || '' };
      continue;
    }

    if (currentTurn && item.type === 'event_msg') {
      currentTurn.failureText = currentTurn.failureText || extractFailureTextFromPayload(payload);
    }

    if (currentTurn && item.type === 'turn_context') {
      currentTurn.turnId = payload.turn_id || currentTurn.turnId;
    }

    if (item.type === 'event_msg' && payload.type === 'user_message') {
      const text = cleanUserHistoryText(payload.message);
      const attachments = extractUserAttachments(payload);
      if (text || attachments.length) {
        pushMessage({
          role: 'user',
          label: attachments.length ? `你 · ${attachments.length} 张图片` : '你',
          text: text || (attachments.length ? ' ' : ''),
          attachments: attachments.map(historyAttachmentDescriptor).filter(Boolean),
          timestamp: item.timestamp || '',
        });
      }
      continue;
    }

    if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      if (payload.phase !== 'final_answer') continue;
      const text = normalizeHistoryText(extractMessageText(payload.content));
      if (text) {
        pushMessage({
          role: 'assistant',
          label: 'Codex',
          text,
          timestamp: item.timestamp || '',
        });
        if (currentTurn) {
          currentTurn.hasAssistant = true;
          currentTurn.assistantIndex = messages.length - 1;
        }
      }
      continue;
    }

    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      const lastMessage = normalizeHistoryText(payload.last_agent_message || '');
      const completedAt = item.timestamp || '';
      if (currentTurn && !currentTurn.hasAssistant) {
        const failureText = resolveFailureTextForTurn(threadId, {
          turnId: currentTurn.turnId || '',
          startedAt: currentTurn.startedAt || '',
          completedAt,
          failureText: currentTurn.failureText || '',
        });
        pushMessage({
          role: 'assistant',
          label: failureText ? historyFailureLabel(currentTurn.startedAt, completedAt) : historyCompleteLabel(currentTurn.startedAt, completedAt),
          text: lastMessage || failureText || emptyCodexFailureText(),
          timestamp: completedAt || currentTurn.startedAt || '',
        });
      } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
        messages[currentTurn.assistantIndex].label = historyCompleteLabel(currentTurn.startedAt, completedAt);
      }
      currentTurn = null;
    }

    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      const failureText = normalizeHistoryText(extractFailureTextFromPayload(payload) || currentTurn?.failureText || '');
      if (currentTurn && !currentTurn.hasAssistant) {
        pushMessage({
          role: 'assistant',
          label: historyFailureLabel(currentTurn.startedAt, item.timestamp || ''),
          text: failureText || emptyCodexFailureText(),
          timestamp: item.timestamp || currentTurn.startedAt || '',
        });
      } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
        messages[currentTurn.assistantIndex].label = historyFailureLabel(currentTurn.startedAt, item.timestamp || '');
      }
      currentTurn = null;
    }
  }

  return { messages, count };
}

function readHistoryTailLines(file, limit = MAX_HISTORY_MESSAGES, threadId = '') {
  // 自适应读取：小文件直接读尾；大文件先读初始尾部，不足 limit 条消息才扩大到完整上限
  const stat = fs.statSync(file);
  const maxBytes = Math.min(stat.size, CODEX_HISTORY_TAIL_BYTES);
  const desired = Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));

  if (maxBytes <= CODEX_HISTORY_INITIAL_TAIL_BYTES * 6) {
    return { lines: readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
  }

  const initialBytes = Math.min(CODEX_HISTORY_INITIAL_TAIL_BYTES, maxBytes);
  const initialLines = readTailLinesWithLimit(file, initialBytes);
  if (scanCodexThreadHistoryLines(initialLines, desired, threadId).count >= desired) {
    return { lines: initialLines, stat, scannedBytes: initialBytes };
  }

  return { lines: readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
}

function parseCodexThreadHistory(threadId, limit = MAX_HISTORY_MESSAGES) {
  const file = findCodexSessionFileByThreadId(threadId);
  if (!file) {
    return {
      ok: true,
      available: false,
      threadId,
      sessionFile: '',
      messages: [],
      message: '没有找到所选任务的 Codex 会话文件。',
    };
  }

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  const historyTail = readHistoryTailLines(file, normalizedLimit, threadId);
  const scan = scanCodexThreadHistoryLines(historyTail.lines, normalizedLimit, threadId);

  return {
    ok: true,
    available: true,
    threadId,
    sessionFile: path.basename(file),
    truncated: historyTail.stat.size > CODEX_HISTORY_TAIL_BYTES,
    messages: scan.messages,
  };
}

function appServerTurnLabel(turn = {}, failed = false) {
  const durationMs = Number(turn.durationMs || 0);
  const seconds = durationMs > 0 ? Math.max(0, Math.floor(durationMs / 1000)) : 0;
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : seconds ? `${seconds}s` : '';
  if (failed) return duration ? `Codex · 失败 ${duration}` : 'Codex · 失败';
  return duration ? `Codex · 已处理 ${duration}` : 'Codex';
}

function appServerUserMessage(item = {}, timestamp = '') {
  const textParts = [];
  const attachments = [];
  for (const content of item.content || []) {
    if (content?.type === 'text' && content.text) textParts.push(content.text);
    if (content?.type === 'localImage' && content.path) {
      const attachment = historyAttachmentDescriptor(content.path);
      if (attachment) attachments.push(attachment);
    } else if (content?.type === 'image' && content.url) {
      attachments.push({ filePath: content.url, name: 'image' });
    }
  }
  const text = cleanUserHistoryText(textParts.join('\n'));
  if (!text && !attachments.length) return null;
  return {
    role: 'user',
    label: attachments.length ? `你 · ${attachments.length} 张图片` : '你',
    text: text || ' ',
    attachments,
    timestamp,
  };
}

function appServerActivityText(item = {}) {
  const type = String(item.type || '').trim();
  const activityTypes = new Set(['mcpToolCall', 'fileChange', 'contextCompaction', 'compacted', 'commandExecution', 'shellCommand', 'webSearch', 'imageGeneration', 'imageView', 'browserAction']);
  if (!activityTypes.has(type)) return null;
  const rawTool = String(item.tool || item.name || item.command || '').trim();
  const tool = rawTool.split('.').pop().toLowerCase();
  const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
  const title = String(args.title || item.title || '').replace(/\s+/g, ' ').trim();
  const code = String(args.code || '').trim();

  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.map(change => change?.path).filter(Boolean).map(shortPath);
    return {
      kind: 'tool',
      category: 'file',
      label: '文件',
      text: paths.length ? `编辑 ${uniqueList(paths, 3).join('、')}` : '编辑文件',
    };
  }
  if (type === 'contextCompaction' || type === 'compacted') {
    return { kind: 'tool', category: 'context', label: '上下文', text: '压缩上下文' };
  }

  const looksLikeImage = tool === 'view_image' || /(?:view_image|查看图片|已查看\s*\d*\s*张?(?:图片|图像)|\bimage(?:s)?\b)/i.test(`${rawTool} ${title}`) || /\bview_image\b/i.test(code);
  if (looksLikeImage) return { kind: 'tool', category: 'image', label: '图片', text: title || '查看图片' };

  const looksLikeBrowser = /(?:browser|chrome|网页|页面|tab|domsnapshot|screenshot|playwright|goto\s*\()/i.test(`${rawTool} ${title} ${code}`);
  const looksLikeCommand = /(?:exec_command|shell_command|powershell|命令|npm\s|node\s|git\s|Get-[A-Za-z]|rg\s|sed\s|\bcat\s)/i.test(`${rawTool} ${title} ${code}`);
  if (looksLikeBrowser) return { kind: 'tool', category: 'browser', label: '浏览器', text: title || '检查网页' };
  if (looksLikeCommand) return { kind: 'tool', category: 'command', label: '命令', text: title || '运行命令' };

  if (type === 'commandExecution' || type === 'shellCommand') {
    return { kind: 'tool', category: 'command', label: '命令', text: title || item.command || '运行命令' };
  }
  if (type === 'webSearch' || /search/i.test(tool)) return { kind: 'tool', category: 'search', label: '搜索', text: title || '搜索资料' };
  return { kind: 'tool', category: 'tool', label: '工具', text: title || rawTool || '使用工具' };
}

function appServerTurnActivities(turn = {}) {
  const activities = [];
  for (const item of turn.items || []) {
    if (!item || !item.type) continue;
    const activity = appServerActivityText(item);
    if (activity) activities.push({ ...activity, id: item.id || '', status: item.status || '' });
  }
  return activities.slice(-500);
}

function historyFromAppServerThread(thread, limit = MAX_HISTORY_MESSAGES) {
  const messages = [];
  // The app server can return turns in cache or newest-first order. The phone
  // must always mirror the desktop conversation from oldest to newest.
  const turns = [...(thread?.turns || [])]
    .map((turn, index) => ({ turn, index }))
    .sort((left, right) => {
      const leftTime = Number(left.turn?.startedAt || left.turn?.createdAt || 0);
      const rightTime = Number(right.turn?.startedAt || right.turn?.createdAt || 0);
      return leftTime - rightTime || left.index - right.index;
    });
  for (const { turn } of turns) {
    const startedAt = Number(turn.startedAt || 0) ? new Date(Number(turn.startedAt) * 1000).toISOString() : '';
    const completedAt = Number(turn.completedAt || 0) ? new Date(Number(turn.completedAt) * 1000).toISOString() : '';
    const agentItems = [];
    const activities = appServerTurnActivities(turn);
    let hasExplicitFinal = false;
    for (const item of turn.items || []) {
      if (item?.type === 'userMessage') {
        const message = appServerUserMessage(item, startedAt);
        if (message) messages.push(message);
      }
      if (item?.type === 'agentMessage' && item.text) {
        agentItems.push(item);
        if (item.phase === 'final_answer') hasExplicitFinal = true;
      }
    }

    const visibleAgents = hasExplicitFinal
      ? agentItems.filter(item => item.phase === 'final_answer')
      : (turn.status === 'completed' ? agentItems.slice(-1) : []);
    for (const item of visibleAgents) {
      const text = normalizeHistoryText(item.text || '');
      if (!text) continue;
      messages.push({
        role: 'assistant',
        label: appServerTurnLabel(turn, false),
        text,
        steps: activities,
        timestamp: completedAt || startedAt,
      });
    }

    if (turn.status === 'failed' && !visibleAgents.length) {
      const failure = normalizeHistoryText(turn.error?.message || turn.error?.additionalDetails || '') || emptyCodexFailureText();
      messages.push({
        role: 'assistant',
        label: appServerTurnLabel(turn, true),
        text: failure,
        steps: activities,
        timestamp: completedAt || startedAt,
      });
    }
  }

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  return {
    ok: true,
    available: Boolean(thread),
    transport: 'app-server',
    threadId: thread?.id || '',
    sessionFile: thread?.path ? path.basename(thread.path) : '',
    truncated: messages.length > normalizedLimit,
    messages: messages.slice(-normalizedLimit),
  };
}

async function handleThreadHistory(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const threadId = url.searchParams.get('thread') || '';
    if (!isCodexThreadId(threadId)) {
      return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
    }
    const limit = url.searchParams.get('limit') || MAX_HISTORY_MESSAGES;
    try {
      const thread = await codexAppServer().readThread(threadId, true);
      return json(res, 200, historyFromAppServerThread(thread, limit));
    } catch (appServerError) {
      return json(res, 200, {
        ...parseCodexThreadHistory(threadId, limit),
        transport: 'session-files',
        appServerError: appServerError.message || String(appServerError),
      });
    }
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_HISTORY_FAILED', message: '读取 Codex 聊天记录失败。', detail: String(error && error.message || error) });
  }
}

module.exports = {
  MAX_HISTORY_MESSAGES,
  HISTORY_ATTACHMENT_TTL_MS,
  HISTORY_ATTACHMENT_LIMIT,
  historyAttachmentCache,
  historyAttachmentIdByPath,
  extractUserAttachments,
  historyAttachmentDescriptor,
  scanCodexThreadHistoryLines,
  readHistoryTailLines,
  parseCodexThreadHistory,
  appServerTurnLabel,
  appServerUserMessage,
  appServerActivityText,
  appServerTurnActivities,
  historyFromAppServerThread,
  handleThreadHistory,
};
