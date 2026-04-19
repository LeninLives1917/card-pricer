// Card Pricer service worker — minimal offline shell + stale-while-revalidate
// for static assets. API calls always go to the network (we never want stale
// prices). If the network fails for the shell, we serve the cached index so
// the app still opens on flaky venue wifi.

const CACHE_VERSION = 'cardpricer-v12';
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

  // Static shell & assets: stale-while-revalidate.
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
