'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { formatBytes, validLocalDirectory } = require('./core');
const { json, readBody, existingProjectCwds } = require('../routes');
const { latestAndroidApkInfo, latestWindowsInstallerInfo } = require('./config');

const MAX_DOWNLOAD_BYTES = Number(process.env.CODEX_MAX_MAX_DOWNLOAD_BYTES || process.env.CODEX_MINI_MAX_DOWNLOAD_BYTES || 20 * 1024 * 1024);
const DIST_DIR = path.join(__dirname, '..', '..', 'dist');
const DIST_ANDROID_DIR = path.join(DIST_DIR, 'android');
const DIST_WINDOWS_INSTALLER_DIR = path.join(DIST_DIR, 'windows', 'installer');
const DOWNLOAD_MIME_BY_EXT = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

function isAuthorized(req) { return false; }
async function listWorkspaceThreads(limit) { return { threads: [] }; }

function downloadMimeFor(filePath) {
  return DOWNLOAD_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function downloadSafeName(fileName) {
  return String(fileName || 'download').replace(/[\"\r\n\\/]/g, '_');
}

async function handleFileDownload(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cwdValue = String(url.searchParams.get('cwd') || '').trim();
  const relativePath = String(url.searchParams.get('file') || '').trim();
  if (!cwdValue || !relativePath) return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '缺少 cwd 或 file 参数。' });
  if (path.isAbsolute(relativePath)) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '仅允许下载工作区内的相对路径文件。' });
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '文件路径不能包含上级目录。' });
  let workspace = { threads: [] };
  try { workspace = await listWorkspaceThreads(160); } catch {}
  const projects = existingProjectCwds(workspace.threads);
  if (!projects.includes(cwdValue)) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '目标目录不在可下载白名单内。' });
  const resolved = path.resolve(cwdValue, relativePath);
  const withinRoot = path.relative(cwdValue, resolved);
  if (withinRoot.startsWith('..') || path.isAbsolute(withinRoot)) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '文件路径超出工作区范围。' });
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { return json(res, 404, { ok: false, code: 'DOWNLOAD_NOT_FOUND', message: '文件不存在。' }); }
  if (!stat.isFile() || stat.isSymbolicLink()) return json(res, 403, { ok: false, code: 'DOWNLOAD_FORBIDDEN', message: '仅允许下载普通文件。' });
  if (stat.size > MAX_DOWNLOAD_BYTES) return json(res, 413, { ok: false, code: 'DOWNLOAD_TOO_LARGE', message: `文件大小超过 ${formatBytes(MAX_DOWNLOAD_BYTES)} 上限。` });
  const fileName = path.basename(resolved);
  res.writeHead(200, {
    'Content-Type': downloadMimeFor(resolved),
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${downloadSafeName(fileName)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(resolved).on('error', () => res.destroy()).pipe(res);
}

async function handleDownload(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (String(url.searchParams.get('cwd') || '').trim()) return handleFileDownload(req, res);
  const kind = String(url.searchParams.get('file') || '');
  if (kind === 'android') {
    const info = latestAndroidApkInfo();
    if (!info) return json(res, 404, { ok: false, code: 'UPDATE_NOT_FOUND', message: '没有可用的 Android 安装包。' });
    const filePath = path.join(DIST_ANDROID_DIR, info.name);
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${info.name}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    } catch {
      return json(res, 404, { ok: false, code: 'UPDATE_NOT_FOUND', message: 'Android 安装包不可用。' });
    }
    return;
  }
  if (kind === 'windows-installer') {
    const info = latestWindowsInstallerInfo();
    if (!info) return json(res, 404, { ok: false, code: 'UPDATE_NOT_FOUND', message: '没有可用的 Windows 安装包。' });
    const filePath = path.join(DIST_WINDOWS_INSTALLER_DIR, info.name);
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${info.name}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    } catch {
      return json(res, 404, { ok: false, code: 'UPDATE_NOT_FOUND', message: 'Windows 安装包不可用。' });
    }
    return;
  }
  return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '未知的下载类型。' });
}

module.exports = {
  DOWNLOAD_MIME_BY_EXT,
  downloadMimeFor,
  downloadSafeName,
  handleFileDownload,
  handleDownload,
};
