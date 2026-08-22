'use strict';

const fs = require('fs');
const { get } = require('./context');
const { historyAttachmentCache, historyAttachmentIdByPath, MAX_HISTORY_MESSAGES } = require('./history');

const json = (...args) => get().json(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const MAX_ATTACHMENT_BYTES = Number(process.env.CODEX_MAX_MAX_ATTACHMENT_BYTES || process.env.CODEX_MINI_MAX_ATTACHMENT_BYTES || 8 * 1024 * 1024);

function handleHistoryAttachment(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const id = String(url.searchParams.get('id') || '');
  const item = historyAttachmentCache.get(id);
  if (!item || item.expiresAt <= Date.now()) {
    historyAttachmentCache.delete(id);
    if (item) historyAttachmentIdByPath.delete(item.filePath);
    return json(res, 404, { ok: false, code: 'ATTACHMENT_NOT_FOUND', message: '图片预览已失效，请刷新任务记录。' });
  }
  try {
    const stat = fs.lstatSync(item.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) throw new Error('图片文件不可用。');
    res.writeHead(200, { 'Content-Type': item.mime, 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(item.filePath).on('error', () => res.destroy()).pipe(res);
  } catch {
    historyAttachmentCache.delete(id);
    historyAttachmentIdByPath.delete(item.filePath);
    return json(res, 404, { ok: false, code: 'ATTACHMENT_NOT_FOUND', message: '图片文件不可用。' });
  }
}

module.exports = {
  handleHistoryAttachment,
};
