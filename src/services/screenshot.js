'use strict';

async function handleScreenshot(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  let cdp = null;
  if (platform.cdpStatus) {
    try { cdp = await platform.cdpStatus(); } catch (error) { cdp = { available: false, code: error.code || 'CDP_STATUS_FAILED', message: error.message || '浏览器状态读取失败。' }; }
  }
  if (!cdp || !cdp.available) {
    return json(res, 503, { ok: false, available: false, code: cdp?.code || 'CDP_UNAVAILABLE', message: cdp?.message || 'CDP 不可用，无法获取屏幕截图。' });
  }
  if (typeof platform.captureCdpScreenshot !== 'function') {
    return json(res, 503, { ok: false, available: false, code: 'CDP_SCREENSHOT_UNSUPPORTED', message: '当前平台不支持 CDP 截图。' });
  }
  const cacheKey = `${cdp.port || ''}:${cdp.targetUrl || ''}`;
  const now = Date.now();
  const cached = screenshotCache.get(cacheKey);
  if (cached && now - cached.capturedAt <= SCREENSHOT_CACHE_TTL_MS) {
    const body = Buffer.from(cached.data, 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': body.length,
      'Cache-Control': `private, max-age=${Math.max(1, Math.floor(SCREENSHOT_CACHE_TTL_MS / 1000))}`,
      'X-Screenshot-Cache': 'hit',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return;
  }
  // 并发去重：同一 target 的重复请求等待在途截图，避免连续点击触发多次真实捕获
  if (screenshotCacheBusy.has(cacheKey)) {
    try { await screenshotCacheBusy.get(cacheKey); } catch {}
    const retried = screenshotCache.get(cacheKey);
    if (retried) {
      const body = Buffer.from(retried.data, 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': body.length,
        'Cache-Control': `private, max-age=${Math.max(1, Math.floor(SCREENSHOT_CACHE_TTL_MS / 1000))}`,
        'X-Screenshot-Cache': 'hit',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
      return;
    }
    return json(res, 503, { ok: false, available: false, code: 'CDP_SCREENSHOT_FAILED', message: '截图请求正在处理但结果不可用，请重试。' });
  }
  let shot;
  const inflight = platform.captureCdpScreenshot().then(result => { shot = result; }, error => { shot = null; throw error; });
  screenshotCacheBusy.set(cacheKey, inflight);
  try {
    await inflight;
  } catch (error) {
    return json(res, 502, { ok: false, available: false, code: error.code || 'CDP_SCREENSHOT_FAILED', message: error.message || '截图失败。' });
  } finally {
    screenshotCacheBusy.delete(cacheKey);
  }
  if (!shot || typeof shot.data !== 'string' || !shot.data) {
    return json(res, 502, { ok: false, available: false, code: 'CDP_SCREENSHOT_EMPTY', message: '截图未返回图像数据。' });
  }
  const body = Buffer.from(shot.data, 'base64');
  if (!body.length || body.length > MAX_SCREENSHOT_BYTES) {
    return json(res, 502, { ok: false, available: false, code: 'CDP_SCREENSHOT_TOO_LARGE', message: '截图数据异常，请重试。' });
  }
  boundedSet(screenshotCache, cacheKey, { data: shot.data, width: Number(shot.width) || 0, height: Number(shot.height) || 0, capturedAt: Date.now() }, 12);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': body.length,
    'Cache-Control': `private, max-age=${Math.max(1, Math.floor(SCREENSHOT_CACHE_TTL_MS / 1000))}`,
    'X-Screenshot-Cache': 'miss',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

module.exports = {
  handleScreenshot,
};
