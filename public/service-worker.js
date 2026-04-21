// Card Pricer service worker.
//
// Strategy:
//   - Shell (HTML + manifest): **network-first** with cache fallback. Online
//     users always get the latest deploy; offline users get the last-known-good
//     shell. This prevents the "stuck on old version" failure mode where a
//     cached SW keeps serving stale HTML even after a fresh deploy lands.
//   - Other same-origin static assets: stale-while-revalidate (fast repeat
//     loads, refreshed in the background).
//   - /api/*, SSE, POST, cross-origin: never intercepted — always live.

const CACHE_VERSION = 'cardpricer-v58';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API, SSE, and POST: never cache — always live.
  if (url.pathname.startsWith('/api/')) return;

  // Cross-origin (Tesseract, jsdelivr, api.qrserver): let the browser handle it.
  if (url.origin !== self.location.origin) return;

  // Shell: network-first. A cached shell is only used if the network fails.
  const isShell =
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.json';
  if (isShell) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return resp;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Other static assets: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((resp) => {
          if (resp && resp.ok) cache.put(request, resp.clone());
          return resp;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
