// apps/server/routes/health.js
// Owner: A1 (S5) + A8 (S14) | Slice: S14 extends with /api/version + /api/widget/loaded.
//
// GET  /api/health           — V1, public health endpoint. Preserved verbatim.
// GET  /api/version          — V2, NEW. Returns { git_sha, built_at, node_version, uptime_s, env }.
// POST /api/widget/loaded    — V2, NEW. Telemetry beacon from widget.js. 200 ack + counter.
//   Body: { shop, version, theme, position }
//   shop is validated as a slug ([a-z0-9-]{3,40}). Other fields are coerced
//   to short strings to bound metric label cardinality.

import express from 'express';
import { widget_loaded_total } from '../../../infra/observability/metrics.js';

const router = express.Router();

router.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ts: Date.now(),
    uptime: process.uptime(),
    apis: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      cardmarket: '✅ Direct links + API prices (no scraping)',
      ebay: !!(process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID),
      scryfall: true,
      pokemontcg: true
    }
  });
});

// ----- /api/version -----
router.get('/api/version', (req, res) => {
  res.json({
    git_sha: process.env.GIT_SHA || 'unknown',
    built_at: process.env.BUILT_AT || null,
    node_version: process.version,
    uptime_s: Math.round(process.uptime()),
    env: process.env.NODE_ENV || 'development',
  });
});

// ----- /api/widget/loaded -----
const SHOP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

function shortLabel(v, max = 32) {
  if (typeof v !== 'string') return 'unknown';
  const trimmed = v.trim();
  if (!trimmed) return 'unknown';
  // Restrict to safe chars + bound length so metric label cardinality is
  // contained even if a malicious caller posts garbage.
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, max);
}

router.post('/api/widget/loaded', (req, res) => {
  const body = req.body || {};
  const shopRaw = typeof body.shop === 'string' ? body.shop.toLowerCase().trim() : '';
  if (!shopRaw || !SHOP_SLUG_RE.test(shopRaw)) {
    return res.status(400).json({ error: 'invalid shop slug' });
  }
  const version = shortLabel(body.version, 16);
  const theme = shortLabel(body.theme, 16);
  const position = shortLabel(body.position, 24);

  try {
    widget_loaded_total.inc({ shop: shopRaw, version, theme });
  } catch {
    // Never let metric collection take down a request.
  }

  // Lightweight log — Render captures, Sentry doesn't.
  console.log(`[widget] loaded shop=${shopRaw} version=${version} theme=${theme} position=${position}`);

  res.status(200).json({ ok: true });
});

export default router;
