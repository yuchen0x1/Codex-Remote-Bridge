'use strict';

/* Codex Remote Bridge - PWA Service Worker
 * 策略：网络优先 + 缓存回退（本地服务响应快，断网时复用缓存）
 * 只处理同源 GET 静态资源，API 请求一律不拦截。
 */

const CACHE_NAME = 'codex-remote-bridge-v2';

const PRECACHE_URLS = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('codex-remote-bridge-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never persist connection credentials or one-time pairing codes as cache keys.
  if (url.searchParams.has('token') || url.searchParams.has('pair')) return;
  if (url.pathname.startsWith('/codex/') || url.pathname.startsWith('/send') || url.pathname.startsWith('/upload')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
