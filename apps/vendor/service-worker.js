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
//   v3.1 — scanner-mode live camera (modules/capture.js, new) + the pair.js
//           envelope fix. Same trap as v2.1: without this bump a phone that
//           has already opened the app keeps its cached scan.js and pair.js
//           and neither fix takes effect.

//   v3.2 — modules moved OFF stale-while-revalidate (see the fetch handler).
//           Also: on activate the worker now tells live clients it took
//           over, so a deploy lands in one navigation instead of two.

const CACHE_VERSION = 'cardpricer-v3.2';

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
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();

    // Tell any page already open that a new worker took over. The page it
    // is currently running was assembled by the OLD worker, so its modules
    // are the old ones; pwa.js reloads once on this message. Without it the
    // operator must know to load twice after every deploy, which is not a
    // thing anyone should have to know.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) {
      try { c.postMessage({ type: 'sw-activated', version: CACHE_VERSION }); } catch (_) {}
    }
  })());
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

  // Application MODULES are behaviour, not assets — network-first.
  //
  // This has now caused two incidents. v2.1: the customer-PDF button did
  // nothing because clients kept a cached pre-PDF session.js. v3.1: a
  // paired phone kept a cached scan.js and pair.js, so a shipped fix to
  // both simply did not run, and the operator saw the OLD behaviour on a
  // NEW deploy — the most expensive kind of confusion, because it makes a
  // correct fix look broken.
  //
  // Bumping CACHE_VERSION was the standing remedy and it is not good
  // enough: the bump only lands after the new worker activates, which is
  // itself one navigation later, so the first load after any deploy still
  // ran stale code. Stale code is never the right answer for logic — only
  // for bytes. Offline still works via the cache fallback below.
  const isModule = url.pathname.startsWith('/modules/') && url.pathname.endsWith('.js');

  if (isModule) {
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

  // Everything else (CSS, images, fonts): stale-while-revalidate.
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
