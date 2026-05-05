// apps/server/routes/price-sealed.js
//
// Owner: A1 (route wiring) + A2 (handler) — Slice S17 + V2.0.1 (Cardmarket)
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §5 F5 (sealed product pricing)
//   - pricing/sealed/price.js (verifyAndPrice — the actual work)
//   - pricing/adapters/cardmarket-sealed.js (sole adapter for V2)
//   - apps/server/middleware/auth.js (requireAuth)
//   - apps/server/middleware/quota.js (enforceQuota)
//
// POST /api/v2/price-sealed
//   Auth: requireAuth + enforceQuota (sealed pricing counts against the
//         same scan quota as singles).
//
//   Body shapes (either accepted):
//     1. Bare SKU:  { sku: "pokemon-twm-booster-box", buyPercentage? }
//     2. Rich:      { game: "pokemon", category: "booster-box",
//                     set_code?: "TWM", set_name?: "Twilight Masquerade",
//                     name: "Twilight Masquerade Booster Box",
//                     cardmarket_url?: "https://www.cardmarket.com/...",
//                     manual_market_eur?: 132.50,
//                     language?: "en",
//                     buyPercentage? }
//
//   The rich shape is what the V2 client UI will send (when it lands —
//   apps/vendor/modules/tabs/sealed.js is a follow-up). The bare-SKU
//   shape stays for completeness + tests.
//
//   manual_market_eur (rich shape only) — operator-supplied price, e.g.
//   "I see €132.50 on Cardmarket right now". Bypasses the scrape and
//   yields confidence:0.95 (vouched). Useful when Cloudflare blocks us.
//
//   Returns: priceSealed envelope (see pricing/sealed/price.js). Includes
//     v2.sources[*].blocked_by:'cloudflare' on scrape failure — caller
//     can surface the URL for manual price check.
//
//   Errors:
//     400 — input missing required fields
//     404 — input doesn't resolve to a verified product
//     500 — adapter threw
//
//   NOTE: 503 is no longer returned. Cardmarket sealed needs no API key,
//   so the adapter is always available. (TCGPlayer Pro adapter was
//   removed in V2.0.1; the prior 503 path with TCGPLAYER_PRO_API_KEY
//   error message is gone.)
//
// MOUNT (already wired in apps/server/index.js by S17 orchestrator):
//   import priceSealedRouter from './routes/price-sealed.js';
//   app.use(priceSealedRouter);   // /api/v2/price-sealed

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { enforceQuota } from '../middleware/quota.js';
import { verifyAndPrice, isSealedVerifyAvailable } from '../../../pricing/sealed/price.js';

const router = express.Router();

router.post('/api/v2/price-sealed', requireAuth, enforceQuota, async (req, res) => {
  try {
    const body = req.body || {};
    const { sku, game, category, buyPercentage } = body;

    // Validate input — accept bare SKU OR rich object shape.
    const isBareSku   = typeof sku === 'string' && sku.trim().length > 0;
    const isRichInput = typeof game === 'string' && typeof category === 'string';
    if (!isBareSku && !isRichInput) {
      return res.status(400).json({
        error: 'invalid_input',
        message: 'Provide either { sku } or { game, category, name | set_name | cardmarket_url }.',
      });
    }

    if (!isSealedVerifyAvailable()) {
      // Defensive — Cardmarket sealed is always available, but if a future
      // refactor adds an adapter that can be turned off and ALL adapters
      // are off, surface a clear message.
      return res.status(503).json({
        error: 'sealed_pricing_unavailable',
        message: 'No sealed-pricing adapter is currently active.',
      });
    }

    const ctx = { log: req.app?.locals?.log };
    const input = isBareSku ? sku : body;  // Pass the whole rich body when not bare
    const result = await verifyAndPrice(input, ctx, { buyPercentage });

    if (!result) {
      return res.status(404).json({
        error: 'sealed_product_not_found',
        message: 'Could not resolve input to a sealed product. For rich shape: at least one of name, set_name, or cardmarket_url is required.',
      });
    }

    return res.json(result);
  } catch (e) {
    console.error('[price-sealed]', e?.message || e);
    return res.status(500).json({ error: 'sealed_pricing_failed', details: e?.message || String(e) });
  }
});

export default router;
