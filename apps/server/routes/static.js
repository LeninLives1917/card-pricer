// apps/server/routes/static.js
// Owner: A1 | Slice: S5
//
// Static + SPA fallback routes (V1 server.js:851-870, 5180-5182, 5716-5718):
//
//   GET  /service-worker.js     — no-cache headers
//   GET  /                      — no-cache, serve index.html
//   GET  /index.html            — no-cache, serve index.html
//   GET  /widget.js             — 5-min Cache-Control (V2_AUDIT §1a — must
//                                 win over the express.static defaults
//                                 below)
//   USE  express.static(public, etag:false, maxAge:0)
//   GET  /quote                 — serve public/quote.html
//   GET  *                      — SPA fallback to public/index.html
//
// IMPORTANT: this router exports two halves so apps/server/index.js can
// mount the SPA fallback ('*') AFTER every other route + middleware. If
// the wildcard is mounted with the rest of the file's routes, it eats
// every /api/* request. The mount order is enforced in index.js.

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const PUBLIC_DIR = join(REPO_ROOT, 'public');

// Mounted BEFORE express.static — each handler sets cache headers and
// then sendFile's. Mount order matters per V2_AUDIT §1a.
export const earlyStatic = express.Router();

earlyStatic.get('/service-worker.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(join(PUBLIC_DIR, 'service-worker.js'));
});

earlyStatic.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

earlyStatic.get('/widget.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(join(PUBLIC_DIR, 'widget.js'));
});

earlyStatic.get('/quote', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'quote.html'));
});

// Express's express.static; mounted via app.use(...) by index.js.
export const staticAssets = express.static(PUBLIC_DIR, { etag: false, maxAge: 0 });

// SPA fallback — MUST be mounted AFTER everything else. Used for any
// vendor-app route that wasn't matched by the API routes or static assets.
export const spaFallback = express.Router();
spaFallback.get('*', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

// Convenience default export so index.js can `import s from './routes/static.js'`
// and pull the three named pieces by `s.earlyStatic` etc.
export default { earlyStatic, staticAssets, spaFallback };
