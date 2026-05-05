// Card Pricer V2 service worker.
//
// Strategy (audit §1e + §5.8 + R7):
//   - Shell (HTML + manifest): network-first with cache fallback. Online
//     users always get the latest deploy; offline users get last-known-good.
//   - Other same-origin static assets: stale-while-revalidate.
//   - /api/*, SSE, POST, cross-origin: never intercepted — always live.
//
// CACHE_VERSION must change every time the served HTML changes (audit R7).
// V1 = 'cardpricer-v60'; V2 ships as 'cardpricer-v2'.
// Bumps:
//   v2.1 — customer-PDF export landed (412c367 + iframe-load fix). The
//           stale-while-revalidate strategy was serving cached pre-PDF
//           session.js to existing clients, so the button click did
//           nothing because no handler was wired. Bumping the version
//           evicts every cached module on next load.

const CACHE_VERSION = 'cardpricer-v2.1';

const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
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

  // API + SSE + POST: always live.
  if (url.pathname.startsWith('/api/')) return;

  // Cross-origin: let the browser handle it.
  if (url.origin !== self.location.origin) return;

  // Shell: network-first.
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

  // Static assets (CSS / module JS / images): stale-while-revalidate.
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
