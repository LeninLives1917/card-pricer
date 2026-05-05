// apps/server/routes/static.js
// Owner: A1 | Slice: S5; Slice: S21 (extends with /customer + /o/:token);
//         V2.0.1 cutover (UI flip — vendor + quote + widget + SW now V2)
//
// Static + SPA fallback routes:
//
//   GET  /service-worker.js     — V2 SW (cardpricer-v2 cache version)
//   GET  /                      — V2 vendor shell (apps/vendor/index.html)
//   GET  /index.html            — same
//   GET  /widget.js             — V2 widget (apps/widget/widget.js), 60s
//                                 Cache-Control during the cutover window
//                                 (raise to 300s after T+2h stable per
//                                 release-runbook §post-cutover)
//   USE  /quote/  static        — apps/quote/ assets (modules/, styles/)
//   GET  /quote                 — 301 → /quote/ (so relative imports
//                                 inside the HTML resolve under /quote/)
//   GET  /quote/                — V2 quote shell (apps/quote/index.html)
//   GET  /customer              — V2 customer shell (apps/customer/index.html)
//   USE  /customer  static      — apps/customer/ assets
//   GET  /o/:token              — 302 → /customer#offer=<token>     (S21)
//   USE  /  static (vendor)     — apps/vendor/ assets (modules/, styles/);
//                                 mounted with index:false so '/' is
//                                 handled by the explicit handler above
//   USE  staticAssets           — public/ fallback (manifest, brand,
//                                 favicon, anything not in V2 trees yet)
//   GET  *                      — SPA fallback to apps/vendor/index.html
//
// Mount order matters: explicit GET handlers register before express.static
// instances inside earlyStatic so '/', '/index.html', '/widget.js',
// '/service-worker.js' all hit the no-cache wrappers and not the disk
// roots. The vendor express.static mount uses {index:false} so it doesn't
// try to serve apps/vendor/index.html for '/' (the explicit handler does).
//
// V1 BACKUP — public/index.html, public/quote.html, public/widget.js, and
// public/service-worker.js still exist on disk. The express.static(public)
// fallback below will serve any of them ONLY if a request asks for an
// explicit V1 path (e.g. '/index.html' is intercepted; '/foo.html' isn't).
// Path-collision rule: V2 routes win for paths V2 declares (above); the
// public/ fallback only catches things V2 doesn't claim (manifest, brand,
// favicon, etc.). Truly safe: V1 surfaces are never reached unless someone
// hand-types a path V2 doesn't serve, and even then they get content not
// behavior — V1's server.js is no longer the entrypoint (package.json's
// start points at apps/server/server.js).

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const PUBLIC_DIR        = join(REPO_ROOT, 'public');
const VENDOR_APP_DIR    = join(REPO_ROOT, 'apps', 'vendor');
const QUOTE_APP_DIR     = join(REPO_ROOT, 'apps', 'quote');
const WIDGET_APP_DIR    = join(REPO_ROOT, 'apps', 'widget');
const CUSTOMER_APP_DIR  = join(REPO_ROOT, 'apps', 'customer');

// Mounted BEFORE express.static — each handler sets cache headers and
// then sendFile's. Mount order matters per V2_AUDIT §1a.
export const earlyStatic = express.Router();

// V2 vendor service worker. Cache version 'cardpricer-v2' busts the V1
// 'cardpricer-v60' caches via the activate handler's filter+delete.
// skipWaiting + clients.claim are present so installed clients flip on
// next page load.
earlyStatic.get('/service-worker.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(join(VENDOR_APP_DIR, 'service-worker.js'));
});

// V2 vendor shell. No-cache because the shell (and its embedded inline
// Supabase bootstrap) needs to be revalidated on every load — the SW's
// network-first strategy backs this up.
earlyStatic.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(join(VENDOR_APP_DIR, 'index.html'));
});

// V2 widget. 60s cache during the cutover window (release-runbook §T-24h
// step 7). Restore to 300s in a follow-up commit after T+2h stable.
earlyStatic.get('/widget.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(join(WIDGET_APP_DIR, 'widget.js'));
});

// V2 quote shell. Redirect bare /quote → /quote/ so the HTML's relative
// imports (`modules/main.js`, `styles/tokens.css`) resolve against
// /quote/* and not against the parent root /. Express's default routing
// doesn't distinguish trailing slash, so we branch on req.originalUrl.
earlyStatic.get('/quote', (req, res) => {
  const url = req.originalUrl;
  // No trailing slash: redirect to /quote/, preserving querystring.
  if (url === '/quote' || url.startsWith('/quote?')) {
    const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    return res.redirect(301, '/quote/' + qs);
  }
  // Trailing slash present: serve the V2 quote shell.
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(join(QUOTE_APP_DIR, 'index.html'));
});
// /quote/ asset root — modules/, styles/. Mount path matches the URL
// prefix so relative imports inside index.html resolve correctly.
earlyStatic.use('/quote', express.static(QUOTE_APP_DIR, { etag: false, maxAge: 0 }));

// S21 — V2 customer dashboard shell. SPA whose hash routes decide what
// to render; no cache.
earlyStatic.get('/customer', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(join(CUSTOMER_APP_DIR, 'index.html'));
});

// S21 — short accept-URL convention. createOffer (S20) returns
// `/o/<token>`; redirect to /customer#offer=<token>. Hash isn't sent to
// the server so the token doesn't leak via the next request's Referer.
earlyStatic.get('/o/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).send('token required');
  res.redirect(302, '/customer#offer=' + encodeURIComponent(token));
});

// S21 — apps/customer/ asset root.
earlyStatic.use('/customer', express.static(CUSTOMER_APP_DIR, { etag: false, maxAge: 0 }));

// V2 vendor asset root — relative imports inside apps/vendor/index.html
// resolve to /styles/* and /modules/* at root. {index:false} so '/' falls
// through to the explicit shell handler above (otherwise express.static
// would auto-serve apps/vendor/index.html and bypass the no-cache header).
earlyStatic.use('/', express.static(VENDOR_APP_DIR, { etag: false, maxAge: 0, index: false }));

// V1 PUBLIC fallback — any request not claimed by a V2 route or asset
// root falls through here. Keeps shared files (manifest.json, brand/,
// favicon, /api/-pre-routing static like robots.txt if added) reachable
// during the V1→V2 transition. Drop in a post-V2 cleanup once nothing
// V1 is referenced.
export const staticAssets = express.static(PUBLIC_DIR, { etag: false, maxAge: 0 });

// SPA fallback — for vendor-app deep links (any path not matched above).
// Now points at the V2 vendor shell. MUST mount last; otherwise it eats
// /api/* requests.
export const spaFallback = express.Router();
spaFallback.get('*', (req, res) => {
  res.sendFile(join(VENDOR_APP_DIR, 'index.html'));
});

export default { earlyStatic, staticAssets, spaFallback };
