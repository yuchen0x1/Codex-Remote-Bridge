'use strict';

const { get } = require('./context');

const json = (...args) => get().json(...args);
const isAuthorized = (req) => get().isAuthorized(req);
const persistentQueue = () => get().persistentQueue;
const latencySummary = () => get().latencySummary;
const rotateAccessToken = () => get().rotateAccessToken;
const getLanUrls = () => get().getLanUrls;

function normalizeLogRow(row = {}) {
  return {
    threadId: row.thread_id ?? row.threadId ?? '',
    action: row.action ?? '',
    status: row.status ?? '',
    durationMs: row.duration_ms ?? row.durationMs ?? 0,
    error: row.error ?? '',
    createdAt: row.created_at ?? row.createdAt ?? '',
  };
}

async function handleStats(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  try {
    const logs = (persistentQueue().getLogs(1000) || []).map(normalizeLogRow);
    const now = Date.now();
    const dayStart = new Date(now - 24 * 3600 * 1000).toISOString();
    const weekStart = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

    let completed = 0;
    let failed = 0;
    const byAction = {};
    let todayCount = 0;
    let weekCount = 0;
    for (const log of logs) {
      const time = Date.parse(log.createdAt);
      if (log.status === 'completed') completed += 1;
      if (log.status === 'failed') failed += 1;
      byAction[log.action] = (byAction[log.action] || 0) + 1;
      if (time >= Date.parse(dayStart)) todayCount += 1;
      if (time >= Date.parse(weekStart)) weekCount += 1;
    }

    const successRate = completed + failed > 0 ? Math.round((completed / (completed + failed)) * 1000) / 10 : 0;
    return json(res, 200, {
      ok: true,
      queue: persistentQueue().getQueueStatus(),
      totals: { total: logs.length, completed, failed, successRate },
      timeRange: { today: todayCount, week: weekCount },
      byAction,
      latency: latencySummary(),
      recent: logs.slice(0, 20),
    });
  } catch (error) {
    return json(res, 500, { ok: false, code: 'STATS_FAILED', message: error.message || '统计失败。' });
  }
}

async function handleRotateToken(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  const nextToken = rotateAccessToken();
  return json(res, 200, {
    ok: true,
    token: nextToken,
    urls: getLanUrls(),
    message: '访问令牌已轮换，请使用新的链接重新连接。',
  });
}

module.exports = {
  normalizeLogRow,
  handleStats,
  handleRotateToken,
};
