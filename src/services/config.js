'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

async function handleClientConfig(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const extraHeaders = {};
  const sessionToken = security.sessionTokenFromRequest(req);
  if (security.sessionFromRequest(req)) {
    if (sessionToken) {
      extraHeaders['set-cookie'] = [sessionManager.sessionCookie(sessionToken), 'codexMiniToken=; Path=/; Max-Age=0; SameSite=Lax'];
    }
  } else {
    const created = sessionManager.createSession(req.headers['user-agent'] || '', { scope: security.tokenScopeFromRequest(req) });
    extraHeaders['set-cookie'] = [sessionManager.sessionCookie(created.token), 'codexMiniToken=; Path=/; Max-Age=0; SameSite=Lax'];
  }
  let modelOptions = readModelCatalogOptions();
  let transport = 'session-files';
  try {
    const models = await codexAppServer.listModels();
    if (models.length) {
      const appServerModels = models.map(model => ({
        key: model.id,
        id: model.id,
        label: labelFromModelName(model.displayName || model.id),
        displayName: model.displayName || model.id,
        source: 'app-server',
        isDefault: model.isDefault === true,
        supportedReasoningEfforts: normalizeSupportedReasoningEfforts(model.supportedReasoningEfforts),
      }));
      modelOptions = mergeModelOptions(modelOptions, appServerModels);
      transport = 'app-server';
    }
  } catch {}
  return json(res, 200, {
    ok: true,
    service: 'codex-max',
    appName: APP_NAME,
    localOnly: true,
    scope: security.tokenScopeFromRequest(req),
    localApiBases: getLanApiBases(),
    transport,
    modelOptions,
    reasoningOptions: Object.values(REASONING_MODE_TARGETS),
    update: updateInfo(),
  }, extraHeaders);
}

async function handleHealth(req, res) {
  // 健康检查不需要鉴权（用于监控），但返回信息有限
  const authorized = isAuthorized(req);
  let cdp = null;
  if (platform.cdpStatus) {
    try {
      cdp = await platform.cdpStatus();
    } catch (error) {
      cdp = {
        available: false,
        code: error.code || 'CDP_STATUS_FAILED',
        message: error.message || 'CDP 状态读取失败。',
      };
    }
  }
  const mem = process.memoryUsage();
  const base = {
    ok: true,
    service: APP_NAME,
    version: SERVICE_VERSION,
    host: os.hostname(),
    platform: platform.name,
    now: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  };
  if (!authorized) {
    // 未鉴权请求只返回基础信息
    return json(res, 200, base);
  }
  return json(res, 200, {
    ...base,
    controlMode: codexAppServer.isAvailable() ? 'app-server' : cdp && cdp.available ? 'cdp' : 'gui',
    appServer: codexAppServer.status(),
    cdp,
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    nodeVersion: process.versions.node,
    scheduledTasks: scheduler.getTasks().length,
    activeScheduledTasks: scheduler.getTasks().filter(t => t.enabled).length,
  });
}

function updateInfo() {
  const android = latestAndroidApkInfo();
  const windows = latestWindowsInstallerInfo();
  return {
    service: SERVICE_VERSION,
    android: android ? { latestVersion: android.version, fileName: android.name, available: true } : { available: false },
    windows: windows ? { latestVersion: windows.version, fileName: windows.name, size: windows.size, available: true } : { available: false },
  };
}

function latestAndroidApkInfo() {
  let best = null;
  try {
    for (const entry of fs.readdirSync(DIST_ANDROID_DIR, { withFileTypes: true })) {
      const match = /^ChatGPT-AZ-Android-v([\d.]+)\.apk$/i.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const candidate = { version: match[1], name: entry.name };
      if (!best || compareVersions(candidate.version, best.version) > 0) best = candidate;
    }
  } catch {}
  return best;
}

function latestWindowsInstallerInfo() {
  try {
    const candidates = [
      'Codex-Remote-Bridge-Windows-Setup.exe',
      'ChatGPT-Win-Windows-Setup.exe',
    ];
    for (const name of candidates) {
      const file = path.join(DIST_WINDOWS_INSTALLER_DIR, name);
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      return { version: SERVICE_VERSION, name, size: stat.size };
    }
  } catch {}
  return null;
}

function compareVersions(a, b) {
  const ap = parseVersionParts(a);
  const bp = parseVersionParts(b);
  for (let i = 0; i < Math.max(ap.length, bp.length); i += 1) {
    const diff = (ap[i] || 0) - (bp[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseVersionParts(version) {
  return String(version || '').split('.').map(part => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function getLanApiBases() {
  const nets = os.networkInterfaces();
  const bases = new Set();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) bases.add(`http://${net.address}:${PORT}`);
    }
  }
  return [...bases];
}

function getLanUrls() {
  const nets = os.networkInterfaces();
  const urls = new Set([`http://localhost:${PORT}/?token=${TOKEN}`]);
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.add(`http://${net.address}:${PORT}/?token=${TOKEN}`);
      }
    }
  }
  return [...urls];
}

module.exports = {
  handleClientConfig,
  handleHealth,
  updateInfo,
  latestAndroidApkInfo,
  latestWindowsInstallerInfo,
  compareVersions,
  parseVersionParts,
  getLanApiBases,
  getLanUrls,
};
