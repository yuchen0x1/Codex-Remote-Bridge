'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isCodexThreadId, validLocalDirectory, truncateText, formatBytes } = require('./core');

function normalizeClientRequestId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9._:-]{8,120}$/.test(id) ? id : '';
}

function cleanupRecentSendRequests() {
  const cutoff = Date.now() - RECENT_SEND_TTL_MS;
  for (const [id, entry] of recentSendRequests) {
    if (!entry || entry.createdAt < cutoff) recentSendRequests.delete(id);
  }
}

function runProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${command} exited with code ${code}`), { code, stdout, stderr }));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function explainAutomationError(error) {
  const raw = String(error && (error.stderr || error.message) || '');
  const lower = raw.toLowerCase();
  if (process.platform === 'win32') {
    if (lower.includes('codex') || lower.includes('window') || lower.includes('窗口') || lower.includes('start-process')) {
      return {
        code: 'CODEX_WINDOW_NOT_READY',
        message: 'Windows 没能激活 Codex Desktop。请确认 Codex Desktop 已安装、已登录，并且 codex:// 协议能从运行服务的这个桌面会话打开。',
        detail: raw,
      };
    }
    if (lower.includes('clipboard') || lower.includes('剪贴板')) {
      return {
        code: 'WINDOWS_CLIPBOARD_FAILED',
        message: 'Windows 剪贴板写入失败。请确认当前桌面没有其他程序长时间占用剪贴板，然后重试。',
        detail: raw,
      };
    }
    return {
      code: 'WINDOWS_AUTOMATION_FAILED',
      message: 'Windows 自动粘贴失败。请确认 Codex Desktop 正在当前用户桌面运行，且服务不是在锁屏、UAC 或非交互会话里运行。',
      detail: raw,
    };
  }
  if (lower.includes('assistive') || lower.includes('accessibility') || lower.includes('-25211') || lower.includes('not allowed') || lower.includes('not authorized')) {
    return {
      code: 'ACCESSIBILITY_PERMISSION_REQUIRED',
      message: 'Mac 还没有允许这个终端控制键盘。请到 系统设置 → 隐私与安全性 → 辅助功能，允许 Terminal / Ghostty / Codex 正在使用的终端，然后重启服务再试。',
      detail: raw,
    };
  }
  return {
    code: 'MAC_AUTOMATION_FAILED',
    message: 'Mac 自动粘贴失败。请确认当前有可输入的前台应用，并检查辅助功能权限。',
    detail: raw,
  };
}

function explainTargetError(error, target) {
  const raw = String(error && (error.stderr || error.message) || '');
  if (target === 'codex') {
    if (process.platform === 'win32') {
      return {
        code: 'CODEX_FOCUS_FAILED',
        message: '已经收到文字，但没能自动聚焦 Codex 输入框。请确认 Codex Desktop 正在当前 Windows 桌面运行，且服务不是在锁屏或非交互会话里运行。',
        detail: raw,
      };
    }
    return {
      code: 'CODEX_FOCUS_FAILED',
      message: '已经收到文字，但没能自动聚焦 Codex 输入框。请确认 Codex 正在运行，且当前终端已开启辅助功能权限。',
      detail: raw,
    };
  }
  return explainAutomationError(error);
}

async function copyTextToClipboard(text) {
  return platform.copyTextToClipboard(text);
}

function getClickTool() {
  for (const candidate of ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function toCliclickAbsolutePoint(point) {
  // cliclick treats leading +/- as relative movement. Prefix negative absolute
  // coordinates with '=' for multi-display layouts above/left of the main screen.
  return point.split(',').map(part => part.startsWith('-') ? `=${part}` : part).join(',');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasFreshCodexThreadActivation(threadId) {
  return false;
}

async function focusTarget(target, threadId = '', options = {}) {
  return platform.focusTarget(target, threadId, options);
}

function codexFocusOptions(threadId = '', options = {}) {
  if (process.platform !== 'win32') return options;
  const normalized = {
    ...options,
    skipComposerClick: options.forceComposerClick === true ? false : true,
  };
  if (
    isCodexThreadId(threadId) &&
    (options.bounceViaNewThread === true || process.env.CODEX_MAX_WIN32_ALWAYS_NEW_THREAD_BOUNCE === '1' || process.env.CODEX_MINI_WIN32_ALWAYS_NEW_THREAD_BOUNCE === '1')
  ) {
    return { ...normalized, bounceViaNewThread: true };
  }
  return normalized;
}

async function activateCodexThread(threadId = '', options = {}) {
  return platform.activateCodexThread(threadId, options);
}

async function activateNewCodexThread(cwd = '') {
  return platform.activateNewCodexThread(cwd);
}

async function activateNewProjectlessCodexThread(anchorThreadId = '') {
  return platform.activateNewProjectlessCodexThread(anchorThreadId);
}

function normalizeNewThreadScope(payload = {}) {
  const raw = typeof payload.scope === 'string' ? payload.scope.trim().toLowerCase() : '';
  if (raw === 'conversation' || raw === 'project') return raw;
  if (payload.isProjectThread === false) return 'conversation';
  if (payload.isProjectThread === true) return 'project';
  return '';
}

function projectCwdOrEmpty(value) {
  const cwd = validLocalDirectory(value);
  if (!cwd) return '';
  return classifyThreadProject(cwd).isProjectThread ? cwd : '';
}

function resolveNewThreadTarget(payload = {}) {
  const scope = normalizeNewThreadScope(payload);
  const projectPath = projectCwdOrEmpty(typeof payload.projectPath === 'string' ? payload.projectPath : '');
  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';

  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('任务 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }

  if (scope === 'conversation') {
    return { scope: 'conversation', cwd: '', anchorThreadId: threadId };
  }

  if (scope === 'project' && projectPath) {
    return { scope: 'project', cwd: projectPath, anchorThreadId: threadId };
  }

  if (threadId) {
    const file = findCodexSessionFileByThreadId(threadId);
    const metaCwd = file ? readSessionMeta(file).cwd || '' : '';
    const metaProject = classifyThreadProject(validLocalDirectory(metaCwd) || '');
    if (metaProject.isProjectThread) {
      return { scope: 'project', cwd: metaProject.projectPath, anchorThreadId: threadId };
    }
    return { scope: 'conversation', cwd: '', anchorThreadId: threadId };
  }

  if (projectPath) return { scope: 'project', cwd: projectPath, anchorThreadId: '' };
  return { scope: 'conversation', cwd: '', anchorThreadId: '' };
}

async function pasteAndEnter(text, target = 'frontmost', attachments = [], threadId = '', options = {}) {
  if (process.platform === 'win32' && target === 'codex') {
    return platform.runExclusive(async () => {
      if (!attachments.length) {
        if (!options.assumeThreadSynced && isCodexThreadId(threadId)) {
          await activateCodexThread(threadId, { allowCached: false });
        }
        if (text) {
          await pasteTextAndEnter(text);
          return;
        }
        await pressEnter();
        return;
      }

      if (!options.assumeThreadSynced && isCodexThreadId(threadId)) {
        await activateCodexThread(threadId, { allowCached: false, preferCdp: false });
      } else {
        await focusTarget('codex', threadId, { ...codexFocusOptions(threadId, options), preferCdp: false });
      }
      for (const attachment of attachments) {
        await copyImageToClipboard(attachment);
        await pressPaste();
        await delay(ATTACHMENT_PASTE_SETTLE_MS);
      }
      if (text) {
        await copyTextToClipboard(text);
        await pressPasteAndEnter();
        return;
      }
      await pressEnter();
    });
  }

  return platform.withClipboardPreserved(async () => {
    await focusTarget(target, threadId, target === 'codex' ? codexFocusOptions(threadId, options) : options);

    for (const attachment of attachments) {
      await copyImageToClipboard(attachment);
      await pressPaste();
      await delay(ATTACHMENT_PASTE_SETTLE_MS);
    }

    if (text) {
      await pasteTextAndEnter(text);
      return;
    }

    await pressEnter();
  });
}

async function pasteTextAndEnter(text) {
  if (platform.pasteTextAndEnter) {
    await platform.pasteTextAndEnter(text);
    return;
  }
  await copyTextToClipboard(text);
  await pressPasteAndEnter();
}

async function typeTextAndEnter(text) {
  if (platform.typeText) {
    await platform.typeText(text);
    await delay(TEXT_PASTE_SETTLE_MS);
    await pressEnter();
    return;
  }
  await copyTextToClipboard(text);
  await pressPasteAndEnter();
}

async function pasteCodexCommandSelection(command, selection, options = {}) {
  if (platform.runCodexCommandSelection) {
    await platform.runCodexCommandSelection(command, selection, options);
    return;
  }
  await pasteTextAndEnter(command);
  await delay(options.commandSettleMs || CODEX_COMMAND_SETTLE_MS);
  await pasteTextAndEnter(selection);
  await delay(options.selectionSettleMs || CODEX_COMMAND_SETTLE_MS);
}

async function pressEnter() {
  return platform.pressEnter();
}

async function pressCodexShortcut(key, modifiers = []) {
  return platform.pressCodexShortcut(key, modifiers);
}

async function pressCancelCodexResponse() {
  return platform.pressCancelCodexResponse();
}

async function pressPaste() {
  return platform.pressPaste();
}

async function runCodexThreadCommand(threadId, command, options = {}) {
  return platform.withClipboardPreserved(async () => {
    if (threadId && !isCodexThreadId(threadId)) {
      const error = new Error('任务 ID 不正确。');
      error.status = 400;
      error.code = 'BAD_THREAD_ID';
      throw error;
    }
    await activateCodexThread(threadId);

    if (command === 'archive') {
      await pressCodexShortcut('a', ['command', 'shift']);
      await delay(CODEX_COMMAND_SETTLE_MS);
      return { message: '已归档当前 Codex 任务。' };
    }

    if (command === 'pin') {
      await pressCodexShortcut('p', ['command', 'option']);
      await delay(CODEX_COMMAND_SETTLE_MS);
      return { message: options.pinned ? '已置顶当前 Codex 任务。' : '已取消置顶当前 Codex 任务。' };
    }

    if (command === 'rename') {
      const name = String(options.name || '').replace(/\s+/g, ' ').trim();
      if (!name) {
        const error = new Error('新名称不能为空。');
        error.status = 400;
        error.code = 'EMPTY_THREAD_NAME';
        throw error;
      }
      if (name.length > 120) {
        const error = new Error('新名称太长，请控制在 120 个字符以内。');
        error.status = 400;
        error.code = 'THREAD_NAME_TOO_LONG';
        throw error;
      }
      await pressCodexShortcut('r', ['command', 'option']);
      await delay(CODEX_COMMAND_SETTLE_MS);
      await copyTextToClipboard(name);
      await pressPaste();
      await delay(120);
      await pressEnter();
      await delay(CODEX_COMMAND_SETTLE_MS);
      return { message: '已重命名当前 Codex 任务。', name };
    }

    const error = new Error('不支持的任务操作。');
    error.status = 400;
    error.code = 'BAD_THREAD_ACTION';
    throw error;
  });
}

async function handleNewCodexThread(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const target = resolveNewThreadTarget(payload);
    const project = classifyThreadProject(target.cwd);
    try {
      const started = await codexAppServer.startThread({ cwd: project.isProjectThread ? target.cwd : '' });
      const threadId = started.thread.id;
      invalidateCodexThreadListCache();
      return json(res, 200, {
        ok: true,
        pending: false,
        transport: 'app-server',
        threadId,
        cwd: project.isProjectThread ? target.cwd : '',
        projectName: project.projectName,
        projectPath: project.projectPath,
        projectKey: project.projectKey,
        scope: project.isProjectThread ? 'project' : 'conversation',
        message: project.isProjectThread
          ? `已在“${project.projectName}”中新建任务。`
          : '已新建一个对话任务。',
      });
    } catch (appServerError) {
      if (project.isProjectThread) {
        await activateNewCodexThread(target.cwd);
      } else {
        await activateNewProjectlessCodexThread(target.anchorThreadId);
      }
      return json(res, 200, {
        ok: true,
        pending: true,
        transport: 'desktop-gui',
        appServerError: appServerError.message || String(appServerError),
        cwd: project.isProjectThread ? target.cwd : '',
        projectName: project.projectName,
        projectPath: project.projectPath,
        projectKey: project.projectKey,
        scope: project.isProjectThread ? 'project' : 'conversation',
        message: project.isProjectThread
          ? `已在 ChatGPT Desktop 打开“${project.projectName}”的新任务。`
          : '已在 ChatGPT Desktop 打开一个新的对话任务。',
      });
    }
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '新建任务失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function handleThreadAction(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const action = String(payload.action || '').trim();
  if (!isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
  }

  try {
    const state = readCodexMiniState();
    let result;
    if (action === 'archive') {
      try {
        await codexAppServer.archiveThread(threadId);
        result = { message: '已归档当前任务。', transport: 'app-server' };
      } catch (appServerError) {
        result = await runCodexThreadCommand(threadId, 'archive');
        result.transport = 'desktop-gui';
        result.appServerError = appServerError.message || String(appServerError);
      }
      state.archivedThreadIds = setThreadSetMembership(state.archivedThreadIds, threadId, true);
      state.pinnedThreadIds = setThreadSetMembership(state.pinnedThreadIds, threadId, false);
    } else if (action === 'pin' || action === 'unpin') {
      const pinned = action === 'pin';
      try {
        await codexAppServer.setThreadPinned(threadId, pinned);
        result = {
          message: pinned ? '已置顶当前任务。' : '已取消置顶当前任务。',
          transport: 'app-server',
        };
      } catch (appServerError) {
        result = await runCodexThreadCommand(threadId, 'pin', { pinned });
        result.transport = 'desktop-gui';
        result.appServerError = appServerError.message || String(appServerError);
      }
      state.pinnedThreadIds = setThreadSetMembership(state.pinnedThreadIds, threadId, pinned);
    } else if (action === 'compact') {
      await codexAppServer.compactThread(threadId);
      result = {
        message: '已开始压缩当前任务的上下文。',
        transport: 'app-server',
      };
    } else if (action === 'review') {
      const review = await codexAppServer.startReview(threadId, {
        delivery: 'inline',
        target: { type: 'uncommittedChanges' },
      });
      result = {
        message: '已开始审查当前项目的未提交改动。',
        transport: 'app-server',
        turnId: review?.turn?.id || '',
        reviewThreadId: review?.reviewThreadId || threadId,
      };
    } else if (action === 'rename') {
      const name = String(payload.name || '').replace(/\s+/g, ' ').trim();
      if (!name) {
        return json(res, 400, { ok: false, code: 'EMPTY_THREAD_NAME', message: '新名称不能为空。' });
      }
      if (name.length > 120) {
        return json(res, 400, { ok: false, code: 'THREAD_NAME_TOO_LONG', message: '新名称太长，请控制在 120 个字符以内。' });
      }
      try {
        await codexAppServer.setThreadName(threadId, name);
        result = { message: '已重命名当前任务。', name, transport: 'app-server' };
      } catch (appServerError) {
        result = await runCodexThreadCommand(threadId, 'rename', { name });
        result.transport = 'desktop-gui';
        result.appServerError = appServerError.message || String(appServerError);
      }
      state.titleOverrides = state.titleOverrides || {};
      state.titleOverrides[threadId] = { name: result.name, renamedAt: new Date().toISOString() };
    } else {
      return json(res, 400, { ok: false, code: 'BAD_THREAD_ACTION', message: '不支持的任务操作。' });
    }
    writeCodexMiniState(state);
    const nextThreadId = action === 'archive' ? (listCodexThreads(120)[0]?.id || '') : threadId;
    return json(res, 200, { ok: true, action, threadId, nextThreadId, ...result });
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '任务操作失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function handleStopCodex(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  if (threadId && !isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '任务 ID 不正确。' });
  }

  try {
    const runtime = codexAppServer.runtimeForThread(threadId);
    if (threadId && runtime?.status === 'running' && runtime.activeTurnId) {
      await codexAppServer.interrupt(threadId, runtime.activeTurnId);
      return json(res, 200, { ok: true, threadId, transport: 'app-server', message: '已停止当前回复。' });
    }
    await stopCodexResponse(threadId);
    return json(res, 200, { ok: true, threadId, transport: 'desktop-gui', message: '已向 ChatGPT Desktop 发送停止指令。' });
  } catch (error) {
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function handleModelSwitch(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  const assumeThreadSynced = payload.assumeThreadSynced === true;
  try {
    if (isCodexThreadId(threadId) && target) {
      try {
        const models = await codexAppServer.listModels();
        const model = models.find(item => item.id === target || item.model === target);
        if (!model) {
          const error = new Error('未找到这个模型。');
          error.status = 400;
          error.code = 'MODEL_TARGET_NOT_FOUND';
          throw error;
        }
        const file = findCodexSessionFileByThreadId(threadId);
        const current = file ? currentModelFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : modelInfoFromId('');
        await codexAppServer.updateThreadSettings(threadId, { model: model.model || model.id });
        return json(res, 200, {
          ok: true,
          verified: true,
          transport: 'app-server',
          threadId,
          currentModel: current,
          targetModel: {
            available: true,
            key: model.id,
            id: model.id,
            label: labelFromModelName(model.displayName || model.id),
            displayName: model.displayName || model.id,
            source: 'app-server',
            updatedAt: new Date().toISOString(),
          },
          message: `后续回复将使用 ${model.displayName || model.id}`,
        });
      } catch (appServerError) {
        if (appServerError.status && appServerError.code !== 'MODEL_TARGET_NOT_FOUND') throw appServerError;
      }
    }
    const result = await switchCodexGuiModel(threadId, target, { assumeThreadSynced });
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '切换模型失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained, message: '没能通过 Codex GUI 切换模型。请确认 Codex Desktop 正在运行，且当前系统的自动化权限正常。' });
  }
}

async function handleReasoningMode(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  const assumeThreadSynced = payload.assumeThreadSynced === true;
  try {
    if (isCodexThreadId(threadId) && REASONING_MODE_TARGETS[target]) {
      try {
        const file = findCodexSessionFileByThreadId(threadId);
        const current = file ? currentReasoningModeFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : reasoningModeFromValue('');
        const targetMode = REASONING_MODE_TARGETS[target];
        await codexAppServer.updateThreadSettings(threadId, { effort: targetMode.value });
        return json(res, 200, {
          ok: true,
          verified: true,
          transport: 'app-server',
          threadId,
          currentReasoningMode: current,
          targetReasoningMode: { ...targetMode, available: true, updatedAt: new Date().toISOString() },
          message: `后续回复的推理等级为${targetMode.displayName}`,
        });
      } catch {}
    }
    const result = await switchCodexReasoningMode(threadId, target, { assumeThreadSynced });
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '切换推理模式失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained, message: '没能通过 Codex GUI 切换推理模式。请确认 Codex Desktop 正在运行，且当前系统的自动化权限正常。' });
  }
}

async function handleSend(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。请使用启动服务时打印出来的完整手机链接。' });
  }

  let payload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body || '{}');
  } catch (error) {
    return json(res, error.status || 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const text = typeof payload.text === 'string' ? payload.text : '';
  const target = payload.target === 'codex' ? 'codex' : 'frontmost';
  const selectedThreadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const assumeThreadSynced = payload.assumeThreadSynced === true;
  const expectNewThread = payload.expectNewThread === true && target === 'codex' && !selectedThreadId;
  const directPasteWithoutClick = process.platform === 'win32' && target === 'codex'
    ? payload.forceComposerClick !== true
    : payload.directPasteWithoutClick === true && expectNewThread;
  const previousThreadId = isCodexThreadId(payload.previousThreadId) ? payload.previousThreadId : '';
  const expectedNewThreadCwd = validLocalDirectory(typeof payload.expectedCwd === 'string' ? payload.expectedCwd : '');
  const clientRequestId = normalizeClientRequestId(payload.clientRequestId);
  cleanupRecentSendRequests();
  if (clientRequestId) {
    const existing = recentSendRequests.get(clientRequestId);
    if (existing?.result) return json(res, 200, { ...existing.result, duplicate: true });
    if (existing?.watch) {
      return json(res, 200, {
        ok: true,
        duplicate: true,
        message: '这条发送请求已经被接收，正在继续等待 Codex 回复。',
        target,
        sentAt: existing.sentAt,
        watch: existing.watch,
      });
    }
  }
  let attachments = [];
  try {
    attachments = decodeAttachments(payload.attachments);
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_ATTACHMENT', message: error.message || '图片附件不正确。' });
  }
  if (!text.trim() && !attachments.length) {
    return json(res, 400, { ok: false, code: 'EMPTY_TEXT', message: '请输入文字或添加图片。' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return json(res, 413, { ok: false, code: 'TEXT_TOO_LONG', message: `文字太长了，请控制在 ${MAX_TEXT_LENGTH} 字以内。` });
  }

  try {
    const watchSince = new Date(Date.now() - 750).toISOString();
    const watchSinceMs = Date.parse(watchSince) || Date.now();
    const watchFile = expectNewThread ? null : selectedThreadId ? findCodexSessionFileByThreadId(selectedThreadId) : findLatestCodexSessionFile();
    let watch = target === 'codex' ? {
      since: watchSince,
      threadId: selectedThreadId,
      sessionFile: watchFile ? path.basename(watchFile) : '',
      expectNewThread,
      excludeThreadId: expectNewThread ? previousThreadId : '',
      cwd: expectNewThread ? expectedNewThreadCwd : '',
    } : null;
    if (clientRequestId) {
      recentSendRequests.set(clientRequestId, {
        createdAt: Date.now(),
        sentAt: new Date().toISOString(),
        watch,
      });
    }
    const effectiveThreadId = selectedThreadId || (watchFile ? threadIdFromSessionFile(watchFile) : '');
    let directResult = null;
    let appServerError = null;
    if (target === 'codex') {
      const fileStatus = effectiveThreadId ? parseCodexStatus({ threadId: effectiveThreadId }) : null;
      const appRuntime = effectiveThreadId ? codexAppServer.runtimeForThread(effectiveThreadId) : null;
      const externallyActive = Boolean(fileStatus?.active && !(appRuntime?.status === 'running' && appRuntime.activeTurnId));
      if (!externallyActive) {
        try {
          directResult = await codexAppServer.sendTurn({
            threadId: effectiveThreadId,
            cwd: expectedNewThreadCwd,
            text,
            imagePaths: attachments.map(item => item.filePath),
            clientUserMessageId: clientRequestId || undefined,
          });
          const directThreadId = directResult.threadId;
          const directFile = findCodexSessionFileByThreadId(directThreadId);
          watch = {
            since: watchSince,
            threadId: directThreadId,
            sessionFile: directFile ? path.basename(directFile) : '',
            expectNewThread: false,
            excludeThreadId: '',
            cwd: '',
          };
        } catch (error) {
          appServerError = error;
        }
      }
    }

    if (!directResult) {
      const sendOptions = { assumeThreadSynced, expectNewThread, skipComposerClick: directPasteWithoutClick };
      await pasteAndEnter(text, target, attachments, effectiveThreadId, sendOptions);
    }
    if (!directResult && expectNewThread && watch) {
      const newSessionFile = await waitForCodexSessionFileForNewSend({
        sinceMs: watchSinceMs,
        text,
        cwd: expectedNewThreadCwd,
        excludeThreadId: previousThreadId,
      });
      if (newSessionFile) {
        watch = {
          ...watch,
          threadId: threadIdFromSessionFile(newSessionFile),
          sessionFile: path.basename(newSessionFile),
          expectNewThread: false,
          excludeThreadId: '',
        };
      }
    }
    const result = {
      ok: true,
      message: directResult
        ? (directResult.steered ? '已追加到正在运行的任务。' : '已通过 Codex App Server 发送。')
        : target === 'codex' ? '已发送到 ChatGPT Desktop。' : '已粘贴并按下回车。',
      target,
      transport: directResult ? 'app-server' : target === 'codex' ? 'desktop-gui' : 'frontmost',
      sentAt: new Date().toISOString(),
      attachments: attachments.map(item => ({ name: item.name, size: item.size, type: item.mime })),
      watch,
      focusFallback: '',
    };
    if (appServerError) result.appServerError = appServerError.message || String(appServerError);
    if (clientRequestId) {
      recentSendRequests.set(clientRequestId, {
        createdAt: Date.now(),
        sentAt: result.sentAt,
        watch,
        result,
      });
    }
    persistentQueue.logExecution(effectiveThreadId, 'send', 'completed', 0, '', { transport: result.transport, sentAt: result.sentAt });
    fireWebhook('send.completed', { threadId: effectiveThreadId || '', target, transport: result.transport });
    return json(res, 200, result);
  } catch (error) {
    if (clientRequestId) recentSendRequests.delete(clientRequestId);
    const explained = explainTargetError(error, target);
    persistentQueue.logExecution(effectiveThreadId || '', 'send', 'failed', 0, explained.message || error.message || String(error), {});
    fireWebhook('send.failed', { threadId: effectiveThreadId || '', target, error: explained.message || error.message || String(error) });
    return json(res, 500, { ok: false, ...explained });
  }
}

function sanitizeFileName(name, fallback = 'image') {
  const base = path.basename(String(name || fallback)).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return base || fallback;
}

function extensionForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/heic') return '.heic';
  return '.img';
}

function decodeAttachment(attachment, index) {
  const mime = String(attachment && attachment.type || '').toLowerCase();
  if (!mime.startsWith('image/')) throw new Error('目前只支持图片附件。');
  const dataUrl = String(attachment.dataUrl || '');
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('图片数据格式不正确。');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`单张图片太大，请控制在 ${formatBytes(MAX_ATTACHMENT_BYTES)} 以内。`);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = path.extname(attachment.name || '') || extensionForMime(mime);
  const fileName = `${Date.now()}-${index}-${sanitizeFileName(attachment.name || `image${ext}`)}`;
  const filePath = path.join(UPLOAD_DIR, fileName.endsWith(ext) ? fileName : `${fileName}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { filePath, mime, name: attachment.name || path.basename(filePath), size: buffer.length };
}

function decodeAttachments(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_ATTACHMENTS) throw new Error(`图片最多一次发送 ${MAX_ATTACHMENTS} 张。`);
  return input.map(decodeAttachment);
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function copyImageToClipboard(file) {
  return platform.copyImageToClipboard(file);
}

function modelSwitchTargetForCurrent(current = {}, requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  const catalogTarget = findModelOption(explicit);
  if (catalogTarget) return catalogTarget;
  if (!explicit) {
    const options = readModelCatalogOptions();
    if (options.length) return options[0];
  }
  const error = new Error(explicit ? '未找到这个模型。' : '没有读取到可切换的模型。');
  error.status = 400;
  error.code = 'MODEL_TARGET_NOT_FOUND';
  throw error;
}

async function switchCodexGuiModel(threadId = '', targetKey = '', options = {}) {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('任务 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
  const targetThreadId = threadId || (file ? threadIdFromSessionFile(file) : '');
  const current = file ? currentModelFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : modelInfoFromId('');
  const target = modelSwitchTargetForCurrent(current, targetKey);

  if (process.platform === 'win32') {
    await platform.runExclusive(async () => {
      if (!options.assumeThreadSynced && isCodexThreadId(targetThreadId)) {
        await activateCodexThread(targetThreadId, { allowCached: false });
      }
      await pasteCodexCommandSelection('/模型', target.displayName, {
        commandSettleMs: CODEX_MODEL_COMMAND_SETTLE_MS,
        selectionSettleMs: CODEX_COMMAND_SETTLE_MS,
        timeoutMs: 10000,
      });
    });
    return {
      ok: true,
      verified: false,
      threadId: targetThreadId,
      currentModel: current,
      targetModel: { ...target, available: true, updatedAt: new Date().toISOString() },
      focusFallback: '',
      message: `已向 Codex 发送模型切换命令：${target.displayName}`,
    };
  }

  return platform.withClipboardPreserved(async () => {
    await focusTarget('codex', targetThreadId, codexFocusOptions(targetThreadId));
    await pasteCodexCommandSelection('/模型', target.displayName, {
      commandSettleMs: CODEX_MODEL_COMMAND_SETTLE_MS,
      selectionSettleMs: CODEX_COMMAND_SETTLE_MS,
      timeoutMs: 10000,
    });
    const verifiedToolbar = await verifyWindowsToolbarSwitch('model', target);
    return {
      ok: true,
      verified: true,
      threadId: targetThreadId,
      currentModel: current,
      targetModel: { ...target, available: true, updatedAt: new Date().toISOString() },
      toolbar: verifiedToolbar || undefined,
      focusFallback: '',
      message: `已切换到 ${target.displayName}`,
    };
  });
}

function reasoningModeTargetForCurrent(current = {}, requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  if (REASONING_MODE_TARGETS[explicit]) return REASONING_MODE_TARGETS[explicit];
  const order = ['low', 'medium', 'high', 'xhigh'];
  const currentIndex = order.indexOf(current.key);
  const nextKey = order[(currentIndex + 1 + order.length) % order.length] || 'medium';
  return REASONING_MODE_TARGETS[nextKey] || REASONING_MODE_TARGETS.medium;
}

function createSwitchVerificationError(kind, expected, actual = {}) {
  const raw = actual && actual.raw ? `当前 Codex 显示为 ${actual.raw}` : '没有读到 Codex 底部模型/推理状态';
  const label = kind === 'model' ? '模型' : '推理模式';
  const error = new Error(`${label}没有实际切换成功，${raw}。`);
  error.status = 409;
  error.code = kind === 'model' ? 'MODEL_SWITCH_NOT_APPLIED' : 'REASONING_SWITCH_NOT_APPLIED';
  error.actual = actual;
  error.expected = expected;
  return error;
}

function modelLabelsMatch(expected = {}, actualLabel = '') {
  const actual = String(actualLabel || '').trim().toLowerCase();
  if (!actual) return false;
  const candidates = [
    expected.label,
    expected.displayName,
    expected.id,
    expected.key,
    labelFromModelName(expected.displayName || expected.id || expected.key || ''),
  ]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return candidates.some(value => value === actual || value.includes(actual) || actual.includes(value));
}

async function verifyWindowsToolbarSwitch(kind, target) {
  if (process.platform !== 'win32' || !platform.getToolbarState) return null;
  let state = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await delay(attempt ? 350 : 180);
    state = await platform.getToolbarState();
    if (kind === 'reasoning' && state && state.reasoningLabel === target.displayName) return state;
    if (kind === 'model' && state && modelLabelsMatch(target, state.modelLabel)) return state;
  }
  throw createSwitchVerificationError(kind, target, state);
}

async function switchCodexReasoningMode(threadId = '', targetKey = '', options = {}) {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('任务 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
  const targetThreadId = threadId || (file ? threadIdFromSessionFile(file) : '');
  const current = file ? currentReasoningModeFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : reasoningModeFromValue('');
  const target = reasoningModeTargetForCurrent(current, targetKey);

  if (process.platform === 'win32') {
    if (platform.switchReasoningMode) {
      try {
        const toolbar = await platform.runExclusive(async () => {
          if (!options.assumeThreadSynced && isCodexThreadId(targetThreadId)) {
            await activateCodexThread(targetThreadId, { allowCached: false });
          }
          return platform.switchReasoningMode(target.key);
        });
        return {
          ok: true,
          verified: true,
          threadId: targetThreadId,
          currentReasoningMode: current,
          targetReasoningMode: { ...target, available: true, updatedAt: new Date().toISOString() },
          toolbar,
          focusFallback: '',
          message: `已切换推理模式为 ${target.displayName}`,
        };
      } catch (error) {
        const wrapped = new Error(`CDP 推理模式切换失败：${error.message || '未知错误'}`);
        wrapped.status = error.code === 'CDP_BAD_REASONING_TARGET' ? 400 : 503;
        wrapped.code = error.code || 'CDP_REASONING_FAILED';
        throw wrapped;
      }
    }

    await platform.runExclusive(async () => {
      if (!options.assumeThreadSynced && isCodexThreadId(targetThreadId)) {
        await activateCodexThread(targetThreadId, { allowCached: false });
      }
      await pasteCodexCommandSelection('/推理模式', target.displayName, {
        commandSettleMs: CODEX_REASONING_COMMAND_SETTLE_MS,
        selectionSettleMs: CODEX_COMMAND_SETTLE_MS,
        timeoutMs: 10000,
      });
    });
    return {
      ok: true,
      verified: false,
      threadId: targetThreadId,
      currentReasoningMode: current,
      targetReasoningMode: { ...target, available: true, updatedAt: new Date().toISOString() },
      focusFallback: '',
      message: `已向 Codex 发送推理模式切换命令：${target.displayName}`,
    };
  }

  return platform.withClipboardPreserved(async () => {
    await focusTarget('codex', targetThreadId, codexFocusOptions(targetThreadId));
    await pasteCodexCommandSelection('/推理模式', target.displayName, {
      commandSettleMs: CODEX_REASONING_COMMAND_SETTLE_MS,
      selectionSettleMs: CODEX_COMMAND_SETTLE_MS,
      timeoutMs: 10000,
    });
    const verifiedToolbar = await verifyWindowsToolbarSwitch('reasoning', target);
    return {
      ok: true,
      verified: true,
      threadId: targetThreadId,
      currentReasoningMode: current,
      targetReasoningMode: { ...target, available: true, updatedAt: new Date().toISOString() },
      toolbar: verifiedToolbar || undefined,
      focusFallback: '',
      message: `已切换推理模式为 ${target.displayName}`,
    };
  });
}

async function stopCodexResponse(threadId = '') {
  return platform.runExclusive(async () => {
    await focusTarget('codex', threadId, codexFocusOptions(threadId));
    await pressCancelCodexResponse();
  });
}

module.exports = {
  normalizeClientRequestId,
  cleanupRecentSendRequests,
  runProcess,
  explainAutomationError,
  explainTargetError,
  copyTextToClipboard,
  getClickTool,
  toCliclickAbsolutePoint,
  delay,
  hasFreshCodexThreadActivation,
  focusTarget,
  codexFocusOptions,
  activateCodexThread,
  activateNewCodexThread,
  activateNewProjectlessCodexThread,
  normalizeNewThreadScope,
  projectCwdOrEmpty,
  resolveNewThreadTarget,
  pasteAndEnter,
  pasteTextAndEnter,
  typeTextAndEnter,
  pasteCodexCommandSelection,
  pressEnter,
  pressCodexShortcut,
  pressCancelCodexResponse,
  pressPaste,
  runCodexThreadCommand,
  handleNewCodexThread,
  handleThreadAction,
  handleStopCodex,
  handleModelSwitch,
  handleReasoningMode,
  handleSend,
  sanitizeFileName,
  extensionForMime,
  decodeAttachment,
  decodeAttachments,
  appleScriptString,
  copyImageToClipboard,
  modelSwitchTargetForCurrent,
  switchCodexGuiModel,
  reasoningModeTargetForCurrent,
  createSwitchVerificationError,
  modelLabelsMatch,
  verifyWindowsToolbarSwitch,
  switchCodexReasoningMode,
  stopCodexResponse,
};
