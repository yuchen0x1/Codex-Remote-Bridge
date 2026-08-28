'use strict';

/**
 * HTTP 路由处理模块 - 统一的路由注册与分发中枢
 *
 * 设计说明（v4.0.0）：
 * - server.js 只负责构建 API 路由表（method + prefix + handler），本模块负责匹配分发。
 * - 前缀匹配（startsWith）语义与历史版本保持一致，避免行为变化。
 * - 静态文件、OPTIONS、token cookie 等由 server.js 通过 staticHandler 委托，避免重复实现。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

function resolveStaticFilePath(rootDir, pathname) {
  const relativePath = String(pathname || '/').replace(/^\/+/, '') || 'index.html';
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..' || segment.includes('\0'))) return '';
  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, ...segments);
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? filePath : '';
}

// Helpers
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...(res._corsHeaders || {}),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, maxBytes = 28 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      reject(error);
    };
    const onData = chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(Object.assign(new Error('请求体过大。'), { status: 413, code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = error => fail(error);
    const timer = setTimeout(() => fail(Object.assign(new Error('请求读取超时。'), { status: 408, code: 'BODY_TIMEOUT' })), 30000);
    if (timer.unref) timer.unref();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function getClientIp(req) {
  return (req.socket?.remoteAddress || '').replace('::ffff:', '') || '';
}

function getTokenFromRequest(req) {
  const header = String(req.headers?.['x-mobile-typer-token'] || '');
  if (header) return header;
  try {
    const token = new URL(req.url, `http://${req.headers?.host || 'localhost'}`).searchParams.get('token');
    if (token) return token;
  } catch {}
  return '';
}

/**
 * 计算 CORS 安全头。
 * - 有 Origin（浏览器跨域）：仅放行回环地址或与请求 Host 同源的 Origin（局域网手机 WebView 场景），回显 Origin 而不是 *
 * - 无 Origin（curl / 服务端 / 同源请求）：放行 *，保持兼容
 * 附带安全头：nosniff、referrer-policy、vary。
 */
function corsHeaders(req) {
  const requestOrigin = String(req?.headers?.origin || '').trim();
  const requestHost = String(req?.headers?.host || '').toLowerCase();
  let allowOrigin = '';
  if (requestOrigin) {
    let originHost = '';
    try { originHost = new URL(requestOrigin).host.toLowerCase(); } catch {}
    if (originHost && (originHost === requestHost || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(originHost))) {
      allowOrigin = requestOrigin;
    }
  } else {
    allowOrigin = '*';
  }
  const headers = {
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-mobile-typer-token,x-codex-session',
    'access-control-allow-private-network': 'true',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    vary: 'Origin',
  };
  if (allowOrigin) headers['access-control-allow-origin'] = allowOrigin;
  return headers;
}

function displayPathName(cwd) {
  if (!cwd) return '对话';
  const normalized = path.normalize(cwd);
  if (normalized === os.homedir()) return '~';
  if (normalized === path.parse(normalized).root) return normalized;
  return path.basename(normalized) || normalized;
}

function existingProjectCwds(threads) {
  const seen = new Set();
  const out = [];
  for (const thread of threads) {
    if (!thread.isProjectThread || !thread.projectPath) continue;
    if (seen.has(thread.projectPath)) continue;
    seen.add(thread.projectPath);
    out.push(thread.projectPath);
  }
  return out;
}

class Router {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.security = options.security;
    // 精确/正则路由（保留通用匹配能力）
    this.routes = [];
    // 前缀路由（与历史 startsWith 语义一致，是 server.js 主要使用的形式）
    this.prefixRoutes = [];
    // 静态文件处理器（由 server.js 委托，保留 token cookie / HEAD 等行为）
    this.staticHandler = options.staticHandler || null;
    this.publicDir = options.publicDir || path.join(__dirname, '..', 'public');
    this.distDir = options.distDir || path.join(__dirname, '..', 'dist');
    this.serviceVersion = options.serviceVersion || '0.0.0';
  }

  // ---- Route Registration ----

  use(method, pattern, handler) {
    this.routes.push({ method, pattern, handler });
  }

  get(pattern, handler) { this.use('GET', pattern, handler); }
  post(pattern, handler) { this.use('POST', pattern, handler); }
  delete(pattern, handler) { this.use('DELETE', pattern, handler); }

  /**
   * 注册前缀路由。method 支持 'GET' | 'POST' | '*'。
   * handler 签名与历史一致：(req, res) => void
   */
  prefix(method, prefix, handler) {
    this.prefixRoutes.push({ method, prefix, handler });
  }

  registerPrefixRoutes(table) {
    for (const item of table || []) {
      this.prefixRoutes.push({ method: item.method, prefix: item.prefix, handler: item.handler });
    }
  }

  _match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (typeof route.pattern === 'string') {
        if (route.pattern === pathname) return { handler: route.handler, params: {} };
      } else if (route.pattern instanceof RegExp) {
        const match = pathname.match(route.pattern);
        if (match) return { handler: route.handler, params: match.groups || {} };
      }
    }
    return null;
  }

  _matchPrefix(method, pathname) {
    for (const route of this.prefixRoutes) {
      if (route.method !== '*' && route.method !== method) continue;
      if (pathname.startsWith(route.prefix)) return route.handler;
    }
    return null;
  }

  // ---- Dispatch ----

  async dispatch(req, res) {
    const startTime = Date.now();
    let pathname = '';
    try {
      pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
      this.logger.warn('bad_request_url', { host: String(req.headers.host || '') });
      return json(res, 400, { ok: false, code: 'BAD_URL', message: '请求地址不正确。' });
    }

    // 限流（健康检查豁免，与历史行为一致；IP + token 双维度）
    if (pathname !== '/codex/health' && this.security) {
      const ip = getClientIp(req);
      if (!this.security.rateLimitCheck(ip, getTokenFromRequest(req))) {
        this.logger.warn('rate_limited', { ip, path: pathname });
        return json(res, 429, { ok: false, code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' });
      }
    }

    // P2-3：只读 token 拒绝写方法（GET/HEAD/OPTIONS 外一律 403）
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && this.security?.tokenScopeFromRequest) {
      if (this.security.tokenScopeFromRequest(req) === 'read-only') {
        this.logger.warn('write_denied_readonly', { ip: getClientIp(req), path: pathname });
        return json(res, 403, { ok: false, code: 'TOKEN_READ_ONLY', message: '只读令牌不能执行写操作。' });
      }
    }

    // 1) 精确/正则路由
    const match = this._match(req.method, pathname) || this._match('*', pathname);
    if (match) {
      try {
        const result = await match.handler(req, res, match.params);
        this.logger.logRequest?.(req, res.statusCode || 200, Date.now() - startTime);
        return result;
      } catch (error) {
        this.logger.error('route_error', { path: pathname, error: error.message, stack: error.stack });
        if (!res.headersSent) {
          return json(res, error?.status || 500, { ok: false, code: error?.code || 'INTERNAL_ERROR', message: error.message || '服务器内部错误。' });
        }
      }
      return;
    }

    // 2) 前缀路由（server.js API 表）
    const prefixHandler = this._matchPrefix(req.method, pathname);
    if (prefixHandler) {
      try {
        const result = await prefixHandler(req, res);
        this.logger.logRequest?.(req, res.statusCode || 200, Date.now() - startTime);
        return result;
      } catch (error) {
        this.logger.error('route_error', { path: pathname, error: error.message, stack: error.stack });
        if (!res.headersSent) {
          return json(res, error?.status || 500, { ok: false, code: error?.code || 'INTERNAL_ERROR', message: error.message || '服务器内部错误。' });
        }
      }
      return;
    }

    // 3) 静态文件（GET/HEAD）
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (this.staticHandler) return this.staticHandler(req, res);
      return this._serveStatic(req, res, pathname);
    }

    // 4) 其余方法一律 405
    return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  }

  // ---- 内置静态服务（未委托时使用）----

  _serveStatic(req, res, pathname) {
    const safePath = resolveStaticFilePath(this.publicDir, pathname === '/' ? 'index.html' : pathname);
    if (!safePath) return json(res, 403, { ok: false, message: '禁止访问。' });
    fs.readFile(safePath, (err, data) => {
      if (err) {
        const distPath = resolveStaticFilePath(this.distDir, pathname === '/' ? 'index.html' : pathname);
        if (distPath) {
          fs.readFile(distPath, (err2, data2) => {
            if (err2) return json(res, 404, { ok: false, message: '文件不存在。' });
            const ext = path.extname(distPath).toLowerCase();
            const mime = this._getMime(ext);
            res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data2.length });
            res.end(data2);
          });
          return;
        }
        return json(res, 404, { ok: false, message: '文件不存在。' });
      }
      const ext = path.extname(safePath).toLowerCase();
      const mime = this._getMime(ext);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': pathname === '/' ? 'no-store' : 'public, max-age=3600' });
      res.end(data);
    });
  }

  _getMime(ext) {
    const mimes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.map': 'application/json',
    };
    return mimes[ext] || 'application/octet-stream';
  }
}

module.exports = { Router, json, readBody, getClientIp, getTokenFromRequest, corsHeaders, displayPathName, existingProjectCwds };
