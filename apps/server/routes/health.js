// apps/server/routes/health.js
// Owner: A1 | Slice: S5
//
// GET /api/health — public health endpoint. V1 server.js:5109-5122.
// /api/version + /api/widget/loaded land in S14 (observability) and S9
// (widget telemetry beacon) — NOT in S5 scope.

import express from 'express';

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

export default router;
