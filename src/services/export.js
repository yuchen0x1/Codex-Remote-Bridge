'use strict';

const { isCodexThreadId } = require('./core');
const { get } = require('./context');
const { MAX_HISTORY_MESSAGES, historyFromAppServerThread, parseCodexThreadHistory } = require('./history');

const json = (...args) => get().json(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const codexAppServer = () => get().codexAppServer;

function buildMarkdownExport(threadId, data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const lines = [
    '# Codex 对话导出',
    '',
    `- 任务 ID：${threadId}`,
    `- 导出时间：${new Date().toISOString()}`,
    `- 消息数：${messages.length}`,
    '',
  ];
  for (const row of messages) {
    const roleLabel = row?.role === 'user' ? '用户' : 'Codex Remote Bridge';
    const time = row?.timestamp ? `（${row.timestamp}）` : '';
    lines.push(`## ${roleLabel}${time}`, '');
    const text = String(row?.text || '').replace(/\r\n/g, '\n').trim();
    lines.push(text || '（无文本）');
    if (Array.isArray(row?.attachments) && row.attachments.length) {
      for (const attachment of row.attachments) {
        const name = attachment?.name ? ` ${attachment.name}` : '';
        const url = attachment?.url ? `（${attachment.url}）` : '';
        lines.push(`- 附件${name}${url}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function handleExport(req, res) {
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
    let data;
    try {
      const thread = await codexAppServer().readThread(threadId, true);
      data = historyFromAppServerThread(thread, limit);
    } catch (appServerError) {
      data = parseCodexThreadHistory(threadId, limit);
    }
    const markdown = buildMarkdownExport(threadId, data);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const fileName = `codex-thread-${threadId.slice(0, 8)}-${stamp}.md`;
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': Buffer.byteLength(markdown),
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    });
    res.end(markdown);
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_EXPORT_FAILED', message: '导出对话失败。', detail: String(error && error.message || error) });
  }
}

module.exports = {
  buildMarkdownExport,
  handleExport,
};
